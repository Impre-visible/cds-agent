import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isTestPath,
  collectChanges,
  isWritablePath,
  isDefaultCapabilities,
  describeCapabilities,
  DEFAULT_CAPABILITIES,
  type RepoCapabilities,
} from "../../src/tasks/guard.ts";

/**
 * Un vrai dépôt git jetable, avec un fichier de test déjà commité — pour les
 * scénarios de §2.2/§2.3 qui doivent être vérifiés contre une vraie sortie
 * `git status -z`, pas seulement contre des chaînes -z écrites à la main :
 * même motif que workspace.test.ts / implement.test.ts.
 */
function makeTestRepo(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "cds-agent-guard-test-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "seed@test.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "seed"]);
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "tests", "existant.test.js"), "// test existant\n");
  execFileSync("git", ["-C", repo, "add", "--all"]);
  execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "seed"]);
  return { root, repo };
}

/** La commande exacte que doit lancer implement.ts. */
function statusZ(repo: string): string {
  return execFileSync("git", [
    "-C",
    repo,
    "status",
    "--porcelain=v1",
    "-uall",
    "-z",
  ]).toString("utf8");
}

describe("isTestPath", () => {
  test("reconnaît un chemin sous un dossier de test connu, à la racine", () => {
    assert.equal(isTestPath("tests/foo.js"), true);
    assert.equal(isTestPath("test/foo.py"), true);
    assert.equal(isTestPath("__tests__/foo.js"), true);
    assert.equal(isTestPath("spec/foo.rb"), true);
  });

  test("reconnaît un fichier *.test.* ou *.spec.* en JS/TS", () => {
    assert.equal(isTestPath("src/foo.test.ts"), true);
    assert.equal(isTestPath("src/foo.spec.tsx"), true);
    assert.equal(isTestPath("src/foo.test.cjs"), true);
    assert.equal(isTestPath("src/foo.test.mjs"), true);
  });

  test("rejette un fichier source normal", () => {
    assert.equal(isTestPath("src/foo.ts"), false);
  });

  test("rejette un fichier de config à la racine", () => {
    assert.equal(isTestPath("package.json"), false);
  });

  describe("T11 — dossier de test niché à n'importe quel niveau", () => {
    test("un dossier de test niché dans src/ est reconnu", () => {
      assert.equal(isTestPath("src/tests/x.js"), true);
    });

    test("un dossier de test niché plus profondément (monorepo) est reconnu", () => {
      assert.equal(isTestPath("packages/api/test/helper.js"), true);
      assert.equal(isTestPath("apps/web/src/__tests__/App.jsx"), true);
    });

    test("un dossier de test en casse capitalisée (Tests/) est reconnu", () => {
      assert.equal(isTestPath("src/Tests/FooTests.cs"), true);
    });

    test("ne confond pas un dossier 'test' avec une sous-chaîne ('contest', 'latest')", () => {
      assert.equal(isTestPath("contest/foo.js"), false);
      assert.equal(isTestPath("latest/foo.js"), false);
    });
  });

  describe("T11 — conventions multi-écosystème", () => {
    test("Python : test_foo.py et foo_test.py, hors dossier de test", () => {
      assert.equal(isTestPath("src/test_foo.py"), true);
      assert.equal(isTestPath("src/foo_test.py"), true);
    });

    test("Python : conftest.py n'est PAS reconnu hors d'un dossier de test", () => {
      assert.equal(isTestPath("conftest.py"), false);
      assert.equal(isTestPath("src/conftest.py"), false);
    });

    test("Python : conftest.py et setup.py sont acceptés à l'intérieur d'un dossier de test (comportement existant, par répertoire)", () => {
      assert.equal(isTestPath("tests/conftest.py"), true);
      assert.equal(isTestPath("tests/setup.py"), true);
    });

    test("Go : foo_test.go", () => {
      assert.equal(isTestPath("pkg/server/foo_test.go"), true);
    });

    test("Go : un fichier source ordinaire n'est pas reconnu", () => {
      assert.equal(isTestPath("pkg/server/foo.go"), false);
    });

    test("Java/Kotlin : FooTest.java, FooTests.java, FooTestCase.java, FooSpec.kt", () => {
      assert.equal(isTestPath("src/test/java/com/acme/FooTest.java"), true);
      assert.equal(isTestPath("com/acme/FooTests.java"), true);
      assert.equal(isTestPath("com/acme/FooTestCase.java"), true);
      assert.equal(isTestPath("com/acme/FooSpec.kt"), true);
    });

    test("Java : ne confond pas 'Latest.java' avec une convention de test (casse significative)", () => {
      assert.equal(isTestPath("com/acme/Latest.java"), false);
    });

    test("Scala : FooSpec.scala", () => {
      assert.equal(isTestPath("com/acme/FooSpec.scala"), true);
    });

    test("Ruby : foo_spec.rb, foo_test.rb, test_foo.rb", () => {
      assert.equal(isTestPath("lib/foo_spec.rb"), true);
      assert.equal(isTestPath("lib/foo_test.rb"), true);
      assert.equal(isTestPath("lib/test_foo.rb"), true);
    });
  });

  describe("T11 — tentatives de contournement", () => {
    test("un dossier 'test' suivi d'une remontée '..' ne trompe pas le contrôle", () => {
      // Résolu, ce chemin ne pointe plus du tout vers tests/ mais vers
      // server.js à la racine — il doit être rejeté, pas accepté au
      // prétexte qu'un segment "test" apparaît dans la chaîne.
      assert.equal(isTestPath("vendor/test/../../server.js"), false);
      assert.equal(isTestPath("tests/../src/server.js"), false);
      assert.equal(isTestPath("./tests/foo.js"), false);
    });
  });

  describe("configuration par projet (extraDirectories)", () => {
    test("un dossier additionnel n'est reconnu que si explicitement déclaré", () => {
      assert.equal(isTestPath("e2e/foo.js"), false);
      assert.equal(isTestPath("e2e/foo.js", ["e2e"]), true);
    });

    test("la déclaration est insensible à la casse et n'affecte pas les autres dossiers", () => {
      assert.equal(isTestPath("E2E/foo.js", ["e2e"]), true);
      assert.equal(isTestPath("src/foo.ts", ["e2e"]), false);
    });
  });
});

