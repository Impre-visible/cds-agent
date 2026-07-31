import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseDiff, numberDiffLines, validateRemarks } from "../../src/tasks/diff.ts";
import type { DiffFile } from "../../src/types.ts";

describe("parseDiff", () => {
  test("indexe les lignes ajoutées et de contexte, pas les lignes supprimées", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;",
    ].join("\n");

    const lines = parseDiff(diff);

    // Ligne de contexte : newLine et oldLine renseignés tous les deux.
    assert.deepEqual(lines.get(1), { newLine: 1, oldLine: 1 });
    // Ligne ajoutée : uniquement newLine, oldLine à null.
    assert.deepEqual(lines.get(2), { newLine: 2, oldLine: null });
    // Ligne de contexte après l'ajout.
    assert.deepEqual(lines.get(3), { newLine: 3, oldLine: 3 });
    // La ligne supprimée n'a pas de position côté "new" : rien à l'index 2 côté old only.
    assert.equal(lines.size, 3);
  });

  test("gère plusieurs hunks avec des compteurs distincts", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "+const b = 2;",
      "@@ -20,2 +21,3 @@",
      " const x = 1;",
      "+const y = 2;",
      " const z = 3;",
    ].join("\n");

    const lines = parseDiff(diff);

    // Premier hunk : new commence à 1.
    assert.deepEqual(lines.get(1), { newLine: 1, oldLine: 1 });
    assert.deepEqual(lines.get(2), { newLine: 2, oldLine: null });

    // Second hunk : new commence à 21, old à 20 — les compteurs sont repartis
    // depuis l'en-tête, pas cumulés depuis le hunk précédent.
    assert.deepEqual(lines.get(21), { newLine: 21, oldLine: 20 });
    assert.deepEqual(lines.get(22), { newLine: 22, oldLine: null });
    assert.deepEqual(lines.get(23), { newLine: 23, oldLine: 21 });
  });

  test("diff vide renvoie une map vide", () => {
    assert.equal(parseDiff("").size, 0);
  });
});

// §5.3 : le numéro préfixé à chaque ligne doit être exactement celui que
// parseDiff/validateRemarks savent retrouver — sinon la numérotation induit
// le modèle en erreur au lieu de le corriger.
describe("numberDiffLines", () => {
  test("numérote lignes ajoutées et de contexte avec le numéro du nouveau fichier, sur plusieurs hunks", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "+const b = 2;",
      "@@ -20,2 +21,3 @@",
      " const x = 1;",
      "+const y = 2;",
      " const z = 3;",
    ].join("\n");

    const numbered = numberDiffLines(diff).split("\n");

    assert.match(numbered[0] ?? "", /^@@ -1,2 \+1,2 @@$/);
    assert.match(numbered[1] ?? "", /^\s+1 \|  const a = 1;$/);
    assert.match(numbered[2] ?? "", /^\s+2 \| \+const b = 2;$/);
    assert.match(numbered[3] ?? "", /^@@ -20,2 \+21,3 @@$/);
    assert.match(numbered[4] ?? "", /^\s+21 \|  const x = 1;$/);
    assert.match(numbered[5] ?? "", /^\s+22 \| \+const y = 2;$/);
    assert.match(numbered[6] ?? "", /^\s+23 \|  const z = 3;$/);

    // Vérification croisée : chaque numéro affiché doit être celui que
    // parseDiff retrouve réellement pour la même ligne (les deux doivent
    // rester d'accord, voir walkDiffLines).
    const positions = parseDiff(diff);
    for (const newLine of [1, 21, 23]) {
      assert.ok(positions.has(newLine), `parseDiff doit connaître la ligne ${newLine}`);
    }
  });

  test("les lignes supprimées n'ont pas de numéro dans le nouveau fichier : marquées, pas de numéro de l'ancien fichier réutilisé", () => {
    const diff = [
      "@@ -1,3 +1,2 @@",
      " const a = 1;",
      "-const b = 2;",
      " const c = 3;",
    ].join("\n");

    const numbered = numberDiffLines(diff).split("\n");
    assert.match(numbered[1] ?? "", /^\s+1 \|  const a = 1;$/);
    // Le marqueur de la ligne supprimée (avant le séparateur " | ") ne doit
    // contenir ni "2" (numéro de l'ancien fichier) ni aucun autre chiffre :
    // seul un repère non numérique doit y apparaître. Le contenu de la
    // ligne elle-même (après " | ") contient forcément des chiffres du code
    // original ("= 2;"), donc on isole bien le marqueur avant de vérifier.
    const deletedLine = numbered[2] ?? "";
    const marker = deletedLine.split(" | ")[0] ?? "";
    assert.doesNotMatch(marker, /\d/);
    assert.match(deletedLine, /-const b = 2;$/);
    assert.match(numbered[3] ?? "", /^\s+2 \|  const c = 3;$/);
  });

  test("les en-têtes @@ sont reproduits tels quels, sans préfixe de numéro", () => {
    const diff = ["@@ -5,1 +5,1 @@", " const z = 1;"].join("\n");
    const numbered = numberDiffLines(diff);
    assert.ok(numbered.startsWith("@@ -5,1 +5,1 @@\n"));
  });
});

