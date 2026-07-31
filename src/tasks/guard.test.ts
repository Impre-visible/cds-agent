import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isTestPath, collectChanges } from "./guard.ts";

describe("isTestPath", () => {
  test("reconnaît un chemin sous un dossier de test connu", () => {
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

  // TODO(T11): isTestPath ne reconnaît un dossier de test que via startsWith
  // à la racine du chemin — un dossier de test niché plus bas (src/tests/x.js)
  // n'est pas reconnu, alors qu'il s'agit bien d'un chemin de test.
  test("ne reconnaît pas un dossier de test qui n'est pas à la racine du chemin (bug connu)", () => {
    assert.equal(isTestPath("src/tests/x.js"), false);
  });

  // TODO(T11): TEST_FILENAME ne couvre que les extensions JS/TS — un fichier
  // de test dans un autre langage (Python, Ruby...) hors des dossiers connus
  // n'est pas détecté.
  test("ne reconnaît pas un fichier de test hors JS/TS (bug connu)", () => {
    assert.equal(isTestPath("src/foo.test.py"), false);
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
