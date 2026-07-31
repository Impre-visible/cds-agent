import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { AgentRequest } from "../../src/types.ts";

// Même astuce que publish.test.ts/context.test.ts : un vrai serveur
// node:http jetable, GITLAB_URL pointé dessus avant l'import dynamique de
// config.ts/router.ts (qui jette au chargement si GITLAB_TOKEN/BOT_USERNAME
// sont absents).
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
const routes = new Map<string, Handler>();
let calls: string[] = [];

const BOT_USERNAME = "cds-bot";

let detectIntent: typeof import("../../src/tasks/router.ts").detectIntent;
let report: typeof import("../../src/tasks/router.ts").report;
let intentRefusalReason: typeof import("../../src/tasks/router.ts").intentRefusalReason;

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function fakeNote(id: number, body = ""): unknown {
  return {
    id,
    body,
    system: false,
    created_at: new Date().toISOString(),
    author: { id: 1, username: BOT_USERNAME, name: BOT_USERNAME },
  };
}

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const key = `${req.method} ${url.pathname}`;
    calls.push(key);
    const handler = routes.get(key);
    if (!handler) {
      respondJson(res, 404, { message: `route de test non enregistrée : ${key}` });
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
  process.env.BOT_USERNAME = BOT_USERNAME;
  process.env.GITLAB_REQUEST_TIMEOUT_MS = "500";
  process.env.GITLAB_MAX_RETRIES = "0";

  ({ detectIntent, report, intentRefusalReason } = await import("../../src/tasks/router.ts"));
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  routes.clear();
  calls = [];
});

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    key: "note:99",
    todoId: 1,
    projectId: 42,
    projectPath: "group/project",
    kind: "merge_requests",
    iid: 7,
    noteId: 99,
    requester: "alice",
    text: `@${BOT_USERNAME} fais une review`,
    targetUrl: "https://example.invalid/mr/7#note_99",
    ...overrides,
  };
}

describe("detectIntent (§6.9)", () => {
  test("commande explicite « @bot review » l'emporte sur un texte concurrent", () => {
    const text = `@${BOT_USERNAME} review — et pense aussi à implémenter des tests, ajoute-en si besoin`;
    assert.equal(detectIntent(text, BOT_USERNAME), "review");
  });

  test("commande explicite « @bot implement-tests »", () => {
    assert.equal(
      detectIntent(`@${BOT_USERNAME} implement-tests`, BOT_USERNAME),
      "implement",
    );
  });

  test("commande explicite tolère un peu de ponctuation entre la mention et le mot", () => {
    assert.equal(
      detectIntent(`@${BOT_USERNAME}, review stp`, BOT_USERNAME),
      "review",
    );
  });

  // §6.9 : le scénario qui motive ce correctif — une phrase qui mélange une
  // demande de revue avec une mention de tests déjà écrits. Sous l'ancien
  // code (implement vérifié en premier, sans exclusion mutuelle), le seul
  // mot "review" ne suffisait pas à l'emporter dès que le vocabulaire de
  // l'autre motif ("tests" + un verbe d'écriture) apparaissait aussi dans la
  // phrase — voir le test « régression » plus bas, qui le prouve directement
  // contre la logique non corrigée.
  test("scénario motivant §6.9 : review + tests écrits mentionnés, classé review (pas implement)", () => {
    const text = `@${BOT_USERNAME} peux-tu review cette MR et me dire si les tests que j'ai écrits sont bons ?`;
    assert.equal(detectIntent(text, BOT_USERNAME), "review");
  });

  test("phrase citée dans les tests attendus du chantier", () => {
    const text = `@${BOT_USERNAME} fais une review et dis-moi si les tests ajoutés sont bons`;
    assert.equal(detectIntent(text, BOT_USERNAME), "review");
  });

  test("demande d'implémentation en langage naturel, sans mot-clé review", () => {
    const text = `@${BOT_USERNAME} implémente les tests pour la route /hello/:name`;
    assert.equal(detectIntent(text, BOT_USERNAME), "implement");
  });

  test("texte incompréhensible → unknown", () => {
    assert.equal(
      detectIntent(`@${BOT_USERNAME} peux-tu jeter un oeil ?`, BOT_USERNAME),
      "unknown",
    );
  });

  // Preuve directe que l'ordre + l'exclusion mutuelle sont bien ce qui
  // corrige le bug (pas un effet de bord d'autre chose) : la même logique
  // que l'ancien code (implement testé en premier, sans exclusion) aurait
  // classé cette phrase "implement" — voir le commentaire de detectIntent.
  test("(régression) la logique non corrigée aurait classé le scénario motivant en implement", () => {
    const normalized = `peux-tu review cette mr et me dire si les tests que j'ai écrits sont bons ?`;
    const oldImplementRe = /impl[ée]ment|[ée]cri|ajoute|cr[ée]e|write|add/;
    const oldTestsRe = /\btests?\b/;
    // Documente le bug §6.9 : sous l'ancien ordre (implement vérifié avant
    // review, sans exclusion mutuelle), ce texte aurait été classé
    // "implement" — c'est justement ce que fallbackIntent() ne fait plus.
    assert.ok(oldTestsRe.test(normalized) && oldImplementRe.test(normalized));
  });
});

