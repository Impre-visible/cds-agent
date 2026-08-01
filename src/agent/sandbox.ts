import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import type { AgentResult } from "./runner.ts";
import { createBoundedOutput } from "./bounded-output.ts";
import { startInferenceProxy } from "../tools/proxy.ts";
import { log } from "../log.ts";

export interface SandboxResult {
  ok: boolean;
  /** Code de sortie réel du conteneur (null si le processus n'a jamais pu se terminer proprement). */
  code: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Nom du conteneur actuellement en cours d'exécution, s'il y en a un. Un
 * seul worker tourne à la fois (TaskQueue est strictement séquentiel, voir
 * queue.ts), donc un simple slot suffit — pas besoin d'une vraie
 * comptabilité multi-ressources. Sert uniquement au nettoyage best-effort à
 * l'arrêt forcé du daemon (voir index.ts) : si le délai de grâce expire
 * pendant qu'un conteneur tourne encore, on peut le cibler par son nom
 * plutôt que d'abandonner en le laissant tourner indéfiniment.
 */
let activeContainer: string | undefined;

export function currentContainer(): string | undefined {
  return activeContainer;
}

/** Best-effort : ignore toute erreur (docker absent, conteneur déjà parti...). */
export function killContainer(
  name: string,
  dockerBin = "docker",
): Promise<void> {
  return new Promise((resolve) => {
    execFile(dockerBin, ["kill", name], () => resolve());
  });
}

/**
 * Chantier "projects.json" : l'image Docker par dépôt vit désormais dans
 * `docker.image` (defaults + par dépôt, voir src/projects.ts::resolveProject,
 * qui applique déjà le repli sur config.dockerDefaultImage). Cette fonction
 * ne fait donc plus qu'un passthrough — gardée nommée et exportée pour que ce
 * fichier reste le point où se lit "quelle image pour ce dépôt ?" (voir
 * agent/workspace.ts::runCommand, seul appelant).
 */
export function imageFor(docker: { image: string }): string {
  return docker.image;
}

export interface SandboxOptions {
  network?: boolean;
  hostGateway?: boolean;
  env?: Record<string, string>;
  mounts?: { host: string; container: string }[];
  /** Dérogation à config.commandTimeoutMs (voir runAgentInSandbox). */
  timeoutMs?: number;
  /** Nom du binaire docker à invoquer ; injectable pour les tests (faux docker). */
  dockerBin?: string;
  /**
   * Valeur passée à `docker run --user` (format "uid:gid"). Par défaut,
   * l'uid/gid réels du process hôte (voir hostUser()) ; injectable pour les
   * tests, où l'uid réel du runner n'a aucune importance pour ce qui est
   * vérifié. `undefined` omet complètement --user (cas des plateformes sans
   * uid POSIX, ex. Windows).
   */
  user?: string;
}

/**
 * uid:gid du process hôte qui lance le daemon, au format attendu par
 * `docker run --user` (§4.3). Les deux Dockerfiles (docker/agent.Dockerfile
 * et docker/node22.Dockerfile) documentent le même modèle d'exécution :
 * le conteneur tourne sous l'uid de l'hôte, pas sous l'uid baked-in de
 * l'image (root pour l'un, uid 1001 pour l'autre — deux valeurs différentes
 * et de toute façon non pertinentes une fois --user passé, qui les écrase
 * toutes les deux). Sans ce --user, le conteneur agent tournait en root
 * (agent.Dockerfile n'a pas de USER) et écrivait des fichiers root dans le
 * dépôt monté depuis le /tmp de l'hôte : le rmSync best-effort de
 * dispose() (voir workspace.ts) échoue alors en EPERM sur Linux, et les
 * workspaces s'accumulent au lieu d'être nettoyés.
 *
 * `undefined` si le process n'a pas d'uid POSIX (Windows) : --user est
 * alors simplement omis, comme avant ce correctif — dégradation
 * silencieuse mais sans régression, ce cas n'étant de toute façon pas un
 * environnement de déploiement visé ici.
 */
export function hostUser(): string | undefined {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return undefined;
  return `${uid}:${gid}`;
}

/**
 * Construction pure des arguments `docker run`. Extraite de runInSandbox pour
 * être testable sans docker : on peut vérifier la présence de --name, du bon
 * réseau, des montages, des variables d'environnement... par simple
 * inspection du tableau retourné.
 */
export function buildDockerRunArgs(
  repo: string,
  image: string,
  command: string,
  containerName: string,
  options: SandboxOptions = {},
): string[] {
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    options.network ? "bridge" : "none",
    "--memory",
    config.dockerMemory,
    "--cpus",
    config.dockerCpus,
    "--pids-limit",
    String(config.dockerPidsLimit),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    // Pas de --security-opt seccomp ici, volontairement : Docker attend
    // après "seccomp=" un CHEMIN vers un fichier de profil, ou le littéral
    // "unconfined". Il n'existe pas de mot-clé "default" — le passer fait
    // échouer `docker run` en code 125 ("opening seccomp profile (default)
    // failed"), avant même que le conteneur démarre. Le profil par défaut
    // s'obtient précisément en ne passant rien, ce qui est le cas ici.
    // Système de fichiers racine en lecture seule (§4.4) : seuls /repo (le
    // dépôt monté, ci-dessous) et /tmp (tmpfs, ci-dessous) restent
    // inscriptibles. Couvre le besoin réel (écrire dans le dépôt, cache
    // npm, fichiers temporaires de tests) sans laisser un process écrire
    // n'importe où ailleurs dans l'image.
    "--read-only",
    // rw : l'agent (cache npm, config XDG sous /tmp/agent — voir
    // agent.Dockerfile) et les tests (fichiers temporaires) doivent pouvoir
    // y écrire. exec : certains outils déposent et exécutent des scripts
    // temporaires (post-install, harnais de test) ; désactiver l'exécution
    // casserait des usages légitimes qu'on ne peut pas énumérer à l'avance
    // pour un dépôt arbitraire — arbitrage documenté ici plutôt qu'un
    // durcissement qui serait désactivé au premier `npm install` cassé.
    // size= borne ce qu'un conteneur peut y écrire (§4.4 : rien n'empêchait
    // jusqu'ici de remplir le tmpfs, contrairement au bind mount /repo dont
    // la taille n'est elle-même pas plafonnable par un flag docker run —
    // limite connue, voir le rapport de la tâche.
    "--tmpfs",
    `/tmp:rw,exec,size=${config.dockerTmpfsSize},mode=1777`,
    // Plancher confortable pour npm/git/opencode (beaucoup de descripteurs
    // ouverts en parallèle lors d'un install ou d'une suite de tests), tout
    // en bornant un process qui en ouvrirait sans limite.
    "--ulimit",
    `nofile=${config.dockerUlimitNofile}`,
    "-v",
    `${repo}:/repo`,
    "-w",
    "/repo",
    "-e",
    "CI=1",
    "-e",
    "FORCE_COLOR=0",
    // --user <uid de l'hôte> (plus bas) désigne un utilisateur qui n'existe
    // dans aucune image : Docker ne trouve alors pas d'entrée /etc/passwd et
    // pose HOME=/ — vérifié, pas déduit. Combiné à --read-only, tout outil qui
    // écrit son cache sous HOME échoue : `npm install` tente mkdir /.npm et
    // s'arrête sur ENOENT, avant même que l'agent n'ait été lancé. C'est ce
    // qui a bloqué toute une campagne de mesure au 1er août 2026, avec un
    // message ("mkdir '/.npm'") qui ne désigne ni --user ni --read-only.
    //
    // La compensation appartient ICI, pas aux images : c'est cette fonction
    // qui injecte --user, et projects.json accepte n'importe quelle image
    // (projects.example.json donne "node:22-bookworm-slim" en défaut — une
    // image amont, qui n'aura jamais les conventions de ce projet). Les deux
    // Dockerfiles maison posent déjà exactement ces valeurs : ces -e y sont
    // donc sans effet, et ne servent qu'à garantir la même convention quelle
    // que soit l'image déclarée.
    //
    // Ces répertoires n'existent pas dans le tmpfs monté sur /tmp et ne sont
    // pas précréés : /tmp est en mode 1777, chaque outil y crée les siens à la
    // volée (vérifié avec npm sur une image amont, HOME absent inclus).
    "-e",
    "HOME=/tmp/agent",
    "-e",
    "XDG_CONFIG_HOME=/tmp/agent/.config",
    "-e",
    "XDG_DATA_HOME=/tmp/agent/.local/share",
    "-e",
    "XDG_CACHE_HOME=/tmp/agent/.cache",
    "-e",
    "npm_config_cache=/tmp/.npm",
  ];

