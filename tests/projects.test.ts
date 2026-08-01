import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProjectsFile,
  resolveProject,
  repoCapabilitiesFor,
  loadProjectsFile,
  firstProjectPath,
  ProjectsRegistry,
  type ProjectsBaseline,
} from "../src/projects.ts";
import { authorize } from "../src/daemon/authorize.ts";
import { DEFAULT_CAPABILITIES, isWritablePath } from "../src/tasks/guard.ts";
import type { AgentRequest } from "../src/types.ts";

const BASELINE: ProjectsBaseline = {
  commands: { install: "npm install", test: "npm test" },
  docker: { image: "node:22-bookworm-slim" },
};

/** La forme validée donnée par le propriétaire du chantier, telle quelle. */
const EXAMPLE = {
  defaults: {
    capabilities: {
      issue: { review: false, createMergeRequest: false, writeTests: false, writeBusinessCode: false },
      mergeRequest: { review: true, writeTests: false, writeBusinessCode: false, pushToSourceBranch: false },
    },
    commands: { install: "npm install", test: "npm test" },
    docker: { image: "node:22-bookworm-slim" },
  },
  projects: {
    "groupe/depot-a": {
      users: ["alice", "bob"],
      capabilities: {
        issue: { createMergeRequest: true, writeBusinessCode: true, writeTests: true },
        mergeRequest: { review: true, writeTests: true },
      },
      commands: { test: "pytest -q" },
      docker: { image: "python:3.12-slim" },
    },
  },
};

describe("parseProjectsFile — validation", () => {
  test("l'exemple donné par le propriétaire du chantier est valide", () => {
    assert.doesNotThrow(() => parseProjectsFile(EXAMPLE));
  });

  test('"projects" est obligatoire, même vide (fail-closed : rien n\'est alors autorisé)', () => {
    assert.throws(() => parseProjectsFile({}), /"projects" est obligatoire/);
    assert.doesNotThrow(() => parseProjectsFile({ projects: {} }));
  });

  test("le contenu doit être un objet JSON", () => {
    assert.throws(() => parseProjectsFile([]), /objet JSON/);
    assert.throws(() => parseProjectsFile("texte"), /objet JSON/);
    assert.throws(() => parseProjectsFile(null), /objet JSON/);
  });

  test("une clé inconnue au premier niveau est nommée dans le message", () => {
    assert.throws(
      () => parseProjectsFile({ projects: {}, defalts: {} }),
      /clé inconnue ".defalts"/,
    );
  });

  test("une clé inconnue dans une entrée de projet est nommée", () => {
    assert.throws(
      () => parseProjectsFile({ projects: { "g/p": { userz: ["a"] } } }),
      /clé inconnue "projects\["g\/p"\]\.userz"/,
    );
  });

  test('une clé de capacité inconnue ou mal orthographiée échoue en la nommant (règle 1 : jamais un "false" silencieux)', () => {
    assert.throws(
      () =>
        parseProjectsFile({
          projects: { "g/p": { capabilities: { mergeRequest: { writeTest: true } } } },
        }),
      (error: Error) => {
        assert.match(error.message, /writeTest/);
        assert.match(error.message, /mergeRequest/);
        return true;
      },
    );
  });

  test("une capacité inconnue dans defaults est également rejetée", () => {
    assert.throws(
      () => parseProjectsFile({ defaults: { capabilities: { issue: { reviw: true } } }, projects: {} }),
      /reviw/,
    );
  });

  test("une valeur de capacité non booléenne est rejetée", () => {
    assert.throws(
      () =>
        parseProjectsFile({
          projects: { "g/p": { capabilities: { mergeRequest: { writeTests: "oui" } } } },
        }),
      /booléen/,
    );
  });

  test("une commande vide ou non-chaîne est rejetée", () => {
    assert.throws(
      () => parseProjectsFile({ projects: { "g/p": { commands: { test: "" } } } }),
      /chaîne non vide/,
    );
    assert.throws(
      () => parseProjectsFile({ projects: { "g/p": { commands: { test: 42 } } } }),
      /chaîne non vide/,
    );
  });

  test("un dépôt déclaré deux fois (insensible à la casse) est rejeté", () => {
    assert.throws(
      () => parseProjectsFile({ projects: { "Groupe/Depot": {}, "groupe/depot": {} } }),
      /déclaré plusieurs fois/,
    );
  });

  test("users doit être un tableau de chaînes non vides", () => {
    assert.throws(
      () => parseProjectsFile({ projects: { "g/p": { users: "alice" } } }),
      /tableau/,
    );
    assert.throws(
      () => parseProjectsFile({ projects: { "g/p": { users: [""] } } }),
      /tableau/,
    );
  });

  test("testDirectories doit être un tableau de chaînes non vides", () => {
    assert.throws(
      () => parseProjectsFile({ projects: { "g/p": { testDirectories: "e2e" } } }),
      /tableau/,
    );
  });
});

