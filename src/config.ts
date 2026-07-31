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
    dumpDir: env.DUMP_DIR ?? "./todo-dumps",
    stateFile: env.STATE_FILE ?? "./state/processed.jsonl",
    skipMarkDone: env.SKIP_MARK_DONE === "1",
    allowedProjects: list(env, "ALLOWED_PROJECTS"),
    allowedUsers: list(env, "ALLOWED_USERS"),
    // Non utilisé actuellement (code mort), mais validé comme le reste pour
    // ne pas laisser un NaN se propager si l'usage revient un jour.
    taskStubMs: finiteNumber(env, "TASK_STUB_MS", 20_000, {
      min: 0,
      max: 600_000,
    }),
    // Exprimé en minutes côté env : borné à [1, 1440] (une journée) avant
    // conversion en ms.
    lookbackMs:
      finiteNumber(env, "LOOKBACK_MINUTES", 10, { min: 1, max: 1_440 }) *
      60_000,
    agentModel: env.AGENT_MODEL ?? "lmstudio/qwen2.5-coder-7b-instruct-mlx",
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
    useDocker: env.USE_DOCKER === "1",
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
    /** Vue depuis le conteneur : l'hôte n'est pas localhost. */
    inferenceUrl:
      env.CONTAINER_INFERENCE_URL ?? "http://host.docker.internal:1234/v1",
    // maxAttempts=0 désactiverait silencieusement les réessais.
    maxAttempts: finiteNumber(env, "MAX_ATTEMPTS", 3, { min: 1, max: 20 }),
  } as const;
}

export const config = buildConfig(process.env);

/** Credential git passé par variables d'environnement : rien n'est écrit sur disque. */
export function gitCredentialEnv(): NodeJS.ProcessEnv {
  const basic = Buffer.from(`oauth2:${config.token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

const SECRET_PATTERN =
  /token|secret|password|passwd|credential|api[_-]?key|GIT_CONFIG_/i;

/** Environnement expurgé, destiné aux processus enfants non fiables. */
export function sanitizedEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_PATTERN.test(key)) clean[key] = value;
  }
  return clean;
}