// Chantier "projects.json" : intentRefusalReason est le remplacement du
// détecteur d'intention historique — qui ne savait pas ce qui était permis —
// par un vrai contrôle de capacité, avant même de cloner le dépôt.
describe("intentRefusalReason (chantier « projects.json »)", () => {
  const ALL_GRANTED = {
    issue: { review: true, createMergeRequest: true, writeTests: true, writeBusinessCode: true },
    mergeRequest: {
      review: true,
      writeTests: true,
      writeBusinessCode: true,
      pushToSourceBranch: true,
      writablePaths: [],
    },
  };
  const NOTHING_GRANTED = {
    issue: { review: false, createMergeRequest: false, writeTests: false, writeBusinessCode: false },
    mergeRequest: {
      review: false,
      writeTests: false,
      writeBusinessCode: false,
      pushToSourceBranch: false,
      writablePaths: [],
    },
  };

  test("review permise pour une MR : null (aucun refus)", () => {
    assert.equal(intentRefusalReason("merge_requests", "review", ALL_GRANTED), null);
  });

  test("review absente pour une MR : refusée avec un message utile qui nomme la capacité", () => {
    const reason = intentRefusalReason("merge_requests", "review", NOTHING_GRANTED);
    assert.notEqual(reason, null);
    assert.match(reason ?? "", /revue/);
    assert.match(reason ?? "", /review/);
  });

  test("implement permis dès que writeTests OU writeBusinessCode est accordé", () => {
    assert.equal(
      intentRefusalReason("merge_requests", "implement", {
        issue: NOTHING_GRANTED.issue,
        mergeRequest: { ...NOTHING_GRANTED.mergeRequest, writeTests: true },
      }),
      null,
    );
    assert.equal(
      intentRefusalReason("merge_requests", "implement", {
        issue: NOTHING_GRANTED.issue,
        mergeRequest: { ...NOTHING_GRANTED.mergeRequest, writeBusinessCode: true },
      }),
      null,
    );
  });

  test("implement refusé, message utile, quand ni writeTests ni writeBusinessCode n'est accordé", () => {
    const reason = intentRefusalReason("merge_requests", "implement", NOTHING_GRANTED);
    assert.notEqual(reason, null);
    assert.match(reason ?? "", /writeTests/);
    assert.match(reason ?? "", /writeBusinessCode/);
  });

  test("la capacité vérifiée dépend bien du TYPE DE CIBLE (issue vs mergeRequest), pas d'un seul bloc global", () => {
    const onlyIssueGranted = {
      issue: ALL_GRANTED.issue,
      mergeRequest: NOTHING_GRANTED.mergeRequest,
    };
    assert.notEqual(intentRefusalReason("merge_requests", "review", onlyIssueGranted), null);
    assert.equal(intentRefusalReason("issues", "review", onlyIssueGranted), null);
  });
});

