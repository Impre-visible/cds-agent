import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import type { AgentRequest } from "../../src/types.ts";

// ack.ts importe (transitivement, via request.ts → gitlab/client.ts)
// src/config.ts, qui jette au chargement si GITLAB_TOKEN/BOT_USERNAME sont
// absents de l'environnement — mêmes astuce que request.test.ts/review.test.ts.
let ackBody: (request: AgentRequest, position: number) => string;

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  ({ ackBody } = await import("../../src/daemon/ack.ts"));
});

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

describe("ackBody — accusé de réception posté sur GitLab", () => {
  test("ne contient plus l'annonce de contrat de fiabilité de la file en mémoire", () => {
    const body = ackBody(makeRequest(), 1);
    assert.doesNotMatch(body, /non garantie/);
    assert.doesNotMatch(body, /file en mémoire/);
    assert.doesNotMatch(body, /redémarrage/);
  });

  test("cite toujours la demande exacte (défusée)", () => {
    const body = ackBody(makeRequest({ text: "merci de faire @autre-bot un truc" }), 1);
    assert.match(body, /> merci de faire `@autre-bot` un truc/);
  });

  test("cite le demandeur et indique 'traitement en cours' en position 1", () => {
    const body = ackBody(makeRequest({ requester: "bob" }), 1);
    assert.match(body, /@bob/);
    assert.match(body, /traitement en cours\./);
  });

  test("indique la position dans la file au-delà de 1", () => {
    const body = ackBody(makeRequest(), 3);
    assert.match(body, /mise en file d'attente, position 3\./);
  });

  test("contient toujours la clé d'idempotence de la demande", () => {
    const body = ackBody(makeRequest({ key: "note:99" }), 1);
    assert.match(body, /clé `note:99`/);
  });
});
