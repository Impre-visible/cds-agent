import { existsSync, readFileSync } from "node:fs";

function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name} — voir .env`);
  }
  return value;
}

/**
 * Chantier "projects.json" : sept variables d'environnement ont migré vers ce
 * fichier versionné (voir src/projects.ts) — la liste des dépôts/auteurs
 * autorisés, les capacités de l'agent, les commandes et l'image Docker par
 * dépôt, les répertoires de test maison. Un .env hérité qui en garderait une
 * ferait courir exactement le risque que ce chantier corrige ailleurs
 * (USE_DOCKER=0, voir resolveUseDocker plus bas) : un réglage périmé qui
 * n'autorise plus rien en silence, ou pire, qu'on croit encore actif. On
 * refuse donc de démarrer tant que l'une d'elles traîne encore dans
 * l'environnement, avec un message qui dit explicitement où le réglage a
 * migré — jamais un simple avertissement ignorable.
 */
const LEGACY_ENV_MIGRATIONS: Record<string, string> = {
  ALLOWED_PROJECTS:
    'la liste des dépôts autorisés est désormais la clé "projects" de projects.json — un dépôt qui n\'y figure pas est refusé, exactement comme une liste ALLOWED_PROJECTS vide auparavant.',
  ALLOWED_USERS:
    'les auteurs autorisés sont désormais "projects.<dépôt>.users" dans projects.json, dépôt par dépôt (il n\'y a plus de liste globale unique).',
  AGENT_CAPABILITIES:
    'les capacités de l\'agent sont désormais "capabilities" (issue/mergeRequest, dans "defaults" et par dépôt) dans projects.json — voir tasks/guard.ts et projects.example.json.',
  DOCKER_IMAGES:
    'l\'image Docker par dépôt est désormais "docker.image" (dans "defaults" et par dépôt) dans projects.json.',
  TEST_COMMANDS:
    'la commande de test par dépôt est désormais "commands.test" (dans "defaults" et par dépôt) dans projects.json.',
  INSTALL_COMMANDS:
    'la commande d\'installation par dépôt est désormais "commands.install" (dans "defaults" et par dépôt) dans projects.json.',
  TEST_DIRECTORY_OVERRIDES:
    'les répertoires de test maison par dépôt sont désormais "testDirectories" (dans "defaults" et par dépôt) dans projects.json.',
};

/** Voir LEGACY_ENV_MIGRATIONS ci-dessus. Appelée en tout premier dans buildConfig(). */
function assertNoLegacyEnvVars(env: NodeJS.ProcessEnv): void {
  for (const [name, migration] of Object.entries(LEGACY_ENV_MIGRATIONS)) {
    if (name in env) {
      throw new Error(
        `Variable d'environnement périmée : ${name} n'est plus lue par le daemon — ${migration} ` +
          `Retirez ${name} de .env (voir projects.example.json et le README, section Configuration des projets).`,
      );
    }
  }
}

interface NumberBounds {
  min?: number;
  max?: number;
}

/**
 * Lit une variable d'environnement numérique en s'assurant qu'elle est un
 * nombre fini et qu'elle respecte les bornes attendues, plutôt que de laisser
 * passer une valeur absurde. `Number("30s")` vaut `NaN`, et
 * `setTimeout(fn, NaN)` se comporte comme `setTimeout(fn, 0)` : sans ce
 * garde-fou, une simple faute de frappe sur POLL_INTERVAL_MS transforme
 * l'intervalle de polling en boucle serrée qui martèle l'API GitLab avec le
 * PAT — bannissement quasi garanti. Une valeur négative ou nulle est tout
 * aussi dangereuse (ex. MAX_ATTEMPTS=0 désactiverait silencieusement les
 * réessais), d'où les bornes. On échoue donc bruyamment au démarrage, en
 * nommant la variable fautive et la valeur lue — même ton que required().
 * Une variable absente ou vide retombe sur le défaut, comme required().
 */
function finiteNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  bounds: NumberBounds = {},
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(
      `Variable d'environnement invalide : ${name}="${raw}" n'est pas un nombre — voir .env`,
    );
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new Error(
      `Variable d'environnement invalide : ${name}=${raw} est inférieur au minimum autorisé (${bounds.min}) — voir .env`,
    );
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new Error(
      `Variable d'environnement invalide : ${name}=${raw} dépasse le maximum autorisé (${bounds.max}) — voir .env`,
    );
  }
  return value;
}