// ---------------------------------------------------------------------------
// Chantier "capacités par motifs" — restaure l'entre-deux entre writeTests
// (chemins de test uniquement) et writeBusinessCode (dépôt entier) que
// l'ancien AGENT_CAPABILITIES exprimait via write:src/**|lib/**.
// ---------------------------------------------------------------------------
describe("commands.assertionPattern (fichier cassé ≠ assertion en échec, voir implement.ts)", () => {
  test("accepté dans defaults comme par projet, résolu avec priorité au projet", () => {
    const file = parseProjectsFile({
      defaults: { commands: { assertionPattern: "DEFAUT: \\d+" } },
      projects: {
        "g/p": { users: ["alice"], commands: { assertionPattern: "PROJET: \\d+" } },
        "g/q": { users: ["alice"] },
      },
    });
    assert.equal(resolveProject(file, "g/p", BASELINE)!.commands.assertionPattern, "PROJET: \\d+");
    assert.equal(resolveProject(file, "g/q", BASELINE)!.commands.assertionPattern, "DEFAUT: \\d+");
  });

  test("absent partout : résolu undefined — c'est implement.ts qui porte le défaut", () => {
    const file = parseProjectsFile({ projects: { "g/p": { users: ["alice"] } } });
    assert.equal(resolveProject(file, "g/p", BASELINE)!.commands.assertionPattern, undefined);
  });

  test("une regex invalide est refusée AU CHARGEMENT, en nommant le champ", () => {
    assert.throws(
      () => parseProjectsFile({ projects: { "g/p": { commands: { assertionPattern: "(" } } } }),
      /assertionPattern.*regex/,
    );
  });

  test("chaîne vide refusée, comme install et test", () => {
    assert.throws(
      () => parseProjectsFile({ projects: { "g/p": { commands: { assertionPattern: "" } } } }),
      /chaîne non vide/,
    );
  });
});

describe("mergeRequest.writablePaths — parsing et formedness des motifs", () => {
  test("un projet avec writeTests: true et des motifs valides est accepté", () => {
    assert.doesNotThrow(() =>
      parseProjectsFile({
        projects: {
          "g/p": {
            capabilities: {
              mergeRequest: { writeTests: true, writablePaths: ["src/generated/**", "docs/*.md"] },
            },
          },
        },
      }),
    );
  });

  test("writablePaths doit être un tableau de chaînes non vides", () => {
    assert.throws(
      () =>
        parseProjectsFile({
          projects: { "g/p": { capabilities: { mergeRequest: { writeTests: true, writablePaths: "src/**" } } } },
        }),
      /tableau/,
    );
  });

  test("un motif absolu (commence par \"/\") est rejeté en le citant", () => {
    assert.throws(
      () =>
        parseProjectsFile({
          projects: {
            "g/p": { capabilities: { mergeRequest: { writeTests: true, writablePaths: ["/src/**"] } } },
          },
        }),
      (error: Error) => {
        assert.match(error.message, /motif mal formé/);
        assert.match(error.message, /\/src\/\*\*/);
        return true;
      },
    );
  });

  test('un motif avec un composant "." ou ".." est rejeté', () => {
    assert.throws(
      () =>
        parseProjectsFile({
          projects: {
            "g/p": {
              capabilities: { mergeRequest: { writeTests: true, writablePaths: ["src/../etc/**"] } },
            },
          },
        }),
      /motif mal formé/,
    );
  });

  test("un motif avec un caractère hors du sous-ensemble glob supporté (\"?\") est rejeté", () => {
    assert.throws(
      () =>
        parseProjectsFile({
          projects: {
            "g/p": { capabilities: { mergeRequest: { writeTests: true, writablePaths: ["src/foo?.ts"] } } },
          },
        }),
      /motif mal formé/,
    );
  });

  test("writablePaths mal orthographié (\"writablePath\") échoue en le nommant, comme toute clé inconnue", () => {
    assert.throws(
      () =>
        parseProjectsFile({
          projects: { "g/p": { capabilities: { mergeRequest: { writablePath: ["src/**"] } } } },
        }),
      /clé inconnue ".*writablePath"/,
    );
  });
});

