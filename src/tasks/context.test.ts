import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { AgentRequest, Note } from "../types.ts";

// Même astuce que gitlab/client.test.ts : un vrai serveur node:http jetable,
// GITLAB_URL pointé dessus avant l'import dynamique de config.ts/context.ts.
// Sert ici à rejouer *le scénario qui motive §3.5* de bout en bout, via le
// vrai chemin de production (buildContext -> loadLinkedIssue), plutôt que de
// tester la pagination en isolation : la preuve qu'on veut, c'est que ce
// sont bien les commentaires les plus récents qui atteignent le modèle.
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
const routes = new Map<string, Handler>();

let buildContext: typeof import("./context.ts").buildContext;

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handler = routes.get(url.pathname);
    if (!handler) {
      respondJson(res, 404, { message: `route de test non enregistrée : ${url.pathname}` });
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
  process.env.BOT_USERNAME = "cds-bot";
  process.env.GITLAB_REQUEST_TIMEOUT_MS = "500";
  process.env.GITLAB_MAX_RETRIES = "1";
  process.env.GITLAB_RETRY_BASE_MS = "10";
  process.env.GITLAB_RETRY_MAX_DELAY_MS = "20";

  ({ buildContext } = await import("./context.ts"));
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  routes.clear();
});

function note(id: number, body: string, opts: { system?: boolean; username?: string } = {}): Note {
  return {
    id,
    body,
    system: opts.system ?? false,
    created_at: new Date(2026, 0, 1, 0, 0, id).toISOString(),
    author: {
      id,
      username: opts.username ?? "alice",
      name: opts.username ?? "alice",
    },
  };
}

function issueRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    key: "issue:1:7",
    todoId: 1,
    projectId: 1,
    projectPath: "group/project",
    kind: "issues",
    iid: 7,
    noteId: null,
    requester: "bob",
    text: "@cds-bot fais une review",
    targetUrl: "https://example.invalid/issues/7",
    ...overrides,
  };
}

/**
 * Sert des notes paginées depuis un tableau construit en ordre
 * chronologique (le plus ancien en premier, comme l'API GitLab), en
 * respectant sort=asc/desc, per_page et page — exactement le contrat que
 * gitlab.notesPage() attend.
 */
function registerNotes(pathname: string, chronological: Note[]): { calls: number[] } {
  const stats = { calls: [] as number[] };
  let totalCalls = 0;

  routes.set(pathname, (req, res) => {
    totalCalls += 1;
    const url = new URL(req.url ?? "/", "http://localhost");
    const perPage = Number(url.searchParams.get("per_page") ?? "100");
    const page = Number(url.searchParams.get("page") ?? "1");
    const order = url.searchParams.get("sort") ?? "asc";

    const ordered = order === "desc" ? [...chronological].reverse() : chronological;
    const start = (page - 1) * perPage;
    const slice = ordered.slice(start, start + perPage);

    stats.calls.push(page);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (start + perPage < ordered.length) headers["x-next-page"] = String(page + 1);
    res.writeHead(200, headers);
    res.end(JSON.stringify(slice));
  });

  return stats;
}