/**
 * Sécurité par défaut : sandbox Docker activée sauf opt-in explicite.
 * Auparavant, l'absence de USE_DOCKER dans l'environnement faisait tourner
 * l'agent — du code écrit par un LLM — directement sur l'hôte, avec le
 * profil de login de l'utilisateur (voir runCommand() dans
 * agent/workspace.ts) : un défaut non sûr finit toujours par tourner
 * quelque part. On inverse donc la polarité : il faut désormais un opt-in
 * bruyant (ALLOW_UNSANDBOXED=1) pour désactiver la sandbox.
 *
 * USE_DOCKER=1 reste accepté tel quel (rien ne change pour le .env actuel
 * du projet). USE_DOCKER=0, en revanche, n'est plus un mécanisme d'opt-out
 * à lui seul : avant ce changement il suffisait à désactiver la sandbox
 * (c'était même le défaut), et le laisser continuer à le faire
 * silencieusement referait exactement le trou qu'on comble ici pour
 * quiconque a ce réglage dans un .env existant. On échoue donc bruyamment
 * pour forcer une décision consciente : soit ajouter ALLOW_UNSANDBOXED=1
 * (et accepter l'avertissement affiché au démarrage), soit retirer
 * USE_DOCKER=0 pour retomber sur la sandbox.
 */
function resolveUseDocker(env: NodeJS.ProcessEnv): boolean {
  const allowUnsandboxed = env.ALLOW_UNSANDBOXED === "1";
  if (env.USE_DOCKER === "0" && !allowUnsandboxed) {
    throw new Error(
      'USE_DOCKER=0 ne suffit plus à désactiver la sandbox Docker (défaut désormais sûr) : ' +
        "positionnez ALLOW_UNSANDBOXED=1 pour confirmer explicitement le mode hôte non " +
        "sandboxé, ou retirez USE_DOCKER=0 pour rester en sandbox — voir .env",
    );
  }
  if (allowUnsandboxed) {
    console.warn(
      "⚠ ALLOW_UNSANDBOXED=1 : les commandes de l'agent (y compris du code potentiellement " +
        "écrit par le LLM) s'exécutent directement sur l'hôte, sans isolation Docker. " +
        "À réserver au développement local.",
    );
    return false;
  }
  return true;
}

/**
 * sandbox.ts construit la clé de modèle opencode via
 * config.agentModel.split("/")[1] (voir agent/sandbox.ts) : un identifiant
 * sans "/" (ou avec une partie vide de part et d'autre) produit une clé de
 * modèle vide, échec silencieux à des couches de distance de cette
 * validation — une requête d'inférence qui échoue bien plus tard avec un
 * message sans rapport avec la vraie cause. On vérifie donc ici le format
 * attendu "fournisseur/modèle" dès le démarrage.
 */
function validateAgentModel(env: NodeJS.ProcessEnv, fallback: string): string {
  const raw = env.AGENT_MODEL;
  if (raw === undefined || raw === "") return fallback;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    throw new Error(
      `Variable d'environnement invalide : AGENT_MODEL="${raw}" doit être au format ` +
        `"fournisseur/modèle" (ex. "lmstudio/qwen2.5-coder-7b-instruct-mlx") — voir .env`,
    );
  }
  return raw;
}

/**
 * Validation de forme légère pour les valeurs passées telles quelles à
 * `docker run` (mémoire, CPU) : pas de plage numérique pertinente ici, mais
 * une faute de frappe produirait sinon une commande Docker qui échoue de
 * façon opaque bien plus tard, loin du réglage fautif.
 */
function matchingFormat(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
  pattern: RegExp,
): string {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!pattern.test(raw)) {
    throw new Error(
      `Variable d'environnement invalide : ${name}="${raw}" ne respecte pas le format attendu (${pattern}) — voir .env`,
    );
  }
  return raw;
}

/**
 * Construit la configuration à partir d'un environnement donné. Fonction
 * pure exportée séparément de `config` afin d'être testable en isolation
 * (sans dépendre de process.env ni du cache des modules ESM) : voir
 * config.test.ts.
 */