function makeFile(path: string, diff: string): DiffFile {
  return {
    old_path: path,
    new_path: path,
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    diff,
  };
}

describe("validateRemarks", () => {
  const diff = [
    "@@ -1,2 +1,2 @@",
    " const a = 1;",
    "+const b = 2;",
  ].join("\n");
  const files = [makeFile("src/foo.ts", diff)];

  test("accepte une remarque sur une ligne présente dans le diff", () => {
    const { valid, rejected } = validateRemarks(
      [{ file: "src/foo.ts", line: 2, severity: "warning", message: "m" }],
      files,
    );
    assert.equal(valid.length, 1);
    assert.equal(rejected.length, 0);
    assert.equal(valid[0]?.position?.newLine, 2);
  });

  test("rejette une remarque sur un fichier absent du diff", () => {
    const { valid, rejected } = validateRemarks(
      [{ file: "src/absent.ts", line: 1, severity: "info", message: "m" }],
      files,
    );
    assert.equal(valid.length, 0);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0] ?? "", /fichier absent du diff/);
  });

  test("une remarque sur une ligne hors diff est acceptée avec une position nulle (pas rejetée)", () => {
    // Comportement actuel : validateRemarks ne rejette pas les lignes hors
    // diff, elle les accepte avec position: null (remarque « générale »).
    const { valid, rejected } = validateRemarks(
      [{ file: "src/foo.ts", line: 999, severity: "info", message: "m" }],
      files,
    );
    assert.equal(valid.length, 1);
    assert.equal(valid[0]?.position, null);
    assert.equal(rejected.length, 0);
  });

  test("rejette les doublons (une seule remarque par ligne)", () => {
    const { valid, rejected } = validateRemarks(
      [
        { file: "src/foo.ts", line: 2, severity: "info", message: "m1" },
        { file: "src/foo.ts", line: 2, severity: "warning", message: "m2" },
      ],
      files,
    );
    assert.equal(valid.length, 1);
    assert.equal(valid[0]?.message, "m1");
    assert.equal(rejected.length, 1);
    assert.match(rejected[0] ?? "", /doublon/);
  });

  test("deux remarques hors diff sur le même fichier sont aussi déduplicées", () => {
    const { valid, rejected } = validateRemarks(
      [
        { file: "src/foo.ts", line: 998, severity: "info", message: "m1" },
        { file: "src/foo.ts", line: 999, severity: "info", message: "m2" },
      ],
      files,
    );
    // Les deux lignes sont hors diff donc position null pour les deux : la
    // clé de dédup ("file:file") est identique, la seconde est rejetée.
    assert.equal(valid.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0] ?? "", /doublon/);
  });

  test("la sévérité par défaut est 'info' si absente", () => {
    const { valid } = validateRemarks(
      [
        {
          file: "src/foo.ts",
          line: 2,
          severity: undefined as unknown as string,
          message: "m",
        },
      ],
      files,
    );
    assert.equal(valid[0]?.severity, "info");
  });
});