  const user = options.user ?? hostUser();
  if (user) args.push("--user", user);

  for (const mount of options.mounts ?? []) {
    args.push("-v", `${mount.host}:${mount.container}:ro`);
  }

  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }

  if (options.hostGateway) {
    // Nécessaire sur Linux ; sans effet sur Docker Desktop où l'alias existe déjà.
    args.push("--add-host", "host.docker.internal:host-gateway");
  }

  args.push(image, "bash", "-c", command);

  return args;
}

export function runInSandbox(
  repo: string,
  image: string,
  command: string,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const dockerBin = options.dockerBin ?? "docker";
    // Nom unique : plusieurs conteneurs peuvent coexister (review et
    // implement en parallèle, retries...) et il faut pouvoir cibler CE
    // conteneur précis au moment du kill, sans toucher aux autres.
    const containerName = `cds-${randomUUID()}`;
    activeContainer = containerName;
    const args = buildDockerRunArgs(repo, image, command, containerName, options);

    log.info(
      `[docker ${options.network ? "réseau" : "isolé"} ${containerName}] ${command.slice(0, 80)}`,
    );
    const child = spawn(dockerBin, args, { stdio: ["ignore", "pipe", "pipe"] });

    // Bornée (§4.8) : une sortie bavarde ou une boucle qui spamme stdout ne
    // doit pas faire grossir cette chaîne sans limite jusqu'à l'OOM du
    // daemon (voir bounded-output.ts pour la justification du choix de
    // tronquer le début plutôt que la fin).
    const boundedOutput = createBoundedOutput();
    let timedOut = false;
    let killGrace: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(
      () => {
        timedOut = true;
        // `child` est le client `docker run`, pas le conteneur : le tuer ne
        // déclenche pas --rm et laisse le conteneur tourner (mémoire/CPU
        // réservées, montage du workspace tenu). On cible donc le conteneur
        // lui-même par son nom unique via `docker kill` ; le client constate
        // l'arrêt du conteneur et se termine de lui-même juste après, ce qui
        // laisse --rm s'appliquer normalement.
        execFile(dockerBin, ["kill", containerName], () => {
          // Échec ignoré : conteneur déjà terminé entre-temps, ou docker
          // indisponible — le filet de sécurité ci-dessous couvre ce dernier cas.
        });
        // Filet de sécurité : si le client ne se termine pas de lui-même peu
        // après (démon docker qui traîne, kill sans effet...), on ne veut pas
        // bloquer indéfiniment sur ce process. Le conteneur peut alors
        // survivre — dégradation acceptable, imputable à docker et non à ce code.
        killGrace = setTimeout(() => child.kill("SIGKILL"), 5_000);
      },
      options.timeoutMs ?? config.commandTimeoutMs,
    );
    const capture = (chunk: Buffer) => {
      boundedOutput.append(chunk);
      process.stdout.write(chunk);
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killGrace);
      if (activeContainer === containerName) activeContainer = undefined;
      resolve({
        ok: false,
        code: null,
        output: `docker introuvable : ${error.message}`,
        timedOut: false,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killGrace);
      if (activeContainer === containerName) activeContainer = undefined;
      resolve({ ok: code === 0, code, output: boundedOutput.value(), timedOut });
    });
  });
}

