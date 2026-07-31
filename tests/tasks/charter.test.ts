import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildCharter } from "../../src/tasks/charter.ts";
import type { ResolvedCapabilities } from "../../src/projects.ts";

/**
 * Chantier "planificateur" : la charte est GÉNÉRÉE depuis les capacités
 * résolues de projects.json (voir src/tasks/charter.ts) — ces tests vérifient
 * que ce qu'elle affirme reflète EXACTEMENT ces capacités, dans les deux sens
 * (une capacité accordée est mentionnée comme permise ; une capacité absente
 * est mentionnée comme interdite, jamais silencieusement omise).
 */
function capabilities(overrides: Partial<ResolvedCapabilities> = {}): ResolvedCapabilities {
  return {
    issue: {
      review: false,
      createMergeRequest: false,
      writeTests: false,
      writeBusinessCode: false,
    },
    mergeRequest: {
      review: false,
      writeTests: false,
      writeBusinessCode: false,
      pushToSourceBranch: false,
      writablePaths: [],
    },
    ...overrides,
  };
}

describe("buildCharter — merge request", () => {
  test("un dépôt par défaut (tests-only, dedicated-mr) n'affirme jamais pouvoir écrire du code métier", () => {
    const charter = buildCharter(
      "merge_requests",
      capabilities({
        mergeRequest: {
          review: true,
          writeTests: false,
          writeBusinessCode: false,
          pushToSourceBranch: false,
          writablePaths: [],
        },
      }),
    );

    assert.match(charter, /PAS le droit de modifier le code source de l'application/);
    assert.doesNotMatch(
      charter,
      /Tu peux modifier le code source de l'application, pas seulement les tests/,
    );
    assert.match(charter, /relire le code .* et proposer des remarques/);
    assert.match(charter, /merge request dédiée/);
  });

  test("writeBusinessCode accordé : la charte le dit explicitement, sans ambiguïté", () => {
    const charter = buildCharter(
      "merge_requests",
      capabilities({
        mergeRequest: {
          review: true,
          writeTests: true,
          writeBusinessCode: true,
          pushToSourceBranch: true,
          writablePaths: [],
        },
      }),
    );

    assert.match(
      charter,
      /Tu peux modifier le code source de l'application, pas seulement les tests/,
    );
    assert.doesNotMatch(charter, /PAS le droit de modifier le code source/);
    assert.match(charter, /poussé directement sur la branche source/);
  });

  test("writablePaths (motifs) : listés explicitement quand présents, absents sinon", () => {
    const withPatterns = buildCharter(
      "merge_requests",
      capabilities({
        mergeRequest: {
          review: true,
          writeTests: true,
          writeBusinessCode: false,
          pushToSourceBranch: false,
          writablePaths: ["src/generated/**", "docs/*.md"],
        },
      }),
    );
    assert.match(withPatterns, /src\/generated\/\*\*/);
    assert.match(withPatterns, /docs\/\*\.md/);

    const withoutPatterns = buildCharter(
      "merge_requests",
      capabilities({
        mergeRequest: {
          review: true,
          writeTests: true,
          writeBusinessCode: false,
          pushToSourceBranch: false,
          writablePaths: [],
        },
      }),
    );
    assert.doesNotMatch(withoutPatterns, /Tu peux aussi modifier les chemins suivants/);
  });

  test("règles universelles toujours présentes, quelle que soit la configuration : jamais de fusion par le bot lui-même", () => {
    const permissive = buildCharter(
      "merge_requests",
      capabilities({
        mergeRequest: {
          review: true,
          writeTests: true,
          writeBusinessCode: true,
          pushToSourceBranch: true,
          writablePaths: [],
        },
      }),
    );
    const restrictive = buildCharter("merge_requests", capabilities());

    for (const charter of [permissive, restrictive]) {
      assert.match(charter, /JAMAIS fusionner/);
      assert.match(charter, /jamais forcer un push/);
    }
  });

  test("review non accordée : la charte l'interdit explicitement", () => {
    const charter = buildCharter("merge_requests", capabilities());
    assert.match(charter, /PAS le droit de faire une revue de code sur ce dépôt/);
  });
});

describe("buildCharter — issue (non câblé aujourd'hui, mais généré pour rester prêt)", () => {
  test("reflète les capacités issue indépendamment des capacités mergeRequest", () => {
    const charter = buildCharter(
      "issues",
      capabilities({
        issue: {
          review: true,
          createMergeRequest: true,
          writeTests: true,
          writeBusinessCode: false,
        },
        mergeRequest: {
          review: false,
          writeTests: false,
          writeBusinessCode: true,
          pushToSourceBranch: false,
          writablePaths: [],
        },
      }),
    );

    assert.match(charter, /Tu peux analyser ce ticket et proposer une revue/);
    assert.match(charter, /Tu peux proposer l'ouverture d'une merge request/);
    assert.match(charter, /Tu peux écrire ou modifier des tests automatisés/);
    assert.match(charter, /PAS le droit de modifier le code source de l'application/);
  });
});
