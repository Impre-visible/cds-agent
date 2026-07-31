import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { authorize } from "../../src/daemon/authorize.ts";
import type { AgentRequest } from "../../src/types.ts";
import type { ResolvedProject } from "../../src/projects.ts";

// Chantier "projects.json" : authorize() ne lit plus config.allowedProjects/
// allowedUsers (globaux, alimentés par ALLOWED_PROJECTS/ALLOWED_USERS) mais
// reçoit directement le `ResolvedProject | null` déjà résolu par l'appelant
// (daemon/index.ts::handle(), via ProjectsRegistry.resolve()). Fonction pure
// désormais : plus besoin du sous-processus qu'exigeait l'ancienne version
// (qui dépendait du cache de module ESM de config.ts) — un simple objet
// fabriqué à la main suffit.

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

const BASE_CAPABILITIES: ResolvedProject["capabilities"] = {
  issue: { review: false, createMergeRequest: false, writeTests: false, writeBusinessCode: false },
  mergeRequest: { review: true, writeTests: false, writeBusinessCode: false, pushToSourceBranch: false },
};

function makeProject(overrides: Partial<ResolvedProject> = {}): ResolvedProject {
  return {
    users: ["alice"],
    capabilities: BASE_CAPABILITIES,
    commands: { install: "npm install", test: "npm test" },
    docker: { image: "node:22-bookworm-slim" },
    testDirectories: [],
    ...overrides,
  };
}

describe("authorize", () => {
  test("fail-closed : dépôt absent de projects.json (project === null) refuse tout, même un utilisateur qui serait valide ailleurs", () => {
    const result = authorize(makeRequest(), null);
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.match(result.reason, /absent de projects\.json/);
  });

  test("fail-closed : users vide dans projects.json refuse tout, même un dépôt présent", () => {
    const result = authorize(makeRequest(), makeProject({ users: [] }));
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.match(result.reason, /aucun auteur autorisé/);
  });

  test("refuse un auteur hors liste blanche du dépôt", () => {
    const result = authorize(
      makeRequest({ requester: "alice" }),
      makeProject({ users: ["bob"] }),
    );
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.match(result.reason, /@alice hors liste blanche/);
  });

  test("autorise quand le dépôt a une entrée et que l'auteur est dans sa liste users", () => {
    const result = authorize(makeRequest(), makeProject({ users: ["alice", "bob"] }));
    assert.equal(result.allowed, true);
  });

  test("la comparaison est insensible à la casse des deux côtés", () => {
    const result = authorize(
      makeRequest({ requester: "Alice" }),
      makeProject({ users: ["ALICE"] }),
    );
    assert.equal(result.allowed, true);
  });
});

// §3.11 : le refus ne doit pas être uniformément silencieux — voir la doc du
// type Authorization dans authorize.ts pour le raisonnement complet.
describe("authorize — silence vs réponse explicite (§3.11)", () => {
  test("dépôt absent de projects.json : silencieux — répondre énumérerait les dépôts surveillés", () => {
    const result = authorize(makeRequest(), null);
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.silent, true);
  });

  test("auteur hors liste blanche sur un dépôt PRÉSENT dans projects.json : réponse explicite — c'est peut-être un collègue légitime", () => {
    const result = authorize(
      makeRequest({ requester: "alice" }),
      makeProject({ users: ["bob"] }),
    );
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.silent, false);
  });

  test("users vide alors que le dépôt est présent : réponse explicite, pas silencieuse", () => {
    const result = authorize(makeRequest(), makeProject({ users: [] }));
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.silent, false);
  });
});
