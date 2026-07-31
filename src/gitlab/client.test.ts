import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { Todo } from "../types.ts";

// client.ts importe (transitivement) src/config.ts, qui jette au chargement
// si GITLAB_TOKEN/BOT_USERNAME sont absents, et calcule GITLAB_URL une fois
// pour toutes. On monte donc un vrai serveur node:http jetable *avant*
// l'import dynamique, port 0 pour en obtenir un libre, et on pointe
// GITLAB_URL dessus — même astuce que request.test.ts/review.test.ts pour
// les variables obligatoires, étendue ici à un vrai serveur plutôt qu'un
// mock, comme demandé pour durcir du code qui parle HTTP (§3.4/§3.5).
//
// Délais très courts (timeout 200ms, backoff 20-80ms) : les scénarios de
// réessai/backoff doivent rester rapides à exécuter, tout en restant assez
// grands pour se distinguer sans ambiguïté d'un Retry-After d'une seconde
// dans le test dédié.
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
const routes = new Map<string, Handler>();

let gitlab: typeof import("./client.ts").gitlab;
let api: typeof import("./client.ts").api;
let apiForm: typeof import("./client.ts").apiForm;
let GitLabError: typeof import("./client.ts").GitLabError;

function makeTodo(id: number): Todo {
  return {
    id,
    action_name: "mentioned",
    target_type: "MergeRequest",
    target: { id, iid: id, project_id: 1 },
    target_url: `https://example.invalid/mr/${id}`,
    body: "",
    state: "pending",
    created_at: new Date(2026, 0, 1, 0, 0, id).toISOString(),
    author: { id: 1, username: "someone", name: "Someone" },
  };
}

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handler = routes.get(url.pathname);
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `route de test non enregistrée : ${url.pathname}` }));
      return;
    }
    handler(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("adresse de serveur de test inattendue");
  }

  process.env.GITLAB_URL = `http://127.0.0.1:${address.port}`;
  process.env.GITLAB_TOKEN = "test-token";
  process.env.BOT_USERNAME = "test-bot";
  process.env.GITLAB_REQUEST_TIMEOUT_MS = "200";
  process.env.GITLAB_MAX_RETRIES = "3";
  process.env.GITLAB_RETRY_BASE_MS = "20";
  process.env.GITLAB_RETRY_MAX_DELAY_MS = "80";

  ({ gitlab, api, apiForm, GitLabError } = await import("./client.ts"));
});

after(async () => {
  // closeAllConnections() : certains scénarios (serveur qui ne répond
  // jamais) laissent des sockets ouverts que server.close() attendrait sans
  // fin sinon.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  routes.clear();
});

describe("résilience réseau — lectures (idempotentes)", () => {
  test("un 429 avec Retry-After est respecté, pas juste le backoff par défaut", async () => {
    let calls = 0;
    routes.set("/api/v4/test/retry-after", (_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "1",
        });
        res.end(JSON.stringify({ message: "too many requests" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const start = Date.now();
    const result = await api<{ ok: boolean }>("/test/retry-after");
    const elapsed = Date.now() - start;

    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
    // Le backoff par défaut du test (base 20ms, plafond 80ms) ne peut pas
    // expliquer une attente de cet ordre : seul le Retry-After (1s) le peut.
    assert.ok(
      elapsed >= 900,
      `attente trop courte (${elapsed}ms) : Retry-After semble ignoré`,
    );
  });

  test("un 500 déclenche un backoff puis réussit", async () => {
    let calls = 0;
    routes.set("/api/v4/test/backoff", (_req, res) => {
      calls += 1;
      if (calls < 3) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "internal error" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ attempt: calls }));
    });

    const result = await api<{ attempt: number }>("/test/backoff");

    assert.deepEqual(result, { attempt: 3 });
    assert.equal(calls, 3);
  });

  test("un 404 n'est pas réessayé (erreur de permission/programmation, pas transitoire)", async () => {
    let calls = 0;
    routes.set("/api/v4/test/not-found", (_req, res) => {
      calls += 1;
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    });

    await assert.rejects(
      () => api("/test/not-found"),
      (error: unknown) => {
        assert.ok(error instanceof GitLabError);
        assert.equal(error.status, 404);
        return true;
      },
    );
    assert.equal(calls, 1, "un 404 ne doit déclencher qu'une seule tentative");
  });

  test("un serveur qui ne répond jamais déclenche le timeout au lieu de bloquer indéfiniment", async () => {
    routes.set("/api/v4/test/hang", () => {
      // Ne répond jamais : connexion acceptée, aucune écriture, aucun end().
    });

    const start = Date.now();
    await assert.rejects(() => api("/test/hang"));
    const elapsed = Date.now() - start;

    // Timeout 200ms × jusqu'à 4 tentatives (1 + GITLAB_MAX_RETRIES=3), avec
    // un backoff borné à 80ms entre chacune : large mais fini, très loin
    // d'un blocage éternel.
    assert.ok(
      elapsed < 3000,
      `n'a pas cédé dans un délai borné (${elapsed}ms) — semble bloquer indéfiniment`,
    );
  });
});

