import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DiffFile, DiffRefs, MergeRequestContext } from "../types.ts";
import type { ValidatedRemark } from "./diff.ts";

// §5.5/§5.6 : publishReview() ne parle qu'HTTP (via gitlab/client.ts), donc
// on le vérifie contre un vrai serveur node:http jetable plutôt que contre un
// mock — plus proche de la réalité (vrai JSON.parse, vrai encodage
// x-www-form-urlencoded, vrai aller-retour réseau) et sans dépendance
// supplémentaire. Ce faux GitLab tient un état en mémoire (notes créées),
// pour vérifier que republier la même review ne les duplique pas.
//
// config.ts jette au chargement si GITLAB_TOKEN/BOT_USERNAME sont absents,
// et gitlabUrl est figé dans le module au premier import (cache ESM, un seul
// process par fichier de test — voir request.test.ts pour la même
// contrainte) : toutes les variables d'environnement sont donc posées AVANT
// le premier `await import("./publish.ts")`, une fois le serveur démarré et
// son port connu.

const BOT_USERNAME = "cds-agent-bot";

interface FakeNote {
  id: number;
  body: string;
  system: boolean;
  created_at: string;
  author: { id: number; username: string; name: string };
}

let notes: FakeNote[] = [];
let nextNoteId = 1;

// §5.4 : configurable par test, pour simuler soit une MR qui n'a pas bougé
// (SHA inchangés), soit une MR mise à jour pendant la review (SHA
// différents), soit une régénération transitoire de GitLab (tableau vide,
// voir currentDiffRefs dans publish.ts). Par défaut : une seule version,
// identique aux SHA "figés" que context() utilise ci-dessous.
let versions: {
  base_commit_sha: string;
  start_commit_sha: string;
  head_commit_sha: string;
}[] = [{ base_commit_sha: "base", start_commit_sha: "start", head_commit_sha: "head" }];

function addNote(body: string): FakeNote {
  const note: FakeNote = {
    id: nextNoteId++,
    body,
    system: false,
    created_at: new Date().toISOString(),
    author: { id: 999, username: BOT_USERNAME, name: "cds-agent" },
  };
  notes.push(note);
  return note;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

let publishReview: typeof import("./publish.ts").publishReview;
let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = url.pathname;

      if (req.method === "GET" && /\/merge_requests\/\d+\/versions$/.test(path)) {
        sendJson(res, 200, versions);
        return;
      }

      if (req.method === "GET" && /\/merge_requests\/\d+\/notes$/.test(path)) {
        // Une seule page en retour (pas d'en-tête x-next-page) : suffisant
        // pour ces tests, notesPage()/apiPage() s'arrêtent alors d'eux-mêmes.
        sendJson(res, 200, notes);
        return;
      }

      if (req.method === "POST" && path.endsWith("/discussions")) {
        const form = new URLSearchParams(raw);
        // Fichier marqueur : simule un refus GitLab (ex. position invalide),
        // pour exercer le repli "commentaire général" (niveau 3) et sa
        // propre déduplication par empreinte.
        if (form.get("position[new_path]") === "force-orphan.ts") {
          res.writeHead(422, { "Content-Type": "text/plain" });
          res.end("position rejetée (test)");
          return;
        }
        const note = addNote(form.get("body") ?? "");
        sendJson(res, 201, { id: `disc-${note.id}` });
        return;
      }

      if (req.method === "POST" && /\/notes$/.test(path)) {
        const parsed = raw ? (JSON.parse(raw) as { body?: unknown }) : {};
        const note = addNote(typeof parsed.body === "string" ? parsed.body : "");
        sendJson(res, 201, { id: note.id });
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("route non gérée par le faux GitLab");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME = BOT_USERNAME;
  process.env.GITLAB_URL = baseUrl;

  ({ publishReview } = await import("./publish.ts"));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  notes = [];
  nextNoteId = 1;
  versions = [
    { base_commit_sha: "base", start_commit_sha: "start", head_commit_sha: "head" },
  ];
});

