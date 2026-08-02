import { AsyncLocalStorage } from "node:async_hooks";

/**
 * §6.4 : logger structuré (une ligne JSON par événement), avec corrélation
 * portée par `node:async_hooks` plutôt que par un paramètre `context` passé
 * explicitement à chaque fonction traversée entre la réception d'une demande
 * (daemon/index.ts::handle()) et la fin de son traitement par le worker
 * (tasks/openhands.ts::runOpenHandsTask(), potentiellement plusieurs minutes plus tard,
 * une fois dépilée de la file — voir daemon/queue.ts). Le nombre de couches
 * intermédiaires (buildContext, runReview/runImplement, publishReview,
 * runAgentInSandbox...) rendrait un paramètre explicite envahissant partout
 * pour un strict besoin d'observabilité — AsyncLocalStorage suit la chaîne
 * d'appels asynchrones réelle : tant qu'une fonction descend, directement ou
 * non, d'un `withRequestContext(...)`, chaque `log.*()` qu'elle invoque porte
 * automatiquement `key`/`projectPath`/`iid`, sans rien changer à sa
 * signature. Voir daemon/index.ts pour les deux points d'entrée qui posent ce
 * contexte (`handle()` avant la mise en file, `trackedWorker()` pendant
 * l'exécution).
 *
 * Hors de tout `withRequestContext`, un `log.*()` ne porte aucun de ces trois
 * champs — jamais de valeur inventée (ni `undefined` explicite dans le JSON
 * produit, voir emit() ci-dessous) : c'est délibéré, une ligne de démarrage
 * ou de fin de cycle de polling n'a rien à corréler.
 */
export interface LogContext {
  key: string;
  projectPath: string;
  iid: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Exécute `fn` avec `context` posé pour toute sa durée — y compris à travers
 * ses propres `await`, et dans tout ce qu'elle appelle en cascade (voir la
 * doc de tête de fichier). Renvoie ce que `fn` renvoie ou lève ce qu'elle
 * lève, sans rien absorber : le contexte de corrélation n'a aucune raison
 * d'affecter le flux de contrôle du code qu'il observe.
 */
export function withRequestContext<T>(
  context: LogContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

/** Contexte actuellement actif, s'il y en a un — utile à health.ts (tâche en cours) et aux tests. */
export function currentContext(): LogContext | undefined {
  return storage.getStore();
}

/** Lu à chaque appel (pas mis en cache) : un test peut ainsi basculer LOG_LEVEL sans réimporter le module. */
function configuredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw === "debug" || raw === "warn" || raw === "error" ? raw : "info";
}

/**
 * JSON par défaut (machine-lisible, §6.4) : c'est le format qui doit rester
 * exploitable sans effort par un outil de collecte de logs. `LOG_PRETTY=1`
 * bascule sur une ligne condensée pensée pour un terminal humain — ce projet
 * se debugue aussi en regardant défiler le terminal en développement.
 */
function prettyEnabled(): boolean {
  return process.env.LOG_PRETTY === "1";
}

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  key?: string;
  projectPath?: string;
  iid?: number;
  [extra: string]: unknown;
}

/**
 * Formatage pur d'une entrée déjà construite — séparé d'emit() pour être
 * testé sans passer par console (voir log.test.ts).
 */
export function formatLine(entry: LogEntry, pretty: boolean): string {
  if (!pretty) return JSON.stringify(entry);

  const { ts, level, msg, key, projectPath, iid, ...rest } = entry;
  const time = ts.split("T")[1]?.replace("Z", "") ?? ts;
  const location = [projectPath, iid !== undefined ? `!${iid}` : ""]
    .filter(Boolean)
    .join("");
  const corr = key ? ` [${key}${location ? ` ${location}` : ""}]` : "";
  const restKeys = Object.keys(rest);
  const suffix = restKeys.length > 0 ? ` ${JSON.stringify(rest)}` : "";
  return `${time} ${level.toUpperCase().padEnd(5)}${corr} ${msg}${suffix}`;
}

function writeLine(level: LogLevel, line: string): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function emit(
  level: LogLevel,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[configuredLevel()]) return;

  const context = storage.getStore();
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(context ?? {}),
    ...(extra ?? {}),
  };
  writeLine(level, formatLine(entry, prettyEnabled()));
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) =>
    emit("debug", msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) =>
    emit("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) =>
    emit("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) =>
    emit("error", msg, extra),
};
