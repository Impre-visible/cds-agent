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

function list(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** Format : "groupe/depot=image,autre/depot=autre-image" */
function parseImageMap(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const [path, image] = entry.split("=").map((part) => part.trim());
    if (path && image) map.set(path.toLowerCase(), image);
  }
  return map;
}

/**
 * Format : "groupe/depot=dossier1|dossier2,autre/depot=dossier3" — même
 * syntaxe que DOCKER_IMAGES, avec un "|" en plus pour séparer les
 * plusieurs noms de dossier d'un même dépôt. Sert à déclarer, dépôt par
 * dépôt, des répertoires de test maison en plus des conventions standard
 * reconnues par tasks/guard.ts (tests/, test/, __tests__/, spec/) : un
 * monorepo qui range ses tests sous "e2e/" par exemple, sans élargir la
 * détection par défaut de tous les autres dépôts. Absent de la config, la
 * détection reste strictement celle des conventions standard.
 */
function parseTestDirectoryMap(raw: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of raw.split(",")) {
    const [path, directories] = entry.split("=").map((part) => part.trim());
    if (!path || !directories) continue;
    const names = directories
      .split("|")
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length) map.set(path.toLowerCase(), names);
  }
  return map;
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
    allowedProjects: list(env, "ALLOWED_PROJECTS"),
    allowedUsers: list(env, "ALLOWED_USERS"),
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
    // maxRemarks=0 viderait silencieusement toute review (slice(0, 0)).
    maxRemarks: finiteNumber(env, "MAX_REMARKS", 5, { min: 1, max: 50 }),
    gitAuthorName: env.GIT_AUTHOR_NAME ?? "cds-agent",
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL ?? "cds-agent@local.invalid",
    testCommand: env.TEST_COMMAND ?? "npm test",
    installCommand: env.INSTALL_COMMAND ?? "npm install",
    // Exprimé en minutes côté env, même logique que agentTimeoutMs.
    commandTimeoutMs:
      finiteNumber(env, "COMMAND_TIMEOUT_MINUTES", 5, { min: 1, max: 60 }) *
      60_000,
    fakeAgentScript: env.FAKE_AGENT_SCRIPT ?? "",
    useDocker: resolveUseDocker(env),
    dockerImages: parseImageMap(env.DOCKER_IMAGES ?? ""),
    testDirectoryOverrides: parseTestDirectoryMap(
      env.TEST_DIRECTORY_OVERRIDES ?? "",
    ),
    dockerDefaultImage: env.DOCKER_DEFAULT_IMAGE ?? "node:22-bookworm-slim",
    // Format docker --memory : un nombre suivi d'une unité optionnelle
    // (b/k/m/g).
    dockerMemory: matchingFormat(env, "DOCKER_MEMORY", "4g", /^\d+(\.\d+)?[bkmg]?$/i),
    // Format docker --cpus : un nombre entier ou décimal.
    dockerCpus: matchingFormat(env, "DOCKER_CPUS", "4", /^\d+(\.\d+)?$/),
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
     * Échappatoire explicite (§1.7) : par défaut absent, auquel cas le
     * conteneur agent ne connaît QUE l'adresse du proxy filtrant local
     * (démarré par runAgentInSandbox), jamais une route directe et ouverte
     * vers host.docker.internal (donc vers tous les ports de l'hôte). Si
     * renseignée malgré tout, cette variable redonne l'ancien comportement
     * (accès direct, sans passer par le proxy) — à réserver à un usage
     * avancé conscient du compromis, pas au défaut.
     */
    inferenceUrl: env.CONTAINER_INFERENCE_URL,
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