export function buildConfig(env: NodeJS.ProcessEnv) {
  // Chantier "projects.json" : en tout premier, avant toute autre lecture —
  // voir LEGACY_ENV_MIGRATIONS ci-dessus.
  assertNoLegacyEnvVars(env);

  return {
    gitlabUrl: (env.GITLAB_URL ?? "https://gitlab.com").replace(/\/+$/, ""),
    token: required(env, "GITLAB_TOKEN"),
    botUsername: required(env, "BOT_USERNAME"),
    // Plancher à 1 s : en dessous, on martèle l'API GitLab. Plafond à 1 h :
    // au-delà, autant dire que le polling ne sert plus à rien.
    pollIntervalMs: finiteNumber(env, "POLL_INTERVAL_MS", 30_000, {
      min: 1_000,
      max: 3_600_000,
    }),
    stateFile: env.STATE_FILE ?? "./state/processed.jsonl",
    skipMarkDone: env.SKIP_MARK_DONE === "1",
    /**
     * Chantier "projects.json" : chemin du fichier de configuration par
     * projet (voir src/projects.ts) — remplace ALLOWED_PROJECTS/
     * ALLOWED_USERS/AGENT_CAPABILITIES/DOCKER_IMAGES/TEST_COMMANDS/
     * INSTALL_COMMANDS/TEST_DIRECTORY_OVERRIDES. Chargé et validé par
     * daemon/index.ts au démarrage (fatal si absent/invalide) et rechargé à
     * chaud à chaque cycle de polling — voir ProjectsRegistry.
     */
    projectsFile: env.PROJECTS_FILE ?? "./projects.json",
    // Exprimé en minutes côté env : borné à [1, 1440] (une journée) avant
    // conversion en ms.
    lookbackMs:
      finiteNumber(env, "LOOKBACK_MINUTES", 10, { min: 1, max: 1_440 }) *
      60_000,
    agentModel: validateAgentModel(
      env,
      "lmstudio/qwen2.5-coder-7b-instruct-mlx",
    ),
    // Exprimé en minutes côté env : un timeout de 0 laisserait l'agent
    // tourner indéfiniment (voir agent/runner.ts) ; 4 h de plafond couvre
    // largement une tâche locale raisonnable.
    agentTimeoutMs:
      finiteNumber(env, "AGENT_TIMEOUT_MINUTES", 10, { min: 1, max: 240 }) *
      60_000,
    /**
     * Chantier "planificateur" : budget de temps du premier appel au modèle
     * (tasks/planner.ts::runPlanner), distinct d'agentTimeoutMs ci-dessus —
     * ce n'est pas le même travail. L'agent exécutant clone un dépôt,
     * installe des dépendances, écrit du code et fait tourner une suite de
     * tests (10 min de défaut) ; le planificateur travaille certes dans un
     * clone du même dépôt (voir tasks/planner.ts::runPlanner), mais ne fait
     * que lire la charte et le contexte de la demande pour rédiger un petit
     * plan JSON — il ne modifie jamais ce clone. Un plafond aussi
     * généreux qu'agentTimeoutMs pour cette tâche bien plus légère
     * retarderait inutilement chaque demande dont l'intention n'est pas déjà
     * tranchée par une commande explicite ou le repli par mots-clés (voir
     * tasks/router.ts::resolveIntent — le planificateur n'est appelé que pour
     * ces demandes-là, jamais pour les autres). 3 min de défaut : large pour
     * un aller-retour de quelques centaines de tokens sur un modèle local.
     */
    plannerTimeoutMs:
      finiteNumber(env, "PLANNER_TIMEOUT_MINUTES", 3, { min: 1, max: 60 }) *
      60_000,
    // maxRemarks=0 viderait silencieusement toute review (slice(0, 0)).
    maxRemarks: finiteNumber(env, "MAX_REMARKS", 5, { min: 1, max: 50 }),
    /**
     * Nombre de passes de revue sur le même diff, dont on ne garde que les
     * remarques apparues dans une MAJORITÉ (voir tasks/review.ts::voteRemarks).
     *
     * Défaut 1 : comportement strictement inchangé, une passe et tout ce
     * qu'elle rend. Au-delà, c'est la seule réponse structurelle qu'on ait au
     * non-déterminisme mesuré le 1er août 2026 — deux runs de
     * qwen3-235b-a22b, même prompt, six secondes d'écart : 5 remarques dont
     * le bug #2 pour l'un, 1 remarque pour l'autre. Ce n'est pas un défaut
     * des petits modèles qui disparaîtrait en montant en taille : c'est
     * mesuré à 235 milliards de paramètres.
     *
     * Ce que ça achète : un faux positif non reproductible ne survit pas au
     * vote. Ce que ça coûte : N fois le temps et les tokens, linéairement —
     * d'où le défaut à 1 plutôt qu'un compromis imposé à tout le monde.
     * Plafond à 7 : au-delà, le coût devient absurde bien avant que le vote
     * ne gagne quoi que ce soit.
     */
    reviewPasses: finiteNumber(env, "REVIEW_PASSES", 1, { min: 1, max: 7 }),
    gitAuthorName: env.GIT_AUTHOR_NAME ?? "cds-agent",
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL ?? "cds-agent@local.invalid",
    /**
     * Défauts GLOBAUX (n'ont pas migré vers projects.json, à la différence
     * des variantes par-dépôt TEST_COMMANDS/INSTALL_COMMANDS/DOCKER_IMAGES) :
     * repli ultime quand ni "projects.<chemin>" ni le bloc "defaults" du
     * fichier ne précisent une commande ou une image — voir
     * projects.ts::ProjectsBaseline, injecté par daemon/index.ts au moment
     * de résoudre chaque dépôt (`projectsRegistry.resolve(path, { commands:
     * {install: config.installCommand, test: config.testCommand}, docker:
     * {image: config.dockerDefaultImage} })`).
     */
    testCommand: env.TEST_COMMAND ?? "npm test",
    installCommand: env.INSTALL_COMMAND ?? "npm install",
    /**
     * §1.6 : par défaut, l'installation se fait avec les scripts du dépôt
     * cible désactivés (`--ignore-scripts` ajouté par implement.ts). Sans ce
     * réglage, un `postinstall` du dépôt cible s'exécute avec un accès
     * réseau complet (network: true), avant que quoi que ce soit n'ait été
     * vérifié dans ce qu'a produit l'agent — structurel (il faut bien
     * installer), mais on ne l'accepte plus par défaut. Compromis assumé :
     * certains dépôts ne s'installent pas correctement sans leurs scripts
     * (génération de fichiers, binaires natifs...) ; INSTALL_IGNORE_SCRIPTS=0
     * retombe sur le comportement précédent pour ceux-là, au cas par cas.
     */
    installIgnoreScripts: env.INSTALL_IGNORE_SCRIPTS !== "0",
    /**
     * §4.7 : profondeur de clone par défaut. Sans elle, chaque review et
     * chaque implémentation reclone tout l'historique du dépôt — plusieurs
     * minutes et des centaines de Mo sur un dépôt d'entreprise, pour un usage
     * qui n'a besoin que de l'état courant de la branche. 0 désactive la
     * limite (clone complet, comportement précédent) : utile si un dépôt
     * particulier a besoin de tout son historique. Une valeur trop petite
     * n'est pas dangereuse — voir checkHeadIntegrity/safeMergeBase dans
     * implement.ts, qui approfondit à la demande (`fetch --unshallow`)
     * quand `merge-base` échoue faute d'ancêtre commun connu localement.
     */
    cloneDepth: finiteNumber(env, "CLONE_DEPTH", 20, { min: 0 }),
    // Exprimé en minutes côté env, même logique que agentTimeoutMs.
    commandTimeoutMs:
      finiteNumber(env, "COMMAND_TIMEOUT_MINUTES", 5, { min: 1, max: 60 }) *
      60_000,
    fakeAgentScript: env.FAKE_AGENT_SCRIPT ?? "",
    useDocker: resolveUseDocker(env),
    // Défaut global (voir le commentaire sur testCommand/installCommand plus
    // haut) : repli quand ni le dépôt ni le bloc "defaults" de projects.json
    // ne précisent d'image — remplace DOCKER_DEFAULT_IMAGE + DOCKER_IMAGES,
    // ce dernier ayant entièrement migré vers "docker.image" par projet.
    dockerDefaultImage: env.DOCKER_DEFAULT_IMAGE ?? "node:22-bookworm-slim",
    // Format docker --memory : un nombre suivi d'une unité optionnelle
    // (b/k/m/g).
    dockerMemory: matchingFormat(env, "DOCKER_MEMORY", "4g", /^\d+(\.\d+)?[bkmg]?$/i),
    // Format docker --cpus : un nombre entier ou décimal.
    dockerCpus: matchingFormat(env, "DOCKER_CPUS", "4", /^\d+(\.\d+)?$/),
    /**
     * §5.8 : passé tel quel à `docker run --pids-limit` (agent/sandbox.ts).
     * Même famille de réglage que DOCKER_MEMORY/DOCKER_CPUS ci-dessus (une
     * ressource dont la bonne valeur dépend de l'hôte et du dépôt cible, pas
     * un choix de conception figé) : un install ou une suite de tests qui
     * lance beaucoup de processus en parallèle (workers de test, watchers...)
     * peut légitimement avoir besoin de plus que le défaut. Bornes larges
     * (au minimum de quoi laisser tourner un test runner ordinaire, au
     * maximum de quoi rester une vraie limite et pas un no-op).
     */
    dockerPidsLimit: finiteNumber(env, "DOCKER_PIDS_LIMIT", 512, {
      min: 16,
      max: 16_384,
    }),
    // Format docker --ulimit nofile=soft:hard.
    dockerUlimitNofile: matchingFormat(
      env,
      "DOCKER_ULIMIT_NOFILE",
      "4096:8192",
      /^\d+:\d+$/,
    ),
    // Même format que DOCKER_MEMORY (taille du tmpfs monté sur /tmp, voir
    // agent/sandbox.ts) : nombre suivi d'une unité optionnelle (b/k/m/g).
    dockerTmpfsSize: matchingFormat(
      env,
      "DOCKER_TMPFS_SIZE",
      "1g",
      /^\d+(\.\d+)?[bkmg]?$/i,
    ),
    agentImage: env.AGENT_IMAGE ?? "cds-agent/agent-node22",
    /**
     * Serveur d'inférence réel, vu depuis l'HÔTE (§1.7) — pas depuis un
     * conteneur : host.docker.internal n'a de sens que dans le netns d'un
     * conteneur, jamais pour le process du daemon lui-même. C'est la cible
     * vers laquelle le proxy filtrant (tools/proxy.ts, voir
     * runAgentInSandbox) relaie effectivement le trafic d'inférence.
     */
    inferenceUpstreamUrl: env.INFERENCE_UPSTREAM_URL ?? "http://127.0.0.1:1234/v1",
    /**
     * Clé d'API du serveur d'inférence — absente par défaut (LM Studio en
     * local n'en réclame aucune). Renseignée, elle vise un fournisseur
     * distant (Scaleway, OpenRouter, une passerelle interne...) : c'est le
     * PROXY d'inférence qui l'ajoute en `Authorization: Bearer` au moment de
     * relayer vers inferenceUpstreamUrl (voir tools/proxy.ts), jamais le
     * conteneur agent. Le secret reste donc sur l'hôte, hors de portée d'un
     * agent qui lirait sa propre configuration opencode ou son
     * environnement — même raisonnement que GITLAB_TOKEN, jamais confié à un
     * processus non fiable (voir sanitizedEnv() plus bas, dont la liste
     * blanche n'inclut délibérément pas cette variable).
     *
     * Seule exception, assumée : CONTAINER_INFERENCE_URL court-circuite le
     * proxy, il n'y a alors plus personne pour injecter l'en-tête et la clé
     * doit descendre jusqu'au conteneur (voir agent/sandbox.ts).
     */
    inferenceApiKey: env.INFERENCE_API_KEY,
    /**
     * Fenêtre de contexte et budget de sortie déclarés à opencode pour le
     * modèle de l'agent (bloc `models[...].limit` de la configuration générée,
     * voir agent/sandbox.ts).
     *
     * Sans ce bloc, opencode réclame 32 000 tokens de SORTIE par défaut sur un
     * fournisseur custom (bug connu, opencode#1735). Mesuré le 1er août 2026 :
     * trois modèles sur onze ont été éliminés de la campagne pour cette seule
     * raison, sans rapport avec leur qualité —
     *   gemma-3-27b-it   → "max_completion_tokens is limited to 8192"
     *   devstral-2-123b  → "max_completion_tokens is limited to 16384"
     *   holo2-30b-a3b    → contexte max 22000, requête 15493 + 32000 demandés
     * dont devstral-2-123b, un candidat sérieux du palier 128 Go.
     *
     * Défauts prudents (128k de contexte, 16k de sortie) : tiennent chez tous
     * les modèles retenus de la campagne. Un modèle à fenêtre plus courte se
     * règle par ces deux variables plutôt qu'en éditant le code — c'est
     * exactement le genre de réglage qui change d'un déploiement à l'autre.
     * Bornes larges mais réelles : une valeur nulle ou absurde produirait un
     * refus du fournisseur bien plus loin, avec un message sans rapport.
     */
    inferenceContextLimit: finiteNumber(env, "INFERENCE_CONTEXT_LIMIT", 128_000, {
      min: 1_000,
      max: 10_000_000,
    }),
    inferenceOutputLimit: finiteNumber(env, "INFERENCE_OUTPUT_LIMIT", 16_000, {
      min: 256,
      max: 1_000_000,
    }),
    /**
     * Échappatoire explicite (§1.7) : par défaut absent, auquel cas le
     * conteneur agent ne connaît QUE l'adresse du proxy filtrant local
     * (démarré par runAgentInSandbox), jamais une route directe et ouverte
     * vers host.docker.internal (donc vers tous les ports de l'hôte). Si
     * renseignée malgré tout, cette variable redonne l'ancien comportement
     * (accès direct, sans passer par le proxy) — à réserver à un usage
     * avancé conscient du compromis, pas au défaut.
     */
    inferenceUrl: env.CONTAINER_INFERENCE_URL,
    /**
     * §B (durcissement proxy d'entreprise, voir containerProxyEnv plus bas) :
     * échappatoire explicite pour le proxy transmis au conteneur d'un
     * install/test réseau (network: true, pas le conteneur agent — voir
     * containerProxyEnv). Par défaut absente : HTTP_PROXY est repris tel quel
     * depuis l'environnement du daemon, avec réécriture automatique vers
     * host.docker.internal si son hôte est en loopback (127.0.0.1/localhost —
     * injoignable tel quel depuis le netns du conteneur). Cette variable
     * COURT-CIRCUITE cette réécriture automatique : utile si le proxy vit sur
     * une adresse que l'heuristique ne sait pas résoudre correctement (ex. un
     * alias réseau propre à l'hôte, ni loopback ni une adresse LAN normale) —
     * voir le rapport de la tâche pour le détail des cas qui restent
     * irrésolubles automatiquement.
     */
    containerHttpProxy: env.CONTAINER_HTTP_PROXY,
    /** Même rôle que containerHttpProxy ci-dessus, pour HTTPS_PROXY. */
    containerHttpsProxy: env.CONTAINER_HTTPS_PROXY,
    /**
     * Même rôle que containerHttpProxy ci-dessus, pour NO_PROXY — jamais
     * réécrite automatiquement (voir computeContainerProxyEnv), cette
     * variable ne sert donc qu'à donner au conteneur une liste d'exclusions
     * différente de celle de l'hôte, si besoin.
     */
    containerNoProxy: env.CONTAINER_NO_PROXY,
    // Port d'écoute du proxy filtrant démarré par runAgentInSandbox pour
    // chaque exécution de l'agent (0 = l'OS choisit un port libre, ce qui
    // évite toute collision si un proxy précédent n'a pas fini de se
    // fermer — un seul worker tourne à la fois de toute façon, voir
    // queue.ts, donc pas de vrai besoin de port fixe).
    inferenceProxyPort: finiteNumber(env, "INFERENCE_PROXY_PORT", 0, {
      min: 0,
      max: 65_535,
    }),
    // maxAttempts=0 désactiverait silencieusement les réessais.
    maxAttempts: finiteNumber(env, "MAX_ATTEMPTS", 3, { min: 1, max: 20 }),
    // Au-delà, un GitLab qui pend (routeur en carafe, upstream mort...)
    // bloquerait le worker indéfiniment — voir gitlab/client.ts. Plancher
    // bas (50ms) délibérément permissif : sert surtout à garder les tests
    // rapides contre un vrai serveur HTTP local (voir gitlab/client.test.ts) ;
    // 5 min de plafond, au-delà autant dire qu'il n'y a plus de timeout.
    gitlabRequestTimeoutMs: finiteNumber(
      env,
      "GITLAB_REQUEST_TIMEOUT_MS",
      20_000,
      { min: 50, max: 300_000 },
    ),
    // Nombre de réessais (en plus de la tentative initiale) pour les requêtes
    // idempotentes (GET) face à une erreur transitoire (429, 5xx, réseau).
    // 0 désactive les réessais sans désactiver le timeout ci-dessus — utile
    // en test.
    gitlabMaxRetries: finiteNumber(env, "GITLAB_MAX_RETRIES", 4, {
      min: 0,
      max: 10,
    }),
    // Délai de base et plafond du backoff exponentiel (avec jitter complet,
    // voir gitlab/client.ts) entre deux tentatives. Le plafond évite qu'un
    // 429 mal réglé ne fasse attendre le worker des minutes entières.
    gitlabRetryBaseMs: finiteNumber(env, "GITLAB_RETRY_BASE_MS", 500, {
      min: 1,
      max: 60_000,
    }),
    gitlabRetryMaxDelayMs: finiteNumber(env, "GITLAB_RETRY_MAX_DELAY_MS", 8_000, {
      min: 1,
      max: 120_000,
    }),
    // Porte de sortie pour sanitizedEnv() (voir plus bas) : la liste blanche
    // de base couvre les besoins génériques (PATH, HOME, proxies...), mais
    // un dépôt ou un environnement particulier peut avoir besoin d'une
    // variable de plus (ex. un proxy interne sous un autre nom). Format :
    // liste de noms de variables séparés par des virgules, sensible à la
    // casse (ce sont des noms de variables d'environnement).
    extraSanitizedEnvKeys: (env.SANITIZED_ENV_EXTRA_KEYS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    /**
     * §6.5 : serveur HTTP minimal d'observabilité (/healthz, /metrics, voir
     * daemon/health.ts). "0" le désactive complètement — aucun port n'est
     * alors jamais ouvert. Activé par défaut : sans lui, rien ne permet de
     * répondre de l'extérieur à "le daemon est-il vivant ?".
     */
    healthEnabled: env.HEALTH_ENABLED !== "0",
    // 0 = l'OS choisit un port libre (même convention qu'INFERENCE_PROXY_PORT
    // ci-dessus), pratique pour les tests qui démarrent plusieurs instances
    // du serveur sans se soucier d'une collision de port.
    healthPort: finiteNumber(env, "HEALTH_PORT", 8090, {
      min: 0,
      max: 65_535,
    }),
    // Loopback par défaut : pas d'exposition involontaire sur toutes les
    // interfaces réseau d'une machine partagée juste pour un endpoint de
    // supervision.
    healthHost: env.HEALTH_HOST ?? "127.0.0.1",
  } as const;
}

export const config = buildConfig(process.env);

/**
 * Credential git passé par variables d'environnement : rien n'est écrit sur
 * disque. La clé `http.<url>.extraHeader` (plutôt que `http.extraHeader`
 * global) restreint l'en-tête Authorization à l'instance GitLab visée : sans
 * ce préfixe, le PAT partirait vers n'importe quel hôte que git contacte
 * (redirection, sous-module, ...). Le "/" final est significatif — vérifié
 * avec `git config --get-urlmatch` contre un vrai dépôt (voir config.test.ts) :
 * il fait matcher tout chemin sous cet hôte (n'importe quel projet GitLab
 * dessus), sans déborder sur un hôte différent même partageant un préfixe de
 * nom (ex. gitlab.com vs gitlab.com.evil.org, testé et bien distingués par
 * git — le "/" clôt le nom d'hôte).
 */
export function gitCredentialEnv(): NodeJS.ProcessEnv {
  const basic = Buffer.from(`oauth2:${config.token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${config.gitlabUrl}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Liste blanche des variables transmises aux processus enfants non fiables
 * (git, `bash -lc`, l'agent en conteneur — voir agent/workspace.ts et
 * agent/runner.ts) : PATH pour trouver les binaires, HOME pour la
 * configuration git/npm de l'utilisateur, LANG/LANGUAGE/TERM et le préfixe
 * LC_ (locale) pour un affichage correct, TMPDIR/TMP/TEMP pour les fichiers
 * temporaires, et les variables de proxy HTTP pour un réseau sortant qui
 * passe par un proxy d'entreprise (clone git, npm install...).
 *
 * Remplace une denylist par regex, incomplète par construction : ni
 * AWS_ACCESS_KEY_ID (ne matche pas `api[_-]?key`), ni GH_PAT, SSH_AUTH_SOCK,
 * KUBECONFIG ou DATABASE_URL (qui contient souvent un mot de passe) n'y
 * étaient interceptés. Pour un processus explicitement non fiable, seule une
 * liste blanche donne une garantie : tout ce qui n'est pas listé est absent,
 * qu'il "ressemble" à un secret ou non. SSH_AUTH_SOCK en particulier est
 * volontairement exclu : le transmettre équivaudrait à laisser le processus
 * s'authentifier en tant que l'utilisateur via l'agent ssh.
 */
const BASE_ALLOWED_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

/** Environnement expurgé, destiné aux processus enfants non fiables. */
export function sanitizedEnv(): NodeJS.ProcessEnv {
  const allowed = new Set([
    ...BASE_ALLOWED_ENV_KEYS,
    ...config.extraSanitizedEnvKeys,
  ]);
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key) || key.startsWith("LC_")) clean[key] = value;
  }
  return clean;
}

/**
 * §B (durcissement proxy d'entreprise) : hôtes considérés comme "loopback",
 * donc injoignables tels quels depuis le netns d'un conteneur (le loopback
 * DU CONTENEUR n'est jamais celui de l'hôte). Un proxy local (ex. un relais
 * cntlm/kerberos qui n'écoute que sur 127.0.0.1) doit être réécrit vers
 * host.docker.internal pour rester joignable — voir needsHostGateway dans
 * agent/sandbox.ts pour la même logique, déjà appliquée au proxy
 * d'inférence.
 */
const LOOPBACK_PROXY_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

interface RewrittenProxyValue {
  value: string;
  /** true si l'hôte a été réécrit vers host.docker.internal (donc --add-host nécessaire). */
  rewritten: boolean;
}

/**
 * Réécrit l'hôte d'une URL de proxy en loopback vers host.docker.internal ;
 * une URL invalide, ou dont l'hôte n'est pas en loopback (le cas normal d'un
 * proxy d'entreprise sur une adresse réseau réelle, jointe directement par
 * le réseau bridge du conteneur, sans alias particulier), est renvoyée
 * telle quelle.
 */
function rewriteLoopbackProxyHost(raw: string): RewrittenProxyValue {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { value: raw, rewritten: false };
  }
  if (!LOOPBACK_PROXY_HOSTNAMES.has(url.hostname)) return { value: raw, rewritten: false };
  url.hostname = "host.docker.internal";
  return { value: url.toString(), rewritten: true };
}

export interface ContainerProxyEnv {
  /** Variables à transmettre au conteneur via `docker run -e` (voir agent/workspace.ts::runCommand). */
  env: Record<string, string>;
  /** true si --add-host host.docker.internal:host-gateway est nécessaire (au moins une réécriture loopback a eu lieu). */
  hostGateway: boolean;
}

/**
 * Calcule les variables de proxy à transmettre à un conteneur d'install/test
 * (network: true — jamais le conteneur agent, voir le rapport de la tâche
 * pour la justification de cette distinction). Fonction pure, séparée de
 * containerProxyEnv() ci-dessous pour être testable sans dépendre de
 * `config`/`process.env` (même raison que buildConfig, voir plus haut).
 *
 * `overrides` (CONTAINER_HTTP_PROXY/CONTAINER_HTTPS_PROXY/CONTAINER_NO_PROXY,
 * voir buildConfig) COURT-CIRCUITENT entièrement la valeur de l'hôte ET sa
 * réécriture automatique : c'est l'échappatoire explicite pour le cas où
 * cette dernière ne convient pas (voir leur documentation dans buildConfig).
 * Sans override, HTTP_PROXY/HTTPS_PROXY de l'hôte sont repris avec
 * réécriture automatique loopback → host.docker.internal ; NO_PROXY n'est
 * en revanche JAMAIS réécrit (une entrée en loopback y devient simplement
 * sans effet côté conteneur, ce qui est sans risque — voir rewriteLoopbackProxyHost).
 */
export function computeContainerProxyEnv(
  hostEnv: NodeJS.ProcessEnv,
  overrides: { httpProxy?: string; httpsProxy?: string; noProxy?: string } = {},
): ContainerProxyEnv {
  const containerEnv: Record<string, string> = {};
  let hostGateway = false;

  const httpProxyRaw = overrides.httpProxy || hostEnv.HTTP_PROXY || hostEnv.http_proxy;
  if (httpProxyRaw) {
    const { value, rewritten } = overrides.httpProxy
      ? { value: overrides.httpProxy, rewritten: false }
      : rewriteLoopbackProxyHost(httpProxyRaw);
    containerEnv.HTTP_PROXY = value;
    containerEnv.http_proxy = value;
    hostGateway = hostGateway || rewritten;
  }

  const httpsProxyRaw = overrides.httpsProxy || hostEnv.HTTPS_PROXY || hostEnv.https_proxy;
  if (httpsProxyRaw) {
    const { value, rewritten } = overrides.httpsProxy
      ? { value: overrides.httpsProxy, rewritten: false }
      : rewriteLoopbackProxyHost(httpsProxyRaw);
    containerEnv.HTTPS_PROXY = value;
    containerEnv.https_proxy = value;
    hostGateway = hostGateway || rewritten;
  }

  const noProxy = overrides.noProxy || hostEnv.NO_PROXY || hostEnv.no_proxy;
  if (noProxy) {
    containerEnv.NO_PROXY = noProxy;
    containerEnv.no_proxy = noProxy;
  }

  return { env: containerEnv, hostGateway };
}

/**
 * Enveloppe non pure de computeContainerProxyEnv, branchée sur l'environnement
 * réel du daemon et les échappatoires de `config` — voir agent/workspace.ts
 * (runCommand), seul appelant : uniquement pour l'install/les tests du dépôt
 * cible avec accès réseau, jamais pour le conteneur agent (runAgentInSandbox,
 * agent/sandbox.ts), dont le réseau reste volontairement restreint au seul
 * proxy d'inférence local — lui transmettre en plus le proxy d'entreprise
 * élargirait sa portée réseau, à l'exact opposé de cette restriction.
 */
export function containerProxyEnv(): ContainerProxyEnv {
  return computeContainerProxyEnv(process.env, {
    httpProxy: config.containerHttpProxy,
    httpsProxy: config.containerHttpsProxy,
    noProxy: config.containerNoProxy,
  });
}