/**
 * `--add-host host.docker.internal:host-gateway` (§1.7) n'a d'utilité que
 * si l'agent doit effectivement joindre l'hôte sous ce nom : le proxy
 * d'inférence local démarré ci-dessous par défaut, ou une valeur explicite
 * de CONTAINER_INFERENCE_URL qui pointerait volontairement dessus. Si
 * l'inférence est configurée vers une adresse extérieure (une vraie API
 * HTTPS, par exemple), accorder cet alias en plus n'apporte rien et
 * élargit la surface exposée au conteneur pour aucun bénéfice.
 */
function needsHostGateway(url: string): boolean {
  try {
    return new URL(url).hostname === "host.docker.internal";
  } catch {
    return false;
  }
}

/**
 * Clé d'API écrite dans la configuration opencode DU CONTENEUR — à ne pas
 * confondre avec config.inferenceApiKey, qui est la vraie.
 *
 * Chemin normal (proxy filtrant) : un placeholder inerte. La vraie clé reste
 * sur l'hôte, où le proxy la pose lui-même en en-tête Authorization (voir
 * tools/proxy.ts) ; l'agent, lui, exécute du code écrit par un LLM et peut
 * relire sa propre configuration — lui confier un secret utilisable contre un
 * fournisseur facturé n'aurait aucune contrepartie. Le placeholder n'est pas
 * gratuit pour autant : le SDK openai-compatible refuse une clé vide, et LM
 * Studio ignore sa valeur.
 *
 * Chemin dérogatoire (CONTAINER_INFERENCE_URL) : plus de proxy dans la
 * boucle, donc plus personne pour authentifier la requête. La vraie clé doit
 * descendre dans le conteneur, sans quoi un upstream distant répondrait 401.
 * C'est le prix explicite de cette échappatoire — une raison de plus de la
 * réserver à une inférence locale, comme le dit déjà .env.example.
 */