describe("mergeRequest.writablePaths — combinaisons incohérentes rejetées au chargement", () => {
  test("writeBusinessCode: true ET des motifs non vides, dans le même bloc : rejeté", () => {
    assert.throws(
      () =>
        parseProjectsFile({
          projects: {
            "g/p": {
              capabilities: {
                mergeRequest: { writeBusinessCode: true, writeTests: true, writablePaths: ["src/**"] },
              },
            },
          },
        }),
      (error: Error) => {
        assert.match(error.message, /incohérent/);
        assert.match(error.message, /writeBusinessCode/);
        return true;
      },
    );
  });

  test("writeBusinessCode dans defaults, motifs dans le projet (croisement entre les deux blocs) : rejeté aussi", () => {
    assert.throws(
      () =>
        parseProjectsFile({
          defaults: { capabilities: { mergeRequest: { writeBusinessCode: true } } },
          projects: {
            "g/p": { capabilities: { mergeRequest: { writeTests: true, writablePaths: ["src/**"] } } },
          },
        }),
      /incohérent/,
    );
  });

  test("motifs dans defaults, writeBusinessCode dans le projet (l'autre sens du croisement) : rejeté", () => {
    assert.throws(
      () =>
        parseProjectsFile({
          defaults: { capabilities: { mergeRequest: { writeTests: true, writablePaths: ["src/**"] } } },
          projects: {
            "g/p": { capabilities: { mergeRequest: { writeBusinessCode: true } } },
          },
        }),
      /incohérent/,
    );
  });

  test("des motifs non vides ET writeTests: false : rejeté (les motifs élargissent toujours aussi les tests)", () => {
    assert.throws(
      () =>
        parseProjectsFile({
          projects: {
            "g/p": {
              capabilities: { mergeRequest: { writeTests: false, writablePaths: ["src/**"] } },
            },
          },
        }),
      (error: Error) => {
        assert.match(error.message, /incohérent/);
        assert.match(error.message, /writeTests/);
        return true;
      },
    );
  });

  test("des motifs non vides sans writeTests déclaré nulle part (défaut false hérité) : rejeté aussi", () => {
    assert.throws(
      () =>
        parseProjectsFile({
          projects: { "g/p": { capabilities: { mergeRequest: { writablePaths: ["src/**"] } } } },
        }),
      /incohérent/,
    );
  });

  test("writeBusinessCode seul (sans motifs) reste accepté : pas de régression sur le cas déjà couvert", () => {
    assert.doesNotThrow(() =>
      parseProjectsFile({
        projects: { "g/p": { capabilities: { mergeRequest: { writeBusinessCode: true } } } },
      }),
    );
  });

  test("« defaults » seul, déjà incohérent, échoue même sans aucun projet déclaré qui en hérite tel quel", () => {
    assert.throws(
      () =>
        parseProjectsFile({
          defaults: {
            capabilities: { mergeRequest: { writeBusinessCode: true, writablePaths: ["src/**"] } },
          },
          projects: {},
        }),
      /defaults\.capabilities\.mergeRequest/,
    );
  });
});

