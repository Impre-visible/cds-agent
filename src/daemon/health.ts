import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Counters, RunningTask } from "./status.ts";
import { OPENHANDS_POLL_MS, OPENHANDS_START_TIMEOUT_MS } from "../limits.ts";

/**
 * §6.5 : serveur HTTP minimal (`node:http`, zéro dépendance) répondant à
 * "le daemon est-il vivant ?" (`/healthz`) et "combien traite-t-il, combien
 * refuse-t-il, combien abandonne-t-il ?" (`/metrics`). Dépendances injectées
 * (plutôt qu'un import direct de `queue`/`daemonStatus`/`config`) pour rester
 * testable sans process réel ni horloge système — voir health.test.ts et le
 * même choix dans bootstrap.ts.
 *
 * N'expose jamais : le texte d'une demande, le contenu d'un dépôt, ni bien
 * sûr le token GitLab — seuls `key` (un identifiant dérivé, voir
 * daemon/request.ts, jamais le texte de la demande lui-même), `projectPath`
 * et `iid` apparaissent, les mêmes trois champs que la corrélation des logs
 * (voir log.ts).
 */
export interface HealthDeps {
  queueDepth: () => number;
  currentTask: () => RunningTask | undefined;
  lastPollSuccessAt: () => number | undefined;
  counters: () => Counters;
  startedAt: number;
  pollIntervalMs: number;
  /**
   * Budget de travail accordé à une conversation OpenHands
   * (OPENHANDS_TIMEOUT_MINUTES). Remplace l'ancien couple
   * agentTimeoutMs + commandTimeoutMs : le daemon ne lance plus ni install ni
   * suite de tests, il n'y a donc plus qu'une seule durée à borner.
   */
  taskTimeoutMs: number;
  /** Horloge injectable pour les tests ; Date.now par défaut. */
  now?: () => number;
}

export interface HealthReport {
  status: "ok" | "degraded";
  /** Motifs de dégradation, vide si `status === "ok"` — jamais de statut dégradé silencieux. */
  reasons: string[];
  uptimeMs: number;
  lastPollSuccessAt: string | null;
  msSinceLastPollSuccess: number | null;
  pollIntervalMs: number;
  queueDepth: number;
  currentTask: {
    key: string;
    projectPath: string;
    iid: number;
    runningForMs: number;
  } | null;
  counters: Counters;
}

/**
 * Multiplicateur appliqué à pollIntervalMs pour décider qu'un cycle de
 * polling en retard signale un daemon bloqué plutôt qu'une simple gigue
 * (jitter réseau, pause GC...). Un seul cycle manqué n'a rien d'anormal ;
 * plusieurs d'affilée n'ont pas d'explication bénigne — voir aussi le
 * commentaire de sleep() dans shutdown.ts sur ce que peut retarder un cycle.
 */
const POLL_STALE_MULTIPLIER = 3;

/**
 * Formatage pur du rapport de santé — exporté pour être testé sans serveur
 * HTTP réel (voir health.test.ts). `buildHealthReport` ne fait aucune E/S.
 */
export function buildHealthReport(deps: HealthDeps): HealthReport {
  const now = (deps.now ?? Date.now)();
  const reasons: string[] = [];

  // Absence de tout polling réussi (tout juste démarré) : pas encore de
  // signal exploitable, donc pas de dégradation par ce seul fait — sans quoi
  // /healthz répondrait "dégradé" pendant les premières secondes de tout
  // démarrage, ce qui n'a rien d'un incident.
  const lastPoll = deps.lastPollSuccessAt();
  const msSincePoll = lastPoll !== undefined ? now - lastPoll : null;
  const staleThreshold = deps.pollIntervalMs * POLL_STALE_MULTIPLIER;
  if (msSincePoll !== null && msSincePoll > staleThreshold) {
    reasons.push(
      `dernier polling réussi il y a ${Math.round(msSincePoll / 1000)}s, ` +
        `au-delà du seuil (${Math.round(staleThreshold / 1000)}s = ` +
        `${POLL_STALE_MULTIPLIER}×POLL_INTERVAL_MS)`,
    );
  }

  const rawTask = deps.currentTask();
  const currentTask = rawTask
    ? {
        key: rawTask.key,
        projectPath: rawTask.projectPath,
        iid: rawTask.iid,
        runningForMs: now - rawTask.since,
      }
    : null;

  // Plafond de durée légitime d'une tâche : le budget de travail accordé à la
  // conversation, plus le temps de la préparer (bac à sable, clone, script de
  // setup, compétences — OPENHANDS_START_TIMEOUT_MS) et une marge pour les
  // sondages eux-mêmes. Au-delà, la tâche est plus vraisemblablement bloquée
  // (waitForCompletion qui ne rend jamais la main, instance qui ne répond
  // plus) qu'en train de travailler : c'est ce qui répond à « bloqué depuis
  // 40 minutes ? ». Avec le défaut du projet (10 min), le plafond tombe à
  // 16 min.
  const maxLegitimateTaskMs =
    deps.taskTimeoutMs + OPENHANDS_START_TIMEOUT_MS + OPENHANDS_POLL_MS * 6;
  if (currentTask && currentTask.runningForMs > maxLegitimateTaskMs) {
    reasons.push(
      `tâche ${currentTask.key} en cours depuis ` +
        `${Math.round(currentTask.runningForMs / 60_000)} min, au-delà de la ` +
        `durée légitime maximale (${Math.round(maxLegitimateTaskMs / 60_000)} min)`,
    );
  }

  return {
    status: reasons.length === 0 ? "ok" : "degraded",
    reasons,
    uptimeMs: now - deps.startedAt,
    lastPollSuccessAt:
      lastPoll !== undefined ? new Date(lastPoll).toISOString() : null,
    msSinceLastPollSuccess: msSincePoll,
    pollIntervalMs: deps.pollIntervalMs,
    queueDepth: deps.queueDepth(),
    currentTask,
    counters: deps.counters(),
  };
}