function containerApiKey(): string {
  if (!config.inferenceUrl) return "lm-studio";
  return config.inferenceApiKey ?? "lm-studio";
}

export async function runAgentInSandbox(
  repo: string,
  meta: string,
  _projectPath: string,
  options: {
    /** Uniquement pour l'injection d'un faux docker en test (voir sandbox.test.ts). */
    dockerBin?: string;
    /**
     * Dérogation à config.agentTimeoutMs (repli si absent, comportement
     * historique inchangé). Chantier "planificateur" : tasks/planner.ts passe
     * config.plannerTimeoutMs, un budget distinct et plus court que celui de
     * l'agent exécutant — voir le commentaire équivalent sur runAgent()
     * (agent/runner.ts).
     */
    timeoutMs?: number;
  } = {},
): Promise<AgentResult> {
  const started = Date.now();

  // §1.7 : par défaut (config.inferenceUrl absente), le conteneur ne
  // connaît que l'adresse d'un proxy filtrant démarré ici pour la durée de
  // cette exécution, qui relaie exclusivement vers
  // config.inferenceUpstreamUrl — jamais une route ouverte vers
  // host.docker.internal, qui donnerait accès à tous les ports de l'hôte et
  // pas seulement à celui de l'inférence. Voir tools/proxy.ts pour les
  // limites assumées de cette restriction (elle ne couvre que le trafic
  // d'inférence, pas d'éventuels appels réseau directs par les outils shell
  // de l'agent).
  const proxy = config.inferenceUrl
    ? undefined
    : await startInferenceProxy({
        upstreamUrl: config.inferenceUpstreamUrl,
        // INFERENCE_API_KEY est confiée au proxy, pas au conteneur : c'est lui
        // qui pose l'en-tête Authorization en relayant (voir tools/proxy.ts).
        apiKey: config.inferenceApiKey,
      });

  try {
    // config.inferenceUrl reste une échappatoire explicite (voir config.ts) :
    // si renseignée, elle court-circuite le proxy et redonne l'ancien
    // comportement (accès direct à l'adresse indiquée).
    const modelBaseUrl = config.inferenceUrl ?? proxy?.containerUrl;
    if (!modelBaseUrl) {
      // Ne devrait jamais arriver : proxy est toujours défini quand
      // config.inferenceUrl est absente (branche ci-dessus).
      throw new Error("proxy d'inférence introuvable");
    }

    // Le format "fournisseur/modèle" d'AGENT_MODEL est validé au démarrage
    // par config.ts (validateAgentModel) : ni le fournisseur ni le modèle ne
    // peuvent être vides ici. Découpage au PREMIER "/" seulement — un
    // identifiant de modèle distant peut lui-même en contenir
    // (ex. "scaleway/mistral/nemo-instruct"), et un split("/")[1] tronquerait
    // silencieusement le reste.
    const slash = config.agentModel.indexOf("/");
    const providerId = config.agentModel.slice(0, slash);
    const modelId = config.agentModel.slice(slash + 1);

    // La clé du bloc `provider` doit être exactement le fournisseur passé à
    // `opencode run --model <fournisseur>/<modèle>`, sinon opencode cherche un
    // fournisseur qu'on ne lui a jamais décrit. Elle suit donc AGENT_MODEL au
    // lieu d'être figée sur "lmstudio" : c'est ce qui permet de viser un
    // fournisseur distant (AGENT_MODEL=scaleway/... + INFERENCE_UPSTREAM_URL +
    // INFERENCE_API_KEY) sans devoir mentir sur son nom.
    const opencodeConfig = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: providerId,
          options: { baseURL: modelBaseUrl, apiKey: containerApiKey() },
          // `limit` explicite : sans lui, opencode réclame 32 000 tokens de
          // sortie par défaut sur un fournisseur custom (opencode#1735), ce
          // qui fait refuser la requête par tout modèle dont le plafond est
          // plus bas — trois candidats éliminés pour cette seule raison lors
          // de la campagne du 1er août 2026 (voir config.ts).
          models: {
            [modelId]: {
              name: "agent",
              limit: {
                context: config.inferenceContextLimit,
                output: config.inferenceOutputLimit,
              },
            },
          },
        },
      },
    });

    const result = await runInSandbox(
      repo,
      config.agentImage,
      `opencode run --model ${config.agentModel} "$(cat /task/prompt.txt)"`,
      {
        network: true,
        hostGateway: needsHostGateway(modelBaseUrl),
        mounts: [{ host: meta, container: "/task" }],
        env: { OPENCODE_CONFIG_CONTENT: opencodeConfig },
        // L'agent a son propre budget (AGENT_TIMEOUT_MINUTES, 10 min par
        // défaut), distinct du timeout générique des commandes courtes
        // (COMMAND_TIMEOUT_MINUTES, 5 min, pensé pour install/tests). Sans ce
        // paramètre explicite, c'est ce dernier qui s'appliquait ici et
        // AGENT_TIMEOUT_MINUTES n'avait aucun effet en mode Docker.
        // options.timeoutMs : dérogation explicite (voir plus haut) — c'est
        // ce que passe tasks/planner.ts pour son propre budget, plus court.
        timeoutMs: options.timeoutMs ?? config.agentTimeoutMs,
        dockerBin: options.dockerBin,
      },
    );

    return {
      code: result.code,
      stdout: result.output,
      stderr: "",
      timedOut: result.timedOut,
      durationMs: Date.now() - started,
    };
  } finally {
    await proxy?.close();
  }
}