describe("écritures (POST) : jamais réessayées automatiquement — idempotence", () => {
  test("un 500 sur une écriture n'est pas réessayé", async () => {
    let calls = 0;
    routes.set("/api/v4/test/write-500", (_req, res) => {
      calls += 1;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "boom" }));
    });

    await assert.rejects(() =>
      api("/test/write-500", { method: "POST", body: "{}" }),
    );
    assert.equal(calls, 1);
  });

  test("un serveur qui pend sur une écriture timeout sans être réessayé (évite un commentaire publié deux fois)", async () => {
    let calls = 0;
    routes.set("/api/v4/test/write-hang", () => {
      calls += 1;
      // Ne répond jamais : on ne sait pas si GitLab a créé la ressource
      // avant de cesser de répondre — réessayer createNote() ici pourrait
      // publier le même commentaire une deuxième fois.
    });

    const start = Date.now();
    await assert.rejects(() =>
      api("/test/write-hang", { method: "POST", body: "{}" }),
    );
    const elapsed = Date.now() - start;

    assert.equal(
      calls,
      1,
      "une écriture ne doit jamais être réessayée après un timeout",
    );
    assert.ok(elapsed < 1000, `timeout attendu ~200ms, obtenu ${elapsed}ms`);
  });

  test("apiForm (createDiscussion...) n'est pas réessayé non plus sur un 429", async () => {
    let calls = 0;
    routes.set("/api/v4/test/write-429", (_req, res) => {
      calls += 1;
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "5",
      });
      res.end(JSON.stringify({ message: "slow down" }));
    });

    await assert.rejects(() => apiForm("/test/write-429", { a: 1 }));
    assert.equal(calls, 1);
  });
});

describe("pagination", () => {
  test("une collection paginée sur 3 pages est intégralement rapatriée (gitlab.pendingTodos)", async () => {
    const pageSize = 100;
    const total = 205;
    const allTodos = Array.from({ length: total }, (_, i) => makeTodo(i + 1));
    let calls = 0;

    routes.set("/api/v4/todos", (req, res) => {
      calls += 1;
      const url = new URL(req.url ?? "/", "http://localhost");
      assert.equal(url.searchParams.get("state"), "pending");
      const page = Number(url.searchParams.get("page") ?? "1");
      const slice = allTodos.slice((page - 1) * pageSize, page * pageSize);
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (page * pageSize < total) headers["x-next-page"] = String(page + 1);
      res.writeHead(200, headers);
      res.end(JSON.stringify(slice));
    });

    const result = await gitlab.pendingTodos();

    assert.equal(calls, 3);
    assert.equal(result.length, total);
    assert.deepEqual(
      result.map((t) => t.id),
      allTodos.map((t) => t.id),
    );
  });

  test("la borne maximale de pages est respectée (ne boucle pas indéfiniment)", async () => {
    let calls = 0;
    routes.set("/api/v4/todos", (req, res) => {
      calls += 1;
      const page = Number(
        new URL(req.url ?? "/", "http://localhost").searchParams.get("page") ??
          "1",
      );
      const slice = Array.from({ length: 100 }, (_, i) => makeTodo(page * 1000 + i));
      // Toujours une page suivante : simule une ressource qui ne se tarit
      // jamais (ou un bug côté API), pour vérifier qu'on ne pagine pas à
      // l'infini.
      res.writeHead(200, {
        "content-type": "application/json",
        "x-next-page": String(page + 1),
      });
      res.end(JSON.stringify(slice));
    });

    const result = await gitlab.pendingTodos();

    // MAX_TODO_PAGES dans gitlab/client.ts : 20 pages × 100 éléments.
    assert.equal(calls, 20);
    assert.equal(result.length, 2000);
  });
});
