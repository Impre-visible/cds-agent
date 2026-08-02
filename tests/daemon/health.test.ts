import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildHealthReport,
  buildMetricsText,
  startHealthServer,
  stopHealthServer,
  type HealthDeps,
} from "../../src/daemon/health.ts";

function baseDeps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    queueDepth: () => 0,
    currentTask: () => undefined,
    lastPollSuccessAt: () => undefined,
    counters: () => ({ processed: 0, refused: 0, abandoned: 0 }),
    startedAt: 0,
    pollIntervalMs: 30_000,
    taskTimeoutMs: 600_000,
    now: () => 1_000_000,
    ...overrides,
  };
}

describe("buildHealthReport — §6.5", () => {
  test("sain au tout premier appel : aucun polling encore réussi, pas dégradé pour autant", () => {
    const report = buildHealthReport(baseDeps());
    assert.equal(report.status, "ok");
    assert.deepEqual(report.reasons, []);
    assert.equal(report.lastPollSuccessAt, null);
    assert.equal(report.msSinceLastPollSuccess, null);
  });

  test("sain quand le dernier polling est récent", () => {
    const report = buildHealthReport(
      baseDeps({ lastPollSuccessAt: () => 1_000_000 - 5_000 }),
    );
    assert.equal(report.status, "ok");
  });

  test("dégradé quand le dernier polling remonte à bien plus que POLL_INTERVAL_MS", () => {
    const report = buildHealthReport(
      baseDeps({
        // poll toutes les 30s (pollIntervalMs par défaut) ; ici 200s de retard.
        lastPollSuccessAt: () => 1_000_000 - 200_000,
      }),
    );
    assert.equal(report.status, "degraded");
    assert.equal(report.reasons.length, 1);
    assert.match(report.reasons[0]!, /polling/);
  });

  test("dégradé quand la tâche en cours dépasse la durée légitime maximale (budget + démarrage + marge)", () => {
    // Plafond : 600_000 (taskTimeoutMs) + 300_000 (démarrage de la
    // conversation) + 6×10_000 (marge de sondage) = 960_000 ms.
    const report = buildHealthReport(
      baseDeps({
        currentTask: () => ({
          key: "note:1",
          projectPath: "grp/repo",
          iid: 7,
          since: 1_000_000 - 2_000_000,
        }),
      }),
    );
    assert.equal(report.status, "degraded");
    assert.ok(report.reasons.some((r) => r.includes("note:1")));
    assert.equal(report.currentTask?.runningForMs, 2_000_000);
  });

  test("sain quand la tâche en cours reste sous le plafond légitime", () => {
    const report = buildHealthReport(
      baseDeps({
        currentTask: () => ({
          key: "note:1",
          projectPath: "grp/repo",
          iid: 7,
          since: 1_000_000 - 60_000,
        }),
      }),
    );
    assert.equal(report.status, "ok");
  });

  test("queueDepth et compteurs sont repris tels quels", () => {
    const report = buildHealthReport(
      baseDeps({
        queueDepth: () => 3,
        counters: () => ({ processed: 5, refused: 1, abandoned: 2 }),
      }),
    );
    assert.equal(report.queueDepth, 3);
    assert.deepEqual(report.counters, { processed: 5, refused: 1, abandoned: 2 });
  });

  test("n'expose jamais autre chose que key/projectPath/iid pour la tâche en cours", () => {
    const report = buildHealthReport(
      baseDeps({
        currentTask: () => ({
          key: "note:1",
          projectPath: "grp/repo",
          iid: 7,
          since: 1_000_000 - 1_000,
        }),
      }),
    );
    assert.deepEqual(Object.keys(report.currentTask!).sort(), [
      "iid",
      "key",
      "projectPath",
      "runningForMs",
    ]);
  });
});

describe("buildMetricsText — §6.5", () => {
  test("reflète la profondeur réelle de la file", () => {
    const text = buildMetricsText(baseDeps({ queueDepth: () => 7 }));
    assert.match(text, /cds_agent_queue_depth 7\n/);
  });

  test("format exposition façon Prometheus : HELP/TYPE avant chaque métrique", () => {
    const text = buildMetricsText(baseDeps());
    assert.match(text, /# HELP cds_agent_queue_depth/);
    assert.match(text, /# TYPE cds_agent_queue_depth gauge/);
    assert.match(text, /# TYPE cds_agent_requests_processed_total counter/);
  });

  test("cds_agent_healthy vaut 0 quand /healthz serait dégradé", () => {
    const text = buildMetricsText(
      baseDeps({ lastPollSuccessAt: () => 1_000_000 - 200_000 }),
    );
    assert.match(text, /cds_agent_healthy 0\n/);
  });
});

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("startHealthServer / stopHealthServer — §6.5", () => {
  test("désactivé : n'écoute sur aucun port", () => {
    const server = startHealthServer(baseDeps(), {
      enabled: false,
      port: 0,
      host: "127.0.0.1",
    });
    assert.equal(server, undefined);
  });

  test("arrêter un serveur désactivé (undefined) résout immédiatement, sans erreur", async () => {
    await assert.doesNotReject(stopHealthServer(undefined));
  });

  test("/healthz répond 200 en nominal, /metrics reflète la file, arrêt propre puis port fermé", async () => {
    const server = startHealthServer(baseDeps({ queueDepth: () => 2 }), {
      enabled: true,
      port: 0,
      host: "127.0.0.1",
    });
    assert.ok(server);
    // try/finally : un stopHealthServer() manqué à cause d'une assertion en
    // échec laisserait le serveur écouter indéfiniment, ce qui bloque tout
    // le run de `node --test` (le port ouvert empêche le process de sortir
    // naturellement) au lieu de simplement faire échouer ce test.
    try {
      await new Promise<void>((resolve) => server!.once("listening", resolve));
      const port = (server!.address() as AddressInfo).port;

      const health = await get(port, "/healthz");
      assert.equal(health.status, 200);
      const parsedHealth = JSON.parse(health.body);
      assert.equal(parsedHealth.status, "ok");

      const metrics = await get(port, "/metrics");
      assert.equal(metrics.status, 200);
      assert.match(metrics.body, /cds_agent_queue_depth 2/);

      const missing = await get(port, "/anything-else");
      assert.equal(missing.status, 404);

      await stopHealthServer(server);
      await assert.rejects(get(port, "/healthz"));
    } finally {
      await stopHealthServer(server);
    }
  });

  test("/healthz répond 503 quand dégradé", async () => {
    const server = startHealthServer(
      baseDeps({
        lastPollSuccessAt: () => Date.now() - 10_000_000,
        pollIntervalMs: 1_000,
        now: undefined,
      }),
      { enabled: true, port: 0, host: "127.0.0.1" },
    );
    assert.ok(server);
    try {
      await new Promise<void>((resolve) => server!.once("listening", resolve));
      const port = (server!.address() as AddressInfo).port;

      const health = await get(port, "/healthz");
      assert.equal(health.status, 503);
      const parsed = JSON.parse(health.body);
      assert.equal(parsed.status, "degraded");
    } finally {
      await stopHealthServer(server);
    }
  });
});