describe("resolveProject / repoCapabilitiesFor — motifs bout en bout", () => {
  test("writeTests + motifs : resolveProject reflète les motifs, repoCapabilitiesFor les traduit fidèlement", () => {
    const file = parseProjectsFile({
      projects: {
        "g/p": {
          capabilities: {
            mergeRequest: { writeTests: true, writablePaths: ["src/generated/**"], pushToSourceBranch: true },
          },
        },
      },
    });
    const resolved = resolveProject(file, "g/p", BASELINE)!;
    assert.deepEqual(resolved.capabilities.mergeRequest.writablePaths, ["src/generated/**"]);

    const capabilities = repoCapabilitiesFor(resolved.capabilities.mergeRequest);
    assert.deepEqual(capabilities, {
      writablePaths: ["src/generated/**"],
      publishMode: "source-branch",
    });

    // Bout en bout avec isWritablePath (tasks/guard.ts) : le motif élargit
    // précisément, les chemins de test restent accordés en plus, et le
    // rejet des composants "."/".." reste inconditionnel — même invariant
    // que testé isolément dans guard.test.ts, vérifié ici via la vraie
    // capacité produite par la configuration, pas un objet fabriqué à la main.
    assert.equal(isWritablePath("src/generated/schema.ts", capabilities), true);
    assert.equal(isWritablePath("tests/foo.test.ts", capabilities), true);
    assert.equal(isWritablePath("src/server.ts", capabilities), false);
    assert.equal(isWritablePath("src/generated/../../etc/passwd", capabilities), false);
  });

  test("un projet qui ne déclare pas de motifs garde le comportement inchangé (tableau vide, tests-only)", () => {
    const file = parseProjectsFile({
      projects: { "g/p": { capabilities: { mergeRequest: { writeTests: true } } } },
    });
    const resolved = resolveProject(file, "g/p", BASELINE)!;
    assert.deepEqual(resolved.capabilities.mergeRequest.writablePaths, []);
    assert.deepEqual(repoCapabilitiesFor(resolved.capabilities.mergeRequest).writablePaths, "tests-only");
  });

  test("projet sans capacités déclarées du tout : writablePaths résolu à [] (fail-closed), pas undefined", () => {
    const minimal = parseProjectsFile({ projects: { "g/p": { users: ["alice"] } } });
    const resolved = resolveProject(minimal, "g/p", BASELINE)!;
    assert.deepEqual(resolved.capabilities.mergeRequest.writablePaths, []);
  });
});

describe("resolveProject — fusion en profondeur defaults / projet", () => {
  const file = parseProjectsFile(EXAMPLE);

  test("un dépôt absent de « projects » est refusé (null, fail-closed)", () => {
    assert.equal(resolveProject(file, "groupe/depot-inconnu", BASELINE), null);
  });

  test("insensible à la casse du chemin de dépôt", () => {
    assert.notEqual(resolveProject(file, "GROUPE/DEPOT-A", BASELINE), null);
  });

  test("un champ de capacité NON surchargé par le projet retombe sur defaults, pas sur un booléen implicite", () => {
    const resolved = resolveProject(file, "groupe/depot-a", BASELINE)!;
    // depot-a ne surcharge que mergeRequest.review/writeTests : writeBusinessCode
    // et pushToSourceBranch doivent provenir de "defaults", pas être réinitialisés.
    assert.equal(resolved.capabilities.mergeRequest.review, true);
    assert.equal(resolved.capabilities.mergeRequest.writeTests, true);
    assert.equal(resolved.capabilities.mergeRequest.writeBusinessCode, false);
    assert.equal(resolved.capabilities.mergeRequest.pushToSourceBranch, false);
  });

  test("la fusion des capacités est un champ par champ, pas un remplacement du bloc entier", () => {
    const resolved = resolveProject(file, "groupe/depot-a", BASELINE)!;
    // depot-a ne mentionne PAS issue.review : doit rester celui de defaults (false).
    assert.equal(resolved.capabilities.issue.review, false);
    assert.equal(resolved.capabilities.issue.createMergeRequest, true);
    assert.equal(resolved.capabilities.issue.writeBusinessCode, true);
    assert.equal(resolved.capabilities.issue.writeTests, true);
  });

  test("commands : seul le champ surchargé change, l'autre vient de defaults", () => {
    const resolved = resolveProject(file, "groupe/depot-a", BASELINE)!;
    assert.equal(resolved.commands.test, "pytest -q");
    // "install" n'est pas surchargé par depot-a : vient de defaults.commands.install.
    assert.equal(resolved.commands.install, "npm install");
  });

  test("docker.image : surcharge par projet prioritaire sur defaults", () => {
    const resolved = resolveProject(file, "groupe/depot-a", BASELINE)!;
    assert.equal(resolved.docker.image, "python:3.12-slim");
  });

  test("un dépôt qui ne surcharge ni commands ni docker retombe sur defaults, puis sur le baseline", () => {
    const withOnlyDefaults = parseProjectsFile({
      defaults: { commands: { test: "mvn test" } },
      projects: { "g/p": {} },
    });
    const resolved = resolveProject(withOnlyDefaults, "g/p", BASELINE)!;
    assert.equal(resolved.commands.test, "mvn test"); // depuis "defaults"
    assert.equal(resolved.commands.install, BASELINE.commands.install); // depuis le baseline
    assert.equal(resolved.docker.image, BASELINE.docker.image); // depuis le baseline
  });

  test("testDirectories : projet > defaults > tableau vide", () => {
    const withProjectOverride = parseProjectsFile({
      defaults: { testDirectories: ["fixtures"] },
      projects: { a: { testDirectories: ["e2e", "acceptance"] }, b: {} },
    });
    assert.deepEqual(resolveProject(withProjectOverride, "a", BASELINE)!.testDirectories, [
      "e2e",
      "acceptance",
    ]);
    assert.deepEqual(resolveProject(withProjectOverride, "b", BASELINE)!.testDirectories, [
      "fixtures",
    ]);

    const withoutAnyOverride = parseProjectsFile({ projects: { c: {} } });
    assert.deepEqual(resolveProject(withoutAnyOverride, "c", BASELINE)!.testDirectories, []);
  });

  test("un projet sans capacités déclarées du tout retombe sur le tout-refusé (fail-closed), pas un accès implicite", () => {
    const minimal = parseProjectsFile({ projects: { "g/p": { users: ["alice"] } } });
    const resolved = resolveProject(minimal, "g/p", BASELINE)!;
    assert.equal(resolved.capabilities.mergeRequest.review, false);
    assert.equal(resolved.capabilities.mergeRequest.writeTests, false);
    assert.equal(resolved.capabilities.mergeRequest.writeBusinessCode, false);
  });
});

