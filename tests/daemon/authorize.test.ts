import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { AgentRequest } from "../../src/types.ts";

// authorize.ts importe src/config.ts, qui n'est évalué qu'une seule fois par
// URL de module (cache ESM) et qui jette au chargement si GITLAB_TOKEN ou
// BOT_USERNAME sont absents. Chaque scénario ci-dessous a besoin d'une
// combinaison différente de ALLOWED_PROJECTS / ALLOWED_USERS : un simple
// import dynamique avec un suffixe de requête (?case=...) ne suffit pas,
// car authorize.ts importe lui-même "../config.ts" sans suffixe — ce
// sous-import retomberait sur le module déjà mis en cache par le premier
// scénario testé. On isole donc chaque scénario dans un vrai sous-processus
// Node : environnement propre, graphe de modules entièrement frais. Les
// variables requises sont injectées explicitement, ce qui rend le test
// reproductible même sans .env local (CI).
const authorizeUrl = new URL("../../src/daemon/authorize.ts", import.meta.url).href;

function runAuthorize(
  env: Record<string, string>,
  request: AgentRequest,
): { allowed: boolean; reason?: string; silent?: boolean } {
  const script = [
    `import { authorize } from ${JSON.stringify(authorizeUrl)};`,
    `process.stdout.write(JSON.stringify(authorize(${JSON.stringify(request)})));`,
  ].join("\n");

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITLAB_TOKEN: "test-token",
      BOT_USERNAME: "test-bot",
      ALLOWED_PROJECTS: "",
      ALLOWED_USERS: "",
      ...env,
    },
  });

  if (result.status !== 0) {
    throw new Error(
      `sous-processus authorize.ts en échec (code ${result.status}) :\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as {
    allowed: boolean;
    reason?: string;
    silent?: boolean;
  };
}

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    key: "note:1",
    todoId: 1,
    projectId: 42,
    projectPath: "grp/repo",
    kind: "merge_requests",
    iid: 7,
    noteId: 1,
    requester: "alice",
    text: "@test-bot fais un truc",
    targetUrl: "https://gitlab.example/grp/repo/-/merge_requests/7#note_1",
    ...overrides,
  };
}

describe("authorize", () => {
  test("fail-closed : ALLOWED_PROJECTS vide refuse tout, même un utilisateur valide", () => {
    const result = runAuthorize(
      { ALLOWED_PROJECTS: "", ALLOWED_USERS: "alice" },
      makeRequest(),
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /ALLOWED_PROJECTS vide/);
  });

  test("fail-closed : ALLOWED_USERS vide refuse tout, même un dépôt valide", () => {
    const result = runAuthorize(
      { ALLOWED_PROJECTS: "grp/repo", ALLOWED_USERS: "" },
      makeRequest(),
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /ALLOWED_USERS vide/);
  });

  test("refuse un dépôt hors liste blanche", () => {
    const result = runAuthorize(
      { ALLOWED_PROJECTS: "grp/autre-repo", ALLOWED_USERS: "alice" },
      makeRequest(),
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /hors liste blanche/);
  });

  test("refuse un auteur hors liste blanche", () => {
    const result = runAuthorize(
      { ALLOWED_PROJECTS: "grp/repo", ALLOWED_USERS: "bob" },
      makeRequest({ requester: "alice" }),
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /@alice hors liste blanche/);
  });

  test("autorise quand le dépôt et l'auteur sont tous deux dans la liste blanche", () => {
    const result = runAuthorize(
      { ALLOWED_PROJECTS: "grp/repo", ALLOWED_USERS: "alice" },
      makeRequest(),
    );
    assert.equal(result.allowed, true);
  });

  test("la comparaison est insensible à la casse des deux côtés", () => {
    const result = runAuthorize(
      { ALLOWED_PROJECTS: "GRP/REPO", ALLOWED_USERS: "ALICE" },
      makeRequest({ projectPath: "Grp/Repo", requester: "Alice" }),
    );
    assert.equal(result.allowed, true);
  });
});

// §3.11 : le refus ne doit plus être uniformément silencieux — voir la doc
// du type Authorization dans authorize.ts pour le raisonnement complet.
describe("authorize — silence vs réponse explicite (§3.11)", () => {
  test("dépôt hors liste blanche : silencieux — répondre énumérerait les dépôts surveillés", () => {
    const result = runAuthorize(
      { ALLOWED_PROJECTS: "grp/autre-repo", ALLOWED_USERS: "alice" },
      makeRequest(),
    );
    assert.equal(result.allowed, false);
    assert.equal(result.silent, true);
  });

  test("ALLOWED_PROJECTS vide : silencieux, même chose qu'un dépôt hors périmètre", () => {
    const result = runAuthorize(
      { ALLOWED_PROJECTS: "", ALLOWED_USERS: "alice" },
      makeRequest(),
    );
    assert.equal(result.allowed, false);
    assert.equal(result.silent, true);
  });

  test("auteur hors liste blanche sur un dépôt AUTORISÉ : réponse explicite — c'est peut-être un collègue légitime", () => {
    const result = runAuthorize(
      { ALLOWED_PROJECTS: "grp/repo", ALLOWED_USERS: "bob" },
      makeRequest({ requester: "alice" }),
    );
    assert.equal(result.allowed, false);
    assert.equal(result.silent, false);
  });

  test("ALLOWED_USERS vide alors que le dépôt est autorisé : réponse explicite, pas silencieuse", () => {
    const result = runAuthorize(
      { ALLOWED_PROJECTS: "grp/repo", ALLOWED_USERS: "" },
      makeRequest(),
    );
    assert.equal(result.allowed, false);
    assert.equal(result.silent, false);
  });
});