function context(diffRefs: DiffRefs | null = null): MergeRequestContext {
  return {
    instanceUrl: baseUrl,
    projectId: 42,
    projectPath: "group/project",
    targetKind: "merge_requests",
    targetIid: 7,
    targetTitle: "Titre de la MR",
    targetDescription: "",
    requester: "alice",
    requestText: "fais une review",
    linkedIssue: null,
    diffRefs,
    files: [],
    sourceBranch: "feature",
  };
}

// Les SHA "figés" par buildContext() au moment (fictif) de la construction du
// contexte — antérieur à la publication, voir §5.4. Identiques par défaut à
// `versions` ci-dessus : la MR n'a pas bougé entre les deux.
const FROZEN_SHAS = { base_sha: "base", start_sha: "start", head_sha: "head" };

function file(path: string): DiffFile {
  return {
    old_path: path,
    new_path: path,
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    diff: "",
  };
}

// position: null → la remarque saute directement au niveau 2 (fichier) dans
// publishReview, sans passer par le niveau 1 (ligne) : un seul type d'appel
// à vérifier ("/discussions" en position_type=file), suffisant pour tester
// la déduplication elle-même, indépendante du niveau de repli retenu.
function remark(
  path: string,
  message: string,
  severity = "info",
): ValidatedRemark {
  return { file: file(path), position: null, severity, message };
}

describe("publishReview — idempotence (§5.5)", () => {
  test("publier deux fois la même review ne crée pas de doublon", async () => {
    const remarks = [
      remark("src/a.ts", "Manque un test pour le cas limite."),
      remark("src/b.ts", "Nom de variable peu clair."),
    ];

    const first = await publishReview(context(), remarks);
    assert.equal(first.length, 2);
    assert.equal(notes.length, 2);

    // Rejeu exact de la même review (relance de la commande, ou rejeu après
    // échec réseau) : rien de neuf ne doit partir vers GitLab.
    const second = await publishReview(context(), remarks);
    assert.equal(second.length, 0);
    assert.equal(notes.length, 2, "aucun commentaire supplémentaire créé");
  });

  test("une remarque réellement nouvelle est publiée, les autres restent ignorées", async () => {
    const remarkA = remark("src/a.ts", "Remarque A");
    const remarkB = remark("src/b.ts", "Remarque B");

    await publishReview(context(), [remarkA, remarkB]);
    assert.equal(notes.length, 2);

    const remarkC = remark("src/c.ts", "Remarque C, réellement nouvelle");
    const outcomes = await publishReview(context(), [remarkA, remarkB, remarkC]);

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.message, "Remarque C, réellement nouvelle");
    assert.equal(notes.length, 3);
  });

  test("le repli « commentaire général » (niveau 3) déduplique aussi", async () => {
    const orphan = remark("force-orphan.ts", "Remarque non positionnable");

    const first = await publishReview(context(), [orphan]);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.placement, "general");
    assert.equal(notes.length, 1);

    const second = await publishReview(context(), [orphan]);
    assert.equal(second.length, 0);
    assert.equal(notes.length, 1);
  });

  test("chaque commentaire publié porte une empreinte invisible, sans texte visible ajouté", async () => {
    await publishReview(context(), [remark("src/a.ts", "Une remarque.")]);
    const body = notes[0]?.body ?? "";
    assert.match(body, /<!-- cds-agent:fp:[0-9a-f]{12} -->/);
  });
});

