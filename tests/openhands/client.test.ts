import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  OpenHandsClient,
  OpenHandsError,
  isTerminalExecutionStatus,
  type Conversation,
  type StartTask,
} from "../../src/openhands/client.ts";

/**
 * Enregistre chaque appel et rend les réponses préparées, dans l'ordre. Aucune
 * requête réseau n'est émise : ce qui est testé ici, c'est exactement ce que
 * demande le chantier — construction de la requête, lecture de la réponse,
 * gestion des statuts, timeout.
 */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(responses: { status?: number; body?: unknown; text?: string }[]) {
  const calls: Call[] = [];
  let index = 0;

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    // La dernière réponse est répétée si le client sonde plus longtemps que
    // prévu : un test qui boucle doit échouer sur son assertion, pas sur un
    // "undefined" opaque au troisième tour.
    const spec = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    const text = spec.text ?? JSON.stringify(spec.body ?? null);
    return {
      ok: (spec.status ?? 200) >= 200 && (spec.status ?? 200) < 300,
      status: spec.status ?? 200,
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function makeStartTask(overrides: Partial<StartTask> = {}): StartTask {
  return {
    id: "task-1",
    status: "WORKING",
    app_conversation_id: null,
    sandbox_id: null,
    detail: null,
    ...overrides,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    sandbox_id: "oh-agent-server-abc",
    sandbox_status: "RUNNING",
    execution_status: "running",
    conversation_url: null,
    title: null,
    ...overrides,
  };
}

/** Horloge contrôlée : le temps n'avance que quand le client dort. */
function fakeClock(startAt = 0) {
  let now = startAt;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

describe("OpenHandsClient — construction de la requête", () => {
  test("startConversation cible /api/v1/app-conversations et met le message au format attendu", async () => {
    const { fetchImpl, calls } = stubFetch([{ body: makeStartTask() }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      apiKey: "secret",
      fetch: fetchImpl,
    });

    await client.startConversation({
      message: "relis la MR !5",
      repository: "grp/repo",
      branch: "feature/x",
      title: "cds-agent grp/repo!5",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "http://openhands.local:3000/api/v1/app-conversations");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(calls[0]!.body, {
      // La forme de SendMessageRequest : un rôle et une LISTE de contenus
      // typés — pas une chaîne nue, que le serveur refuserait.
      initial_message: {
        role: "user",
        content: [{ type: "text", text: "relis la MR !5" }],
      },
      selected_repository: "grp/repo",
      git_provider: "gitlab",
      selected_branch: "feature/x",
      title: "cds-agent grp/repo!5",
    });
  });

  test("la clé d'API part en X-Session-API-Key, jamais en Authorization: Bearer", async () => {
    const { fetchImpl, calls } = stubFetch([{ body: makeStartTask() }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      apiKey: "secret",
      fetch: fetchImpl,
    });

    await client.startConversation({ message: "x", repository: "grp/repo" });

    assert.equal(calls[0]!.headers["X-Session-API-Key"], "secret");
    assert.equal(calls[0]!.headers.authorization, undefined);
    assert.equal(calls[0]!.headers.Authorization, undefined);
  });

  test("sans clé d'API, aucun en-tête d'authentification n'est envoyé (pas un en-tête vide)", async () => {
    const { fetchImpl, calls } = stubFetch([{ body: makeStartTask() }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
    });

    await client.startConversation({ message: "x", repository: "grp/repo" });

    assert.ok(!("X-Session-API-Key" in calls[0]!.headers));
  });

  test("les / de fin de baseUrl sont retirés — pas d'URL à double slash", async () => {
    const { fetchImpl, calls } = stubFetch([{ body: makeStartTask() }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000///",
      fetch: fetchImpl,
    });

    await client.startConversation({ message: "x", repository: "grp/repo" });

    assert.equal(calls[0]!.url, "http://openhands.local:3000/api/v1/app-conversations");
  });

  test("branch et title absents ne sont pas envoyés à null", async () => {
    const { fetchImpl, calls } = stubFetch([{ body: makeStartTask() }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
    });

    await client.startConversation({ message: "x", repository: "grp/repo" });

    const body = calls[0]!.body as Record<string, unknown>;
    assert.ok(!("selected_branch" in body));
    assert.ok(!("title" in body));
  });
});

describe("OpenHandsClient — lecture de la réponse", () => {
  test("getStartTask lit le premier élément du tableau rendu par la lecture par lot", async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: [makeStartTask({ status: "READY", app_conversation_id: "conv-1" })] },
    ]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
    });

    const task = await client.getStartTask("task-1");

    assert.equal(
      calls[0]!.url,
      "http://openhands.local:3000/api/v1/app-conversations/start-tasks?ids=task-1",
    );
    assert.equal(task?.app_conversation_id, "conv-1");
  });

  test("un identifiant inconnu rend null (le serveur renvoie [null], pas une erreur)", async () => {
    const { fetchImpl } = stubFetch([{ body: [null] }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
    });

    assert.equal(await client.getStartTask("inconnu"), null);
    assert.equal(await client.getConversation("inconnu"), null);
  });

  test("getConversation passe l'identifiant en ids= sur la racine des conversations", async () => {
    const { fetchImpl, calls } = stubFetch([{ body: [makeConversation()] }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
    });

    await client.getConversation("conv 1");

    assert.equal(
      calls[0]!.url,
      "http://openhands.local:3000/api/v1/app-conversations?ids=conv%201",
    );
  });

  test("une réponse non-2xx lève une OpenHandsError qui porte le statut et l'URL", async () => {
    const { fetchImpl } = stubFetch([{ status: 401, text: "Unauthorized" }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
    });

    await assert.rejects(
      () => client.startConversation({ message: "x", repository: "grp/repo" }),
      (error: unknown) => {
        assert.ok(error instanceof OpenHandsError);
        assert.equal(error.status, 401);
        assert.match(error.message, /401/);
        assert.match(error.message, /app-conversations/);
        return true;
      },
    );
  });

  test("un 2xx au corps illisible lève une OpenHandsError, pas une SyntaxError de JSON.parse", async () => {
    const { fetchImpl } = stubFetch([{ status: 200, text: "<html>proxy</html>" }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
    });

    await assert.rejects(
      () => client.startConversation({ message: "x", repository: "grp/repo" }),
      (error: unknown) => {
        assert.ok(error instanceof OpenHandsError);
        assert.match(error.message, /illisible/);
        return true;
      },
    );
  });

  test("health interroge /health, hors de /api/v1", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, text: "OK\n" }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
    });

    assert.equal(await client.health(), "OK");
    assert.equal(calls[0]!.url, "http://openhands.local:3000/health");
  });
});