describe("ProjectsRegistry — chargement, fail-closed au démarrage", () => {
  let dir: string;

  function writeProjectsJson(content: unknown): string {
    dir = mkdtempSync(join(tmpdir(), "cds-agent-projects-test-"));
    const path = join(dir, "projects.json");
    writeFileSync(path, JSON.stringify(content), "utf8");
    return path;
  }

  test("fichier absent : échoue en nommant le chemin (le daemon ne démarre pas)", () => {
    const missing = join(tmpdir(), "cds-agent-projects-inexistant.json");
    assert.throws(() => ProjectsRegistry.loadFromPath(missing), (error: Error) => {
      assert.match(error.message, /introuvable ou illisible/);
      assert.match(error.message, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
  });

  test("JSON syntaxiquement invalide : échoue en le disant", () => {
    dir = mkdtempSync(join(tmpdir(), "cds-agent-projects-test-"));
    const path = join(dir, "projects.json");
    writeFileSync(path, "{ ceci n'est pas du JSON", "utf8");
    try {
      assert.throws(() => ProjectsRegistry.loadFromPath(path), /JSON invalide/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("schéma invalide (clé de capacité inconnue) : échoue en la nommant", () => {
    const path = writeProjectsJson({
      projects: { "g/p": { capabilities: { mergeRequest: { writeAll: true } } } },
    });
    try {
      assert.throws(() => ProjectsRegistry.loadFromPath(path), /writeAll/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fichier valide : chargement réussi, resolve() fonctionne", () => {
    const path = writeProjectsJson(EXAMPLE);
    try {
      const registry = ProjectsRegistry.loadFromPath(path);
      assert.notEqual(registry.resolve("groupe/depot-a", BASELINE), null);
      assert.equal(registry.resolve("groupe/depot-z", BASELINE), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ProjectsRegistry — rechargement à chaud", () => {
  let dir: string;
  let path: string;

  function write(content: unknown): void {
    writeFileSync(path, JSON.stringify(content), "utf8");
  }

  test("aucun changement de contenu : reloadIfChanged() ne recharge pas", () => {
    dir = mkdtempSync(join(tmpdir(), "cds-agent-projects-reload-"));
    path = join(dir, "projects.json");
    write({ projects: { "g/p": { users: ["alice"] } } });
    try {
      const registry = ProjectsRegistry.loadFromPath(path);
      const result = registry.reloadIfChanged(path);
      assert.equal(result.reloaded, false);
      assert.equal(result.error, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("contenu changé : reloadIfChanged() recharge, resolve() reflète le nouveau contenu au cycle suivant", () => {
    dir = mkdtempSync(join(tmpdir(), "cds-agent-projects-reload-"));
    path = join(dir, "projects.json");
    write({ projects: { "g/p": { users: ["alice"] } } });
    try {
      const registry = ProjectsRegistry.loadFromPath(path);
      assert.equal(registry.resolve("g/p", BASELINE)!.users.length, 1);

      write({ projects: { "g/p": { users: ["alice", "bob"] } } });
      const result = registry.reloadIfChanged(path);
      assert.equal(result.reloaded, true);
      assert.deepEqual(registry.resolve("g/p", BASELINE)!.users, ["alice", "bob"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fichier devenu invalide en cours de route : la dernière configuration valide reste en vigueur, l'erreur est renvoyée (jamais jetée)", () => {
    dir = mkdtempSync(join(tmpdir(), "cds-agent-projects-reload-"));
    path = join(dir, "projects.json");
    write({ projects: { "g/p": { users: ["alice"] } } });
    try {
      const registry = ProjectsRegistry.loadFromPath(path);
      const before = registry.resolve("g/p", BASELINE);

      write({ projects: { "g/p": { capabilities: { mergeRequest: { bogus: true } } } } });
      const result = registry.reloadIfChanged(path);

      assert.equal(result.reloaded, false, "un rechargement invalide ne doit jamais être signalé comme réussi");
      assert.ok(result.error, "l'erreur doit être renvoyée, pas avalée");
      assert.match(result.error!.message, /bogus/);

      // La configuration précédente (valide) reste en vigueur, à l'identique.
      assert.deepEqual(registry.resolve("g/p", BASELINE), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("« capacités figées pour une demande en cours » : un objet déjà résolu ne change jamais rétroactivement, même après un rechargement", () => {
    dir = mkdtempSync(join(tmpdir(), "cds-agent-projects-reload-"));
    path = join(dir, "projects.json");
    write({
      projects: { "g/p": { users: ["alice"], capabilities: { mergeRequest: { writeTests: false } } } },
    });
    try {
      const registry = ProjectsRegistry.loadFromPath(path);
      // Simule daemon/index.ts::handle() : résolu UNE FOIS au début du
      // traitement d'une demande, avant que le cycle de polling suivant ne
      // recharge éventuellement le fichier.
      const frozenForOngoingRequest = registry.resolve("g/p", BASELINE)!;

      write({
        projects: { "g/p": { users: ["alice"], capabilities: { mergeRequest: { writeTests: true } } } },
      });
      registry.reloadIfChanged(path);

      // L'objet déjà capturé par la demande en cours n'a pas bougé : ce
      // n'est qu'une nouvelle résolution (un nouveau cycle, une nouvelle
      // demande) qui verrait le changement.
      assert.equal(frozenForOngoingRequest.capabilities.mergeRequest.writeTests, false);
      assert.equal(registry.resolve("g/p", BASELINE)!.capabilities.mergeRequest.writeTests, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadProjectsFile / firstProjectPath (outils dry-run)", () => {
  test("firstProjectPath renvoie le premier dépôt dans l'ordre du fichier", () => {
    const file = parseProjectsFile({ projects: { "b/b": {}, "a/a": {} } });
    assert.equal(firstProjectPath(file), "b/b");
  });

  test("loadProjectsFile est fatal si le fichier est absent", () => {
    assert.throws(() => loadProjectsFile(join(tmpdir(), "cds-agent-inexistant.json")));
  });
});

// ---------------------------------------------------------------------------
// Iso-comportement : une projects.json équivalente à l'ancienne configuration
// (variables d'environnement) doit produire EXACTEMENT les mêmes décisions.
// ---------------------------------------------------------------------------
describe("iso-comportement avec l'ancienne configuration par variables d'environnement", () => {
  function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
    return {
      key: "note:1",
      todoId: 1,
      projectId: 1,
      projectPath: "groupe/depot-a",
      kind: "merge_requests",
      iid: 1,
      noteId: 1,
      requester: "alice",
      text: "@bot implémente les tests",
      targetUrl: "",
      ...overrides,
    };
  }

  test("dépôt sans entrée AGENT_CAPABILITIES (comportement historique tests-only/source-branch) : traduit fidèlement", () => {
    // Ancien réglage : AGENT_CAPABILITIES vide pour ce dépôt ⇒
    // DEFAULT_CAPABILITIES (guard.ts) : { writablePaths: "tests-only", publishMode: "source-branch" }.
    // Traduction projects.json équivalente : review/writeTests/pushToSourceBranch
    // tous à true (l'ancien modèle autorisait toujours la review et l'écriture
    // de tests dès qu'un dépôt/auteur était dans les listes blanches).
    const file = parseProjectsFile({
      projects: {
        "groupe/depot-a": {
          users: ["alice"],
          capabilities: {
            mergeRequest: { review: true, writeTests: true, writeBusinessCode: false, pushToSourceBranch: true },
          },
        },
      },
    });
    const resolved = resolveProject(file, "groupe/depot-a", BASELINE)!;
    assert.deepEqual(repoCapabilitiesFor(resolved.capabilities.mergeRequest), DEFAULT_CAPABILITIES);
  });

  test('ancien AGENT_CAPABILITIES="write-all;dedicated-mr" : traduit en writablePaths="all"/publishMode="dedicated-mr"', () => {
    const file = parseProjectsFile({
      projects: {
        "groupe/depot-a": {
          capabilities: {
            mergeRequest: { review: true, writeTests: true, writeBusinessCode: true, pushToSourceBranch: false },
          },
        },
      },
    });
    const resolved = resolveProject(file, "groupe/depot-a", BASELINE)!;
    assert.deepEqual(repoCapabilitiesFor(resolved.capabilities.mergeRequest), {
      writablePaths: "all",
      publishMode: "dedicated-mr",
    });
  });

  test("ancien ALLOWED_PROJECTS/ALLOWED_USERS (liste globale unique) : dupliqués par dépôt, mêmes décisions d'autorisation", () => {
    // Ancien : ALLOWED_PROJECTS=groupe/depot-a,groupe/depot-b — ALLOWED_USERS=alice,bob
    // (une seule liste d'auteurs, appliquée à tous les dépôts autorisés).
    const file = parseProjectsFile({
      projects: {
        "groupe/depot-a": { users: ["alice", "bob"] },
        "groupe/depot-b": { users: ["alice", "bob"] },
      },
    });

    for (const projectPath of ["groupe/depot-a", "groupe/depot-b"]) {
      for (const requester of ["alice", "bob"]) {
        const project = resolveProject(file, projectPath, BASELINE);
        const result = authorize(makeRequest({ projectPath, requester }), project);
        assert.equal(result.allowed, true, `${requester} sur ${projectPath} devait être autorisé`);
      }
    }

    // Dépôt hors de l'ancienne liste : refus silencieux, identique à avant.
    const outOfScope = resolveProject(file, "groupe/depot-c", BASELINE);
    const refusal = authorize(makeRequest({ projectPath: "groupe/depot-c" }), outOfScope);
    assert.equal(refusal.allowed, false);
    if (!refusal.allowed) assert.equal(refusal.silent, true);

    // Auteur hors de l'ancienne liste sur un dépôt autorisé : refus explicite, identique à avant.
    const wrongUser = authorize(
      makeRequest({ projectPath: "groupe/depot-a", requester: "eve" }),
      resolveProject(file, "groupe/depot-a", BASELINE),
    );
    assert.equal(wrongUser.allowed, false);
    if (!wrongUser.allowed) assert.equal(wrongUser.silent, false);
  });

  test("ancien DOCKER_IMAGES/DOCKER_DEFAULT_IMAGE et TEST_COMMANDS/TEST_COMMAND : même résolution par dépôt", () => {
    // Ancien : DOCKER_IMAGES="groupe/depot-a=cds-agent/node22", DOCKER_DEFAULT_IMAGE="node:22-bookworm-slim"
    //          TEST_COMMANDS="groupe/depot-a=pytest -q", TEST_COMMAND="npm test"
    const file = parseProjectsFile({
      projects: {
        "groupe/depot-a": {
          docker: { image: "cds-agent/node22" },
          commands: { test: "pytest -q" },
        },
        "groupe/depot-b": {},
      },
    });

    const a = resolveProject(file, "groupe/depot-a", BASELINE)!;
    assert.equal(a.docker.image, "cds-agent/node22");
    assert.equal(a.commands.test, "pytest -q");
    assert.equal(a.commands.install, BASELINE.commands.install);

    // Dépôt sans entrée dans les anciennes maps par dépôt : retombe sur le
    // défaut global, exactement comme avant.
    const b = resolveProject(file, "groupe/depot-b", BASELINE)!;
    assert.equal(b.docker.image, BASELINE.docker.image);
    assert.equal(b.commands.test, BASELINE.commands.test);
  });
});