describe("publishReview — texte non fiable neutralisé avant publication (§5.6)", () => {
  test("une mention dans le message d'une remarque ne notifie pas activement", async () => {
    await publishReview(context(), [
      remark("src/a.ts", "cc @equipe, à valider avant merge"),
    ]);
    const body = notes[0]?.body ?? "";
    assert.ok(body.includes("`@equipe`"));
    assert.ok(!/(?<!`)@equipe(?!`)/.test(body));
  });

  test("une ligne de message commençant par /close ne produit pas de quick action", async () => {
    await publishReview(context(), [remark("src/a.ts", "/close")]);
    const body = notes[0]?.body ?? "";
    // Le corps ne doit contenir aucune ligne qui commence littéralement par "/".
    for (const line of body.split("\n")) {
      assert.ok(!line.startsWith("/"), `ligne à risque : ${JSON.stringify(line)}`);
    }
  });

  test("une remarque qui mentionne /api/users au milieu d'une phrase reste intacte", async () => {
    await publishReview(context(), [
      remark("src/a.ts", "Le point d'entrée /api/users renvoie 404 sans body."),
    ]);
    const body = notes[0]?.body ?? "";
    assert.ok(body.includes("Le point d'entrée /api/users renvoie 404 sans body."));
  });
});

describe("publishReview — figeage des SHA contexte/publication (§5.4)", () => {
  test("cas nominal : la MR n'a pas bougé, la review est publiée comme avant (SHA figés réutilisés)", async () => {
    const outcomes = await publishReview(context(FROZEN_SHAS), [
      remark("src/a.ts", "Une remarque."),
    ]);

    assert.equal(outcomes.length, 1);
    assert.equal(notes.length, 1);
  });

  test("la MR a été mise à jour pendant la review : rien n'est publié, message explicite", async () => {
    // buildContext() a figé ces SHA il y a plusieurs minutes ; entre-temps,
    // quelqu'un a poussé un nouveau commit — /versions renvoie désormais un
    // head_sha différent.
    versions = [
      { base_commit_sha: "base", start_commit_sha: "start", head_commit_sha: "head-nouveau" },
    ];

    await assert.rejects(
      () =>
        publishReview(context(FROZEN_SHAS), [
          remark("src/a.ts", "Une remarque calculée sur l'ancien diff."),
        ]),
      /mise à jour pendant la review/,
    );

    // Rien ne doit avoir été publié sur la base de positions douteuses.
    assert.equal(notes.length, 0);
  });

  test("un changement de base_sha (rebase de la branche cible) est aussi détecté", async () => {
    versions = [
      { base_commit_sha: "base-nouveau", start_commit_sha: "start", head_commit_sha: "head" },
    ];

    await assert.rejects(
      () => publishReview(context(FROZEN_SHAS), [remark("src/a.ts", "Remarque")]),
      /mise à jour pendant la review/,
    );
    assert.equal(notes.length, 0);
  });

  test("régénération transitoire de diff_refs côté GitLab (pas de version exploitable) : on republie quand même sur les SHA figés", async () => {
    // Ne pas confondre avec une vraie mise à jour de la MR : /versions ne
    // renvoie ici temporairement rien d'exploitable (recontrôle de
    // mergeabilité en cours côté GitLab, voir context.ts), ce qui ne prouve
    // pas que la MR a bougé.
    versions = [];

    const outcomes = await publishReview(context(FROZEN_SHAS), [
      remark("src/a.ts", "Une remarque."),
    ]);

    assert.equal(outcomes.length, 1);
    assert.equal(notes.length, 1);
  });

  test("l'idempotence (§5.5) survit au figeage des SHA : republier la même review ne crée pas de doublon", async () => {
    const remarks = [remark("src/a.ts", "Manque un test pour le cas limite.")];

    const first = await publishReview(context(FROZEN_SHAS), remarks);
    assert.equal(first.length, 1);
    assert.equal(notes.length, 1);

    const second = await publishReview(context(FROZEN_SHAS), remarks);
    assert.equal(second.length, 0);
    assert.equal(notes.length, 1, "aucun commentaire supplémentaire créé");
  });

  test("context.diffRefs absent : résolution via mergeRequestVersions(), comme avant ce correctif", async () => {
    const outcomes = await publishReview(context(null), [
      remark("src/a.ts", "Une remarque."),
    ]);

    assert.equal(outcomes.length, 1);
    assert.equal(notes.length, 1);
  });
});