describe("OpenHandsClient — statuts de démarrage", () => {
  test("waitForReady sonde jusqu'à READY et rend l'identifiant de conversation", async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = stubFetch([
      { body: [makeStartTask({ status: "WAITING_FOR_SANDBOX" })] },
      { body: [makeStartTask({ status: "PREPARING_REPOSITORY" })] },
      { body: [makeStartTask({ status: "READY", app_conversation_id: "conv-9" })] },
    ]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });

    const id = await client.waitForReady("task-1", {
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
    });

    assert.equal(id, "conv-9");
    assert.equal(calls.length, 3);
  });

  test("le statut ERROR lève, en reprenant le detail du serveur", async () => {
    const clock = fakeClock();
    const { fetchImpl } = stubFetch([
      { body: [makeStartTask({ status: "ERROR", detail: "image introuvable" })] },
    ]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });

    await assert.rejects(
      () => client.waitForReady("task-1", { timeoutMs: 60_000, pollIntervalMs: 1_000 }),
      /image introuvable/,
    );
  });

  test("READY sans identifiant de conversation lève plutôt que de rendre une valeur vide", async () => {
    const clock = fakeClock();
    const { fetchImpl } = stubFetch([
      { body: [makeStartTask({ status: "READY", app_conversation_id: null })] },
    ]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });

    await assert.rejects(
      () => client.waitForReady("task-1", { timeoutMs: 60_000, pollIntervalMs: 1_000 }),
      /sans identifiant de conversation/,
    );
  });

  test("un démarrage qui n'aboutit pas dans le budget lève en nommant le dernier statut", async () => {
    const clock = fakeClock();
    const { fetchImpl } = stubFetch([{ body: [makeStartTask({ status: "WORKING" })] }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });

    await assert.rejects(
      () => client.waitForReady("task-1", { timeoutMs: 5_000, pollIntervalMs: 1_000 }),
      /WORKING/,
    );
  });

  test("une tâche de démarrage introuvable lève au lieu de sonder indéfiniment", async () => {
    const clock = fakeClock();
    const { fetchImpl } = stubFetch([{ body: [null] }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });

    await assert.rejects(
      () => client.waitForReady("task-1", { timeoutMs: 5_000, pollIntervalMs: 1_000 }),
      /introuvable/,
    );
  });
});