describe("report — édition de l'accusé de réception (§6.10)", () => {
  test("avec un ack connu : édite la note existante (PUT), n'en poste pas de nouvelle, et fait évoluer la réaction", async () => {
    routes.set("PUT /api/v4/projects/42/merge_requests/7/notes/501", (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => respondJson(res, 200, fakeNote(501)));
    });
    routes.set(
      "DELETE /api/v4/projects/42/merge_requests/7/notes/99/award_emoji/900",
      (_req, res) => {
        res.writeHead(204);
        res.end();
      },
    );
    let awardedName = "";
    routes.set(
      "POST /api/v4/projects/42/merge_requests/7/notes/99/award_emoji",
      (req, res) => {
        awardedName = new URL(req.url ?? "/", "http://localhost").searchParams.get("name") ?? "";
        respondJson(res, 201, { id: 901 });
      },
    );

    await report(request({ ack: { ackNoteId: 501, awardId: 900 } }), "résultat", true);

    assert.ok(calls.includes("PUT /api/v4/projects/42/merge_requests/7/notes/501"));
    assert.ok(
      !calls.includes("POST /api/v4/projects/42/merge_requests/7/notes"),
      "aucune note supplémentaire ne doit être créée quand l'édition réussit",
    );
    assert.ok(
      calls.includes("DELETE /api/v4/projects/42/merge_requests/7/notes/99/award_emoji/900"),
      "l'ancienne réaction 👀 doit être supprimée",
    );
    assert.equal(awardedName, "white_check_mark", "ok=true doit poser ✅");
  });

  test("ok=false pose ❌ plutôt que ✅", async () => {
    routes.set("PUT /api/v4/projects/42/merge_requests/7/notes/501", (_req, res) =>
      respondJson(res, 200, fakeNote(501)),
    );
    routes.set(
      "DELETE /api/v4/projects/42/merge_requests/7/notes/99/award_emoji/900",
      (_req, res) => {
        res.writeHead(204);
        res.end();
      },
    );
    let awardedName = "";
    routes.set(
      "POST /api/v4/projects/42/merge_requests/7/notes/99/award_emoji",
      (req, res) => {
        awardedName = new URL(req.url ?? "/", "http://localhost").searchParams.get("name") ?? "";
        respondJson(res, 201, { id: 902 });
      },
    );

    await report(request({ ack: { ackNoteId: 501, awardId: 900 } }), "échec", false);
    assert.equal(awardedName, "x");
  });

  test("édition impossible (note supprimée entre-temps) : republication d'une nouvelle note, le résultat n'est pas perdu", async () => {
    routes.set("PUT /api/v4/projects/42/merge_requests/7/notes/501", (_req, res) => {
      respondJson(res, 404, { message: "note not found" });
    });
    let createdBody = "";
    routes.set("POST /api/v4/projects/42/merge_requests/7/notes", (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          body: string;
        };
        createdBody = parsed.body;
        respondJson(res, 201, fakeNote(999, parsed.body));
      });
    });
    // Best-effort, même en repli : la réaction est quand même retentée.
    routes.set(
      "DELETE /api/v4/projects/42/merge_requests/7/notes/99/award_emoji/900",
      (_req, res) => {
        res.writeHead(204);
        res.end();
      },
    );
    routes.set(
      "POST /api/v4/projects/42/merge_requests/7/notes/99/award_emoji",
      (_req, res) => respondJson(res, 201, { id: 903 }),
    );

    await report(
      request({ ack: { ackNoteId: 501, awardId: 900 } }),
      "résultat important à ne pas perdre",
      false,
    );

    assert.ok(calls.includes("PUT /api/v4/projects/42/merge_requests/7/notes/501"));
    assert.ok(calls.includes("POST /api/v4/projects/42/merge_requests/7/notes"));
    assert.ok(
      createdBody.includes("résultat important à ne pas perdre"),
      "le résultat doit malgré tout être publié dans une note neuve",
    );
  });

  test("sans ack (dry-run, appel historique) : poste directement une nouvelle note, jamais de PUT ni de réaction", async () => {
    let created = false;
    routes.set("POST /api/v4/projects/42/merge_requests/7/notes", (_req, res) => {
      created = true;
      respondJson(res, 201, fakeNote(1));
    });

    await report(request(), "résultat", true);

    assert.ok(created);
    assert.ok(
      !calls.some((c) => c.includes("award_emoji")),
      "aucune réaction ne doit être touchée sans ack",
    );
  });

  test("réaction posée sur la ressource (mention en description, noteId null)", async () => {
    routes.set("PUT /api/v4/projects/42/merge_requests/7/notes/501", (_req, res) =>
      respondJson(res, 200, fakeNote(501)),
    );
    routes.set(
      "DELETE /api/v4/projects/42/merge_requests/7/award_emoji/900",
      (_req, res) => {
        res.writeHead(204);
        res.end();
      },
    );
    routes.set("POST /api/v4/projects/42/merge_requests/7/award_emoji", (_req, res) =>
      respondJson(res, 201, { id: 904 }),
    );

    await report(
      request({ noteId: null, ack: { ackNoteId: 501, awardId: 900 } }),
      "résultat",
      true,
    );

    assert.ok(calls.includes("DELETE /api/v4/projects/42/merge_requests/7/award_emoji/900"));
    assert.ok(calls.includes("POST /api/v4/projects/42/merge_requests/7/award_emoji"));
  });

  test("awardId null (réaction initiale non posée) : pas de suppression tentée, juste la pose de la nouvelle", async () => {
    routes.set("PUT /api/v4/projects/42/merge_requests/7/notes/501", (_req, res) =>
      respondJson(res, 200, fakeNote(501)),
    );
    routes.set(
      "POST /api/v4/projects/42/merge_requests/7/notes/99/award_emoji",
      (_req, res) => respondJson(res, 201, { id: 905 }),
    );

    await report(request({ ack: { ackNoteId: 501, awardId: null } }), "résultat", true);

    assert.ok(!calls.some((c) => c.startsWith("DELETE")));
    assert.ok(calls.includes("POST /api/v4/projects/42/merge_requests/7/notes/99/award_emoji"));
  });
});