describe("collectChanges", () => {
  // collectChanges reçoit désormais la sortie de `git status --porcelain=v1
  // -uall -z` (voir implement.ts) : chaque entrée est terminée par un octet
  // nul plutôt qu'un saut de ligne. Les chaînes ci-dessous, écrites à la
  // main, reproduisent ce format pour les cas simples ; les scénarios de
  // quoting/échappement (§2.2) et de suppression (§2.3) sont, eux, vérifiés
  // contre une vraie sortie git plus bas.

  test("extrait les chemins d'un statut porcelain simple", () => {
    const { paths, offending } = collectChanges(
      "M  tests/foo.test.ts\0A  src/bar.ts\0",
    );
    assert.deepEqual(paths, ["tests/foo.test.ts", "src/bar.ts"]);
    assert.deepEqual(offending, ["src/bar.ts"]);
  });

  test("ignore les entrées vides", () => {
    const { paths } = collectChanges("\0\0A  tests/a.test.ts\0\0");
    assert.deepEqual(paths, ["tests/a.test.ts"]);
  });

  test("déduplique les chemins identiques", () => {
    const { paths } = collectChanges("M  tests/a.test.ts\0M  tests/a.test.ts\0");
    assert.deepEqual(paths, ["tests/a.test.ts"]);
  });

  test("un dossier de test niché est accepté (T11)", () => {
    const { offending } = collectChanges("A  packages/api/test/helper.js\0");
    assert.deepEqual(offending, []);
  });

  test("un dossier additionnel n'est accepté que si passé explicitement à collectChanges", () => {
    const withoutOverride = collectChanges("A  e2e/foo.js\0");
    assert.deepEqual(withoutOverride.offending, ["e2e/foo.js"]);

    const withOverride = collectChanges("A  e2e/foo.js\0", ["e2e"]);
    assert.deepEqual(withOverride.offending, []);
  });

  describe("statuts suspects (§2.3, hors suppression) — traités comme hors périmètre", () => {
    test("un conflit de fusion non résolu (UU) est signalé, même sur un chemin de test", () => {
      const { offending, deletedTests } = collectChanges("UU tests/foo.test.ts\0");
      assert.deepEqual(offending, ["tests/foo.test.ts"]);
      assert.deepEqual(deletedTests, []);
    });

    test("un conflit ajouté/supprimé des deux côtés (AA, DD) est signalé", () => {
      assert.deepEqual(
        collectChanges("AA tests/foo.test.ts\0").offending,
        ["tests/foo.test.ts"],
      );
      assert.deepEqual(
        collectChanges("DD tests/foo.test.ts\0").offending,
        ["tests/foo.test.ts"],
      );
    });

    test("un changement de type (T, fichier <-> lien symbolique) est signalé", () => {
      const { offending } = collectChanges(" T tests/foo.test.ts\0");
      assert.deepEqual(offending, ["tests/foo.test.ts"]);
    });

    test("un fichier non suivi (??) reste traité normalement, pas comme suspect", () => {
      const { offending } = collectChanges("?? tests/nouveau.test.ts\0");
      assert.deepEqual(offending, []);
    });
  });

  describe("renommage et copie", () => {
    test("un renommage compte les deux chemins et n'est pas signalé si les deux restent dans le périmètre", () => {
      const { root, repo } = makeTestRepo();
      try {
        execFileSync("git", [
          "-C",
          repo,
          "mv",
          "tests/existant.test.js",
          "tests/renomme.test.js",
        ]);
        const { paths, offending, deletedTests } = collectChanges(statusZ(repo));
        assert.deepEqual(
          new Set(paths),
          new Set(["tests/renomme.test.js", "tests/existant.test.js"]),
        );
        assert.deepEqual(offending, []);
        // Le contenu survit sous le nouveau nom : ce n'est pas une
        // suppression, même si l'ancien chemin "disparaît".
        assert.deepEqual(deletedTests, []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("un renommage vers un fichier hors périmètre est signalé", () => {
      const { root, repo } = makeTestRepo();
      try {
        mkdirSync(join(repo, "src"), { recursive: true });
        execFileSync("git", [
          "-C",
          repo,
          "mv",
          "tests/existant.test.js",
          "src/deplace.ts",
        ]);
        const { paths, offending } = collectChanges(statusZ(repo));
        assert.deepEqual(
          new Set(paths),
          new Set(["src/deplace.ts", "tests/existant.test.js"]),
        );
        assert.deepEqual(offending, ["src/deplace.ts"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("un renommage suivi de la suppression du fichier renommé (RD) est traité comme une suppression de test", () => {
      const { root, repo } = makeTestRepo();
      try {
        execFileSync("git", [
          "-C",
          repo,
          "mv",
          "tests/existant.test.js",
          "tests/renomme.test.js",
        ]);
        // L'agent supprime ensuite, dans l'arbre de travail, le fichier
        // qu'il vient de renommer : constaté empiriquement, git émet un
        // statut "RD" (pas "R " suivi d'un "D " séparé).
        execFileSync("rm", [join(repo, "tests", "renomme.test.js")]);
        const { offending, deletedTests } = collectChanges(statusZ(repo));
        assert.deepEqual(offending, []);
        assert.deepEqual(deletedTests, ["tests/renomme.test.js"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    // `git status` ne détecte jamais de copie de lui-même (contrairement à
    // `git diff -C`, il n'existe pas de `--find-copies` pour ce sous-
    // commande — vérifié : `-C` est refusé avec "unknown switch"). Le code
    // "C" reste documenté par git pour le format -z (même structure que
    // "R" : la copie ajoute une entrée d'origine), d'où ce test sur une
    // chaîne construite à la main plutôt que sur une vraie sortie git.
    test("une copie (C, format -z documenté mais non produit par git status) est attribuée comme un renommage", () => {
      const { paths, offending } = collectChanges(
        "C  tests/copie.test.ts\0tests/existant.test.js\0",
      );
      assert.deepEqual(
        new Set(paths),
        new Set(["tests/copie.test.ts", "tests/existant.test.js"]),
      );
      assert.deepEqual(offending, []);
    });
  });

  describe("§2.2 — quoting/échappement git, vérifié contre une vraie sortie -z", () => {
    test("espaces, accents et guillemets dans un nom de fichier passent tels quels, sans décodage à faire", () => {
      const { root, repo } = makeTestRepo();
      try {
        writeFileSync(join(repo, "tests", "espace dans le nom.test.js"), "// x\n");
        writeFileSync(join(repo, "tests", "café.test.js"), "// x\n");
        writeFileSync(join(repo, "tests", 'guillemet".test.js'), "// x\n");
        const { paths, offending } = collectChanges(statusZ(repo));
        assert.deepEqual(
          new Set(paths),
          new Set([
            "tests/espace dans le nom.test.js",
            "tests/café.test.js",
            'tests/guillemet".test.js',
          ]),
        );
        assert.deepEqual(offending, []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("un nom de fichier contenant littéralement ' -> ' ne casse pas le parsing (pas de rename ici)", () => {
      const { root, repo } = makeTestRepo();
      try {
        writeFileSync(join(repo, "tests", "a -> b.test.js"), "// x\n");
        const { paths, offending } = collectChanges(statusZ(repo));
        // Seul ce nouveau fichier apparaît : "tests/existant.test.js" est
        // déjà commité par makeTestRepo() et n'a pas été touché ici.
        assert.deepEqual(paths, ["tests/a -> b.test.js"]);
        assert.deepEqual(offending, []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("§2.3 — suppression d'un fichier de test existant", () => {
    test("le scénario motivant le correctif : l'agent supprime un test existant, c'est refusé", () => {
      const { root, repo } = makeTestRepo();
      try {
        execFileSync("rm", [join(repo, "tests", "existant.test.js")]);
        const { paths, offending, deletedTests } = collectChanges(statusZ(repo));
        assert.deepEqual(paths, ["tests/existant.test.js"]);
        assert.deepEqual(
          offending,
          [],
          "la suppression ne doit pas se fondre dans le message générique « hors périmètre »",
        );
        assert.deepEqual(deletedTests, ["tests/existant.test.js"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("la suppression d'un fichier hors périmètre reste signalée comme offending, pas comme deletedTests", () => {
      const { root, repo } = makeTestRepo();
      try {
        writeFileSync(join(repo, "server.js"), "console.log(1);\n");
        execFileSync("git", ["-C", repo, "add", "--all"]);
        execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "add server.js"]);
        execFileSync("rm", [join(repo, "server.js")]);
        const { offending, deletedTests } = collectChanges(statusZ(repo));
        assert.deepEqual(offending, ["server.js"]);
        assert.deepEqual(deletedTests, []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("cas nominal : ajouter un nouveau fichier de test ne déclenche aucun faux positif", () => {
      const { root, repo } = makeTestRepo();
      try {
        writeFileSync(join(repo, "tests", "nouveau.test.js"), "// nouveau test\n");
        const { paths, offending, deletedTests } = collectChanges(statusZ(repo));
        assert.deepEqual(paths, ["tests/nouveau.test.js"]);
        assert.deepEqual(offending, []);
        assert.deepEqual(deletedTests, []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

// Chantier "capacités" : isWritablePath est désormais LE point unique qui
// décide si un chemin est dans le périmètre accordé, à la place de l'usage
// direct d'isTestPath par collectChanges — ces tests vérifient à la fois le
// comportement par défaut inchangé et les capacités élargies.
describe("isWritablePath — capacités (chantier « capacités »)", () => {
  test("sans capacités (défaut), équivalent strict à isTestPath", () => {
    assert.equal(isWritablePath("tests/foo.js"), isTestPath("tests/foo.js"));
    assert.equal(isWritablePath("src/foo.ts"), isTestPath("src/foo.ts"));
    assert.equal(isWritablePath("src/foo.ts", DEFAULT_CAPABILITIES), false);
  });

  test('writablePaths="all" : un fichier hors tests devient modifiable, y compris du code source', () => {
    const capabilities: RepoCapabilities = {
      writablePaths: "all",
      publishMode: "source-branch",
    };
    assert.equal(isWritablePath("src/server.js", capabilities), true);
    assert.equal(isWritablePath("package.json", capabilities), true);
  });

  test('writablePaths sous forme de motifs : élargit précisément, sans devenir "all"', () => {
    const capabilities: RepoCapabilities = {
      writablePaths: ["src/generated/**"],
      publishMode: "source-branch",
    };
    assert.equal(isWritablePath("src/generated/schema.ts", capabilities), true);
    assert.equal(isWritablePath("src/server.js", capabilities), false);
    // Les chemins de test restent modifiables en plus des motifs déclarés.
    assert.equal(isWritablePath("tests/foo.test.js", capabilities), true);
  });

  test('"**" traverse les segments, "*" reste dans un segment', () => {
    const capabilities: RepoCapabilities = {
      writablePaths: ["docs/*.md"],
      publishMode: "source-branch",
    };
    assert.equal(isWritablePath("docs/readme.md", capabilities), true);
    assert.equal(isWritablePath("docs/sub/readme.md", capabilities), false);

    const deepCapabilities: RepoCapabilities = {
      writablePaths: ["docs/**"],
      publishMode: "source-branch",
    };
    assert.equal(isWritablePath("docs/sub/readme.md", deepCapabilities), true);
  });

  test("le refus des chemins avec un composant \".\" ou \"..\" reste inconditionnel, même avec writablePaths=\"all\"", () => {
    const capabilities: RepoCapabilities = {
      writablePaths: "all",
      publishMode: "source-branch",
    };
    assert.equal(isWritablePath("vendor/test/../../server.js", capabilities), false);
    assert.equal(isWritablePath("./server.js", capabilities), false);
  });
});

describe("collectChanges — capacités (chantier « capacités »)", () => {
  test("sans capacités renseignées, comportement strictement identique à avant ce chantier", () => {
    const withoutCapabilities = collectChanges("A  src/server.js\0A  tests/foo.test.js\0");
    const withDefaultCapabilities = collectChanges(
      "A  src/server.js\0A  tests/foo.test.js\0",
      [],
      DEFAULT_CAPABILITIES,
    );
    assert.deepEqual(withoutCapabilities, withDefaultCapabilities);
    assert.deepEqual(withoutCapabilities.offending, ["src/server.js"]);
  });

  test('capacité writablePaths="all" : un fichier hors tests ne remonte plus en "offending"', () => {
    const capabilities: RepoCapabilities = {
      writablePaths: "all",
      publishMode: "source-branch",
    };
    const withCapability = collectChanges(
      "A  src/server.js\0A  tests/foo.test.js\0",
      [],
      capabilities,
    );
    assert.deepEqual(withCapability.offending, []);

    // Sans la capacité, le même statut est refusé : la capacité change
    // effectivement l'issue, elle n'est pas cosmétique.
    const without = collectChanges("A  src/server.js\0A  tests/foo.test.js\0");
    assert.deepEqual(without.offending, ["src/server.js"]);
  });

  test("capacité writablePaths=motifs : élargit précisément un dossier déclaré, rien d'autre", () => {
    const capabilities: RepoCapabilities = {
      writablePaths: ["src/generated/**"],
      publishMode: "source-branch",
    };
    const result = collectChanges(
      "A  src/generated/schema.ts\0A  src/server.js\0",
      [],
      capabilities,
    );
    assert.deepEqual(result.offending, ["src/server.js"]);
  });

  test('writablePaths="all" : supprimer un test existant n\'est plus distingué en deletedTests (action permise comme une autre)', () => {
    const capabilities: RepoCapabilities = {
      writablePaths: "all",
      publishMode: "source-branch",
    };
    const result = collectChanges("D  tests/existant.test.js\0", [], capabilities);
    assert.deepEqual(result.deletedTests, []);
    assert.deepEqual(result.offending, []);

    // Sans la capacité, le même statut reste refusé comme suppression de test.
    const without = collectChanges("D  tests/existant.test.js\0");
    assert.deepEqual(without.deletedTests, ["tests/existant.test.js"]);
  });

  test('le rejet des chemins ".."/"." reste inconditionnel même avec writablePaths="all"', () => {
    const capabilities: RepoCapabilities = {
      writablePaths: "all",
      publishMode: "source-branch",
    };
    const result = collectChanges("A  vendor/test/../../server.js\0", [], capabilities);
    assert.deepEqual(result.offending, ["vendor/test/../../server.js"]);
  });
});

describe("isDefaultCapabilities / describeCapabilities", () => {
  test("DEFAULT_CAPABILITIES est bien reconnu comme le défaut", () => {
    assert.equal(isDefaultCapabilities(DEFAULT_CAPABILITIES), true);
  });

  test("une capacité élargie n'est plus le défaut", () => {
    assert.equal(
      isDefaultCapabilities({ writablePaths: "all", publishMode: "source-branch" }),
      false,
    );
    assert.equal(
      isDefaultCapabilities({ writablePaths: "tests-only", publishMode: "dedicated-mr" }),
      false,
    );
  });

  test("describeCapabilities mentionne ce qui dépasse le défaut", () => {
    const description = describeCapabilities({
      writablePaths: "all",
      publishMode: "dedicated-mr",
    });
    assert.match(description, /tout le dépôt/);
    assert.match(description, /merge request dédiée/);
  });
});
