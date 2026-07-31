import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isTestPath, collectChanges } from "./guard.ts";

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
  test("extrait les chemins d'un statut porcelain simple", () => {
    const { paths, offending } = collectChanges(
      "M  tests/foo.test.ts\nA  src/bar.ts\n",
    );
    assert.deepEqual(paths, ["tests/foo.test.ts", "src/bar.ts"]);
    assert.deepEqual(offending, ["src/bar.ts"]);
  });

  test("ignore les lignes vides", () => {
    const { paths } = collectChanges("\n\nA  tests/a.test.ts\n\n");
    assert.deepEqual(paths, ["tests/a.test.ts"]);
  });

  test("un renommage 'ancien -> nouveau' compte les deux chemins", () => {
    const { paths, offending } = collectChanges(
      "R  tests/old.test.ts -> tests/new.test.ts\n",
    );
    assert.deepEqual(paths, ["tests/old.test.ts", "tests/new.test.ts"]);
    assert.deepEqual(offending, []);
  });

  test("un renommage vers un fichier hors périmètre est signalé", () => {
    const { paths, offending } = collectChanges(
      "R  tests/old.test.ts -> src/new.ts\n",
    );
    assert.deepEqual(paths, ["tests/old.test.ts", "src/new.ts"]);
    assert.deepEqual(offending, ["src/new.ts"]);
  });

  test("déduplique les chemins identiques", () => {
    const { paths } = collectChanges(
      "M  tests/a.test.ts\nM  tests/a.test.ts\n",
    );
    assert.deepEqual(paths, ["tests/a.test.ts"]);
  });

  test("dépouille les chemins entre guillemets (espaces)", () => {
    const { paths, offending } = collectChanges(
      'A  "src/foo bar.ts"\n',
    );
    assert.deepEqual(paths, ["src/foo bar.ts"]);
    assert.deepEqual(offending, ["src/foo bar.ts"]);
  });

  test("un dossier de test niché est accepté (T11)", () => {
    const { offending } = collectChanges(
      "A  packages/api/test/helper.js\n",
    );
    assert.deepEqual(offending, []);
  });

  test("un dossier additionnel n'est accepté que si passé explicitement à collectChanges", () => {
    const withoutOverride = collectChanges("A  e2e/foo.js\n");
    assert.deepEqual(withoutOverride.offending, ["e2e/foo.js"]);

    const withOverride = collectChanges("A  e2e/foo.js\n", ["e2e"]);
    assert.deepEqual(withOverride.offending, []);
  });

  // TODO(T12): collectChanges ne décode pas les séquences octales que git
  // utilise pour quoter les caractères non-ASCII (core.quotepath) — le chemin
  // récupéré contient les échappements \NNN littéraux au lieu du caractère
  // accentué réel.
  test("ne décode pas les échappements octaux git pour les caractères accentués (bug connu)", () => {
    const { paths } = collectChanges('A  "tests/caf\\303\\251.js"\n');
    assert.deepEqual(paths, ["tests/caf\\303\\251.js"]);
  });

  // TODO(T13): collectChanges ignore les colonnes de statut XY — une
  // suppression (D) d'un fichier de test est traitée comme n'importe quelle
  // modification de ce chemin : comme le chemin reste sous un dossier de
  // test, il n'est jamais signalé comme offending, alors que supprimer un
  // test est justement le genre de triche que le garde-fou doit détecter.
  test("une suppression de fichier de test n'est pas signalée comme offending (bug connu)", () => {
    const { paths, offending } = collectChanges("D  tests/foo.test.ts\n");
    assert.deepEqual(paths, ["tests/foo.test.ts"]);
    assert.deepEqual(offending, []);
  });
});
