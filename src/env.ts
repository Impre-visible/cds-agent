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

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name} — voir .env`);
  }
  return value;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  gitlabUrl: (process.env.GITLAB_URL ?? "https://gitlab.com").replace(
    /\/+$/,
    "",
  ),
  token: required("GITLAB_TOKEN"),
  botUsername: required("BOT_USERNAME"),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 30_000),
  dumpDir: process.env.DUMP_DIR ?? "./todo-dumps",
  stateFile: process.env.STATE_FILE ?? "./state/processed.jsonl",
  skipMarkDone: process.env.SKIP_MARK_DONE === "1",
  allowedProjects: list("ALLOWED_PROJECTS"),
  allowedUsers: list("ALLOWED_USERS"),
  taskStubMs: Number(process.env.TASK_STUB_MS ?? 20_000),
  lookbackMs: Number(process.env.LOOKBACK_MINUTES ?? 10) * 60_000,
  agentModel:
    process.env.AGENT_MODEL ?? "lmstudio/qwen2.5-coder-7b-instruct-mlx",
  agentTimeoutMs: Number(process.env.AGENT_TIMEOUT_MINUTES ?? 10) * 60_000,
  maxRemarks: Number(process.env.MAX_REMARKS ?? 5),
  gitAuthorName: process.env.GIT_AUTHOR_NAME ?? "cds-agent",
  gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL ?? "cds-agent@local.invalid",
  testCommand: process.env.TEST_COMMAND ?? "npm test",
  installCommand: process.env.INSTALL_COMMAND ?? "npm install",
  commandTimeoutMs: Number(process.env.COMMAND_TIMEOUT_MINUTES ?? 5) * 60_000,
  fakeAgentScript: process.env.FAKE_AGENT_SCRIPT ?? "",
} as const;

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
