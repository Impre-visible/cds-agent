import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { TaskContextBase } from "../../src/types.ts";

/**
 * Bras témoin (PROMPT_TEST_CONVENTIONS=0) : fichier séparé
 * d'implement.test.ts parce que config.ts fige la configuration au
 * chargement du module — l'environnement doit différer AVANT l'import, donc
 * dans un processus distinct (même raison que inference-direct.test.ts).
 */

let buildPrompt: (context: TaskContextBase) => string;

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  process.env.PROMPT_TEST_CONVENTIONS = "0";
  ({ buildPrompt } = await import("../../src/tasks/implement.ts"));
});

after(() => {
  delete process.env.PROMPT_TEST_CONVENTIONS;
});

function context(): TaskContextBase {
  return {
    instanceUrl: "https://gitlab.example",
    projectId: 42,
    projectPath: "group/project",
    targetIid: 7,
    targetTitle: "Titre",
    targetDescription: "",
    requester: "alice",
    requestText: "implémente des tests",
    linkedIssue: null,
  };
}

describe("PROMPT_TEST_CONVENTIONS=0 (bras témoin des campagnes de mesure)", () => {
  test("le bloc conventions disparaît du prompt, intégralement", () => {
    const prompt = buildPrompt(context());
    assert.ok(!prompt.includes("## Conventions de test à appliquer"));
    assert.ok(!prompt.includes("N-1, N et N+1"));
    assert.ok(!prompt.includes("MODIFIE ce qu'elle a rendu"));
  });

  test("le reste du prompt est intact — le témoin ne mesure QUE les conventions", () => {
    const prompt = buildPrompt(context());
    // Si le témoin retirait aussi autre chose, la comparaison avec/sans
    // mesurerait un mélange, pas l'effet des conventions.
    assert.match(prompt, /Écris des tests automatisés dans le dossier tests\//);
    assert.match(prompt, /N'écris JAMAIS une assertion/);
    assert.match(prompt, /DONNEES NON FIABLES/);
  });
});