describe("buildContext — chemin issue (§3.5 : recency des commentaires)", () => {
  test("sur un ticket de plus de 100 commentaires, ce sont les 15 derniers commentaires humains (dans l'ordre chronologique) qui atteignent le contexte", async () => {
    routes.set("/api/v4/projects/1/issues/7", (_req, res) => {
      respondJson(res, 200, {
        iid: 7,
        title: "Un vieux ticket très commenté",
        description: "description",
        author: { id: 2, username: "carol", name: "Carol" },
        web_url: "https://example.invalid/issues/7",
      });
    });

    // Construction (ordre chronologique, du plus ancien au plus récent) :
    // - 400 notes système anciennes (bruit)
    // - 5 commentaires humains plus anciens, qu'il faut malgré tout
    //   retrouver parmi les 15 derniers (ils tombent sur la page 2)
    // - 90 notes système (bruit, juste avant les tout derniers commentaires)
    // - 10 commentaires humains, les plus récents de tous
    const chronological: Note[] = [];
    for (let i = 1; i <= 400; i++) chronological.push(note(i, "bruit ancien", { system: true }));
    for (let i = 1; i <= 5; i++) chronological.push(note(400 + i, `OLDER-RECENT-${i}`));
    for (let i = 1; i <= 90; i++) chronological.push(note(405 + i, "bruit récent", { system: true }));
    for (let i = 1; i <= 10; i++) chronological.push(note(495 + i, `RECENT-${i}`));

    const stats = registerNotes("/api/v4/projects/1/issues/7/notes", chronological);

    const context = await buildContext(issueRequest());

    assert.ok(context.linkedIssue, "linkedIssue doit être renseigné");
    const expected = [
      "OLDER-RECENT-1",
      "OLDER-RECENT-2",
      "OLDER-RECENT-3",
      "OLDER-RECENT-4",
      "OLDER-RECENT-5",
      "RECENT-1",
      "RECENT-2",
      "RECENT-3",
      "RECENT-4",
      "RECENT-5",
      "RECENT-6",
      "RECENT-7",
      "RECENT-8",
      "RECENT-9",
      "RECENT-10",
    ].map((body) => `@alice: ${body}`);

    assert.deepEqual(context.linkedIssue?.comments, expected);

    // Preuve que ce n'est pas un rapatriement complet suivi d'un slice :
    // 505 notes tiennent sur 6 pages de 100, mais l'arrêt anticipé ne doit
    // en consommer que 2 (la deuxième page suffit à atteindre les 15
    // commentaires humains attendus).
    assert.deepEqual(stats.calls, [1, 2]);
  });

  test("les notes système et les notes du bot sont exclues des commentaires retenus", async () => {
    routes.set("/api/v4/projects/1/issues/7", (_req, res) => {
      respondJson(res, 200, {
        iid: 7,
        title: "Ticket",
        description: null,
        author: { id: 2, username: "carol", name: "Carol" },
        web_url: "https://example.invalid/issues/7",
      });
    });

    const chronological: Note[] = [
      note(1, "commentaire humain le plus ancien retenu"),
      note(2, "note système", { system: true }),
      note(3, "réponse automatique du bot", { username: "cds-bot" }),
      note(4, "CDS-BOT en majuscules, doit aussi être exclu", { username: "CDS-Bot" }),
      note(5, "dernier commentaire humain"),
    ];
    registerNotes("/api/v4/projects/1/issues/7/notes", chronological);

    const context = await buildContext(issueRequest());

    assert.deepEqual(context.linkedIssue?.comments, [
      "@alice: commentaire humain le plus ancien retenu",
      "@alice: dernier commentaire humain",
    ]);
  });
});

describe("buildContext — union discriminée sur targetKind (§6.8)", () => {
  test("un IssueContext n'expose pas sourceBranch : erreur de COMPILATION, pas une valeur null à vérifier à l'exécution", async () => {
    routes.set("/api/v4/projects/1/issues/7", (_req, res) => {
      respondJson(res, 200, {
        iid: 7,
        title: "Ticket",
        description: null,
        author: { id: 2, username: "carol", name: "Carol" },
        web_url: "https://example.invalid/issues/7",
      });
    });
    registerNotes("/api/v4/projects/1/issues/7/notes", []);

    const context = await buildContext(issueRequest());
    assert.equal(context.targetKind, "issues");

    if (context.targetKind === "issues") {
      // Preuve de l'union discriminée (§6.8) : dans ce bloc, TypeScript a
      // narrowé `context` en IssueContext, un type qui n'a tout simplement
      // pas de champ sourceBranch (voir types.ts) — contrairement à l'ancien
      // TaskContext à champs nullables, où `context.sourceBranch` valait
      // silencieusement `null` ici et fallait le vérifier à chaque site
      // d'appel. Retirer la directive juste en dessous ferait échouer
      // `npm run check` (l'accès deviendrait une vraie erreur de type) ; à
      // l'inverse, si cette garantie disparaissait (retour à un TaskContext
      // à champs nullables), la directive deviendrait superflue, ce que tsc
      // signale aussi comme une erreur (directive inutilisée) — la garantie
      // est donc vérifiée par la compilation, pas par une assertion ici.
      // @ts-expect-error : IssueContext n'a pas de champ sourceBranch (§6.8)
      const sourceBranch = context.sourceBranch;
      assert.equal(sourceBranch, undefined);
    }
  });
});