describe("OpenHandsClient — statuts d'exécution et timeout", () => {
  test("isTerminalExecutionStatus suit le SDK : idle n'est PAS terminal", () => {
    assert.equal(isTerminalExecutionStatus("finished"), true);
    assert.equal(isTerminalExecutionStatus("error"), true);
    assert.equal(isTerminalExecutionStatus("stuck"), true);
    // Le piège que le SDK documente explicitement : idle est l'état d'une
    // conversation qui n'a pas encore démarré. Le traiter comme une fin
    // conclurait « terminé » à la toute première lecture.
    assert.equal(isTerminalExecutionStatus("idle"), false);
    assert.equal(isTerminalExecutionStatus("running"), false);
    assert.equal(isTerminalExecutionStatus("waiting_for_confirmation"), false);
  });

  test("waitForCompletion traverse idle puis running et s'arrête sur finished", async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = stubFetch([
      { body: [makeConversation({ execution_status: "idle" })] },
      { body: [makeConversation({ execution_status: "running" })] },
      { body: [makeConversation({ execution_status: "finished" })] },
    ]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });

    const outcome = await client.waitForCompletion("conv-1", {
      timeoutMs: 600_000,
      pollIntervalMs: 10_000,
    });

    assert.equal(outcome.result, "finished");
    assert.equal(calls.length, 3);
    assert.equal(outcome.elapsedMs, 20_000);
  });

  test("waiting_for_confirmation est une issue à part entière, pas une attente à prolonger", async () => {
    const clock = fakeClock();
    const { fetchImpl } = stubFetch([
      { body: [makeConversation({ execution_status: "waiting_for_confirmation" })] },
    ]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });

    const outcome = await client.waitForCompletion("conv-1", {
      timeoutMs: 600_000,
      pollIntervalMs: 10_000,
    });

    assert.equal(outcome.result, "waiting");
  });

  test("stuck et error remontent tels quels, sans lever", async () => {
    for (const status of ["stuck", "error"] as const) {
      const clock = fakeClock();
      const { fetchImpl } = stubFetch([
        { body: [makeConversation({ execution_status: status })] },
      ]);
      const client = new OpenHandsClient({
        baseUrl: "http://openhands.local:3000",
        fetch: fetchImpl,
        sleep: clock.sleep,
        now: clock.now,
      });

      const outcome = await client.waitForCompletion("conv-1", {
        timeoutMs: 600_000,
        pollIntervalMs: 10_000,
      });
      assert.equal(outcome.result, status);
    }
  });

  test("un bac à sable MISSING coupe court : continuer à sonder ne rendrait jamais rien", async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = stubFetch([
      { body: [makeConversation({ sandbox_status: "MISSING", execution_status: null })] },
    ]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });

    const outcome = await client.waitForCompletion("conv-1", {
      timeoutMs: 600_000,
      pollIntervalMs: 10_000,
    });

    assert.equal(outcome.result, "error");
    assert.equal(calls.length, 1);
  });

  test("le timeout rend result=timeout — sans lever : la conversation continue côté OpenHands", async () => {
    const clock = fakeClock();
    const { fetchImpl } = stubFetch([
      { body: [makeConversation({ execution_status: "running" })] },
    ]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });

    const outcome = await client.waitForCompletion("conv-1", {
      timeoutMs: 30_000,
      pollIntervalMs: 10_000,
    });

    assert.equal(outcome.result, "timeout");
    assert.equal(outcome.elapsedMs, 30_000);
    assert.equal(outcome.conversation?.execution_status, "running");
  });

  test("une conversation encore inconnue (null) ne conclut rien : on continue de sonder", async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = stubFetch([
      { body: [null] },
      { body: [makeConversation({ execution_status: "finished" })] },
    ]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });

    const outcome = await client.waitForCompletion("conv-1", {
      timeoutMs: 600_000,
      pollIntervalMs: 10_000,
    });

    assert.equal(outcome.result, "finished");
    assert.equal(calls.length, 2);
  });
});