function metricLine(
  name: string,
  help: string,
  type: "gauge" | "counter",
  value: number,
): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}\n`;
}

/**
 * Exposition texte façon Prometheus, écrite à la main (zéro dépendance,
 * aucun client officiel importé) — un format texte simple suffit au besoin
 * réel (scrape périodique par un outil externe, ou lecture humaine directe).
 */
export function buildMetricsText(deps: HealthDeps): string {
  const report = buildHealthReport(deps);
  return [
    metricLine(
      "cds_agent_healthy",
      "1 si /healthz est \"ok\", 0 si \"degraded\".",
      "gauge",
      report.status === "ok" ? 1 : 0,
    ),
    metricLine(
      "cds_agent_uptime_seconds",
      "Durée depuis le démarrage du daemon.",
      "gauge",
      Math.round(report.uptimeMs / 1000),
    ),
    metricLine(
      "cds_agent_queue_depth",
      "Nombre de tâches dans la file (en cours + en attente, voir queue.ts).",
      "gauge",
      report.queueDepth,
    ),
    metricLine(
      "cds_agent_current_task_running_seconds",
      "Durée d'exécution de la tâche en cours, en secondes (0 si aucune).",
      "gauge",
      report.currentTask
        ? Math.round(report.currentTask.runningForMs / 1000)
        : 0,
    ),
    metricLine(
      "cds_agent_requests_processed_total",
      "Demandes menées à terme avec succès depuis le démarrage.",
      "counter",
      report.counters.processed,
    ),
    metricLine(
      "cds_agent_requests_refused_total",
      "Demandes refusées par authorize() (dépôt ou auteur hors liste blanche).",
      "counter",
      report.counters.refused,
    ),
    metricLine(
      "cds_agent_requests_abandoned_total",
      "Demandes abandonnées après épuisement de MAX_ATTEMPTS.",
      "counter",
      report.counters.abandoned,
    ),
  ].join("");
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function route(
  deps: HealthDeps,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const url = req.url ?? "/";

  if (url === "/healthz") {
    const report = buildHealthReport(deps);
    // 503 quand dégradé : un simple GET (sans même lire le corps) suffit
    // alors à un supervisor externe pour détecter le problème.
    respondJson(res, report.status === "ok" ? 200 : 503, report);
    return;
  }

  if (url === "/metrics") {
    res.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
    res.end(buildMetricsText(deps));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found\n");
}

/**
 * Démarre le serveur d'observabilité, ou ne fait rien si `enabled` est faux —
 * c'est là, et seulement là, que se joue la désactivation complète
 * (`HEALTH_ENABLED=0`, voir config.ts) : aucun port n'est jamais ouvert dans
 * ce cas, pas même sur un port inerte qui répondrait 000.
 */
export function startHealthServer(
  deps: HealthDeps,
  options: { enabled: boolean; port: number; host: string },
): Server | undefined {
  if (!options.enabled) return undefined;
  const server = createServer((req, res) => route(deps, req, res));
  server.listen(options.port, options.host);
  return server;
}

/**
 * Arrêt propre, branché sur la séquence de drain de shutdown.ts (voir
 * shutdownSequence() dans index.ts) : `undefined` (serveur désactivé) résout
 * immédiatement, sans quoi chaque appelant devrait vérifier lui-même la
 * présence du serveur avant de fermer.
 */
export function stopHealthServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