describe("OpenHandsClient — reprise d'une conversation existante", () => {
  test("sendMessage cible /{id}/send-message et pose run: true", async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { success: true } }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
    });

    await client.sendMessage("conv-1", "et les tests ?");

    assert.equal(
      calls[0]!.url,
      "http://openhands.local:3000/api/v1/app-conversations/conv-1/send-message",
    );
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(calls[0]!.body, {
      role: "user",
      content: [{ type: "text", text: "et les tests ?" }],
      // Le défaut amont est false : sans ça le message est déposé mais la
      // boucle de l'agent ne redémarre pas, et le daemon attendrait jusqu'au
      // timeout devant une conversation restée idle.
      run: true,
    });
  });

  test("un 409 (bac à sable pas RUNNING) remonte comme OpenHandsError", async () => {
    const { fetchImpl } = stubFetch([{ status: 409, text: "Sandbox is not running" }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
    });

    await assert.rejects(
      () => client.sendMessage("conv-1", "x"),
      (error: unknown) => {
        assert.ok(error instanceof OpenHandsError);
        assert.equal(error.status, 409);
        return true;
      },
    );
  });

  test("resumeSandbox cible /api/v1/sandboxes/{id}/resume — hors du routeur des conversations", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, text: "" }]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      apiKey: "secret",
      fetch: fetchImpl,
    });

    await client.resumeSandbox("oh-agent-server-abc");

    assert.equal(
      calls[0]!.url,
      "http://openhands.local:3000/api/v1/sandboxes/oh-agent-server-abc/resume",
    );
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["X-Session-API-Key"], "secret");
  });

  test("waitForSandboxRunning attend la sortie de PAUSED", async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = stubFetch([
      { body: [makeConversation({ sandbox_status: "PAUSED", execution_status: null })] },
      { body: [makeConversation({ sandbox_status: "STARTING", execution_status: null })] },
      { body: [makeConversation({ sandbox_status: "RUNNING" })] },
    ]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });

    assert.equal(
      await client.waitForSandboxRunning("conv-1", { timeoutMs: 60_000, pollIntervalMs: 1_000 }),
      true,
    );
    assert.equal(calls.length, 3);
  });

  test("un bac à sable ERROR ou MISSING coupe court plutôt que d'attendre le délai", async () => {
    for (const status of ["ERROR", "MISSING"] as const) {
      const clock = fakeClock();
      const { fetchImpl, calls } = stubFetch([
        { body: [makeConversation({ sandbox_status: status, execution_status: null })] },
      ]);
      const client = new OpenHandsClient({
        baseUrl: "http://openhands.local:3000",
        fetch: fetchImpl,
        sleep: clock.sleep,
        now: clock.now,
      });

      assert.equal(
        await client.waitForSandboxRunning("conv-1", { timeoutMs: 60_000, pollIntervalMs: 1_000 }),
        false,
      );
      assert.equal(calls.length, 1, `${status} : inutile de sonder une seconde fois`);
    }
  });

  test("un bac à sable qui ne repart pas dans le délai rend false, sans lever", async () => {
    const clock = fakeClock();
    const { fetchImpl } = stubFetch([
      { body: [makeConversation({ sandbox_status: "PAUSED", execution_status: null })] },
    ]);
    const client = new OpenHandsClient({
      baseUrl: "http://openhands.local:3000",
      fetch: fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });

    assert.equal(
      await client.waitForSandboxRunning("conv-1", { timeoutMs: 3_000, pollIntervalMs: 1_000 }),
      false,
    );
  });
});

describe("OpenHandsClient — adresse de la conversation", () => {
  test("l'adresse est construite sur OPENHANDS_URL, JAMAIS sur conversation_url", () => {
    // conversation_url, malgré son nom, vaut
    // http://localhost:<port-du-bac-à-sable>/api/conversations/<id> — l'API
    // de l'agent-server sur un port éphémère, pas une page. Mesuré contre une
    // instance réelle. La route de l'interface web est /conversations/<id>
    // sur la racine de l'instance (frontend/src/routes.ts).
    const client = new OpenHandsClient({ baseUrl: "http://interne:3000/" });
    assert.equal(client.conversationUrl("abc"), "http://interne:3000/conversations/abc");
  });
});
