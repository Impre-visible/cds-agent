import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

// review.ts importe (transitivement) src/config.ts, qui lit .env et jette au
// chargement du module si GITLAB_TOKEN ou BOT_USERNAME sont absents. On
// injecte donc les variables requises avant l'import dynamique, pour que le
// test soit reproductible même sur une machine sans .env (CI). Comme
// loadDotEnv() ne remplit que les clés absentes de process.env, ces valeurs
// explicites gagnent toujours, qu'un .env local existe ou non.
let extractJson: (text: string) => string | null;
let parseRemark: (
  raw: unknown,
  index: number,
) => { remark: unknown } | { rejected: string };

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  ({ extractJson, parseRemark } = await import("./review.ts"));
});

describe("extractJson", () => {
  test("extrait le JSON d'un bloc de code fenced ```json", () => {
    const text = [
      "Voici le résultat :",
      "```json",
      '{"remarks":[]}',
      "```",
      "Merci.",
    ].join("\n");
    assert.equal(extractJson(text), '{"remarks":[]}');
  });

  test("extrait le JSON d'un bloc fenced sans annotation de langage", () => {
    const text = "```\n" + '{"remarks":[]}' + "\n```";
    assert.equal(extractJson(text), '{"remarks":[]}');
  });

  test("à défaut de bloc fenced, cherche '{\"remarks\"' en comptant les accolades", () => {
    const text = 'préambule non-JSON {"remarks":[{"file":"a.ts","line":1,"severity":"info","message":"m"}]} postscript';
    assert.equal(
      extractJson(text),
      '{"remarks":[{"file":"a.ts","line":1,"severity":"info","message":"m"}]}',
    );
  });

  test("reconnaît aussi la variante avec espace '{ \"remarks\"'", () => {
    const text = '{ "remarks": [] }';
    assert.equal(extractJson(text), '{ "remarks": [] }');
  });

  test("renvoie null si aucun JSON exploitable n'est trouvé", () => {
    assert.equal(extractJson("pas de JSON ici"), null);
  });

  // T31 : une accolade fermante isolée dans une chaîne (ex. un message de
  // remarque citant du code) ne doit plus faire retomber le compteur de
  // profondeur à zéro avant la vraie fin de l'objet JSON.
  test("une accolade dans une chaîne ne tronque plus le JSON", () => {
    const text = '{"remarks":[{"message":"close } before open"}]}';
    const result = extractJson(text);
    assert.equal(result, text);
    assert.doesNotThrow(() => JSON.parse(result ?? ""));
  });

  test("une remarque citant un extrait de code avec accolades est extraite intégralement, y compris dans un bloc fenced", () => {
    const remark =
      '{"remarks":[{"file":"a.ts","line":1,"severity":"warning","message":"remplacez par if (x) { return } ici"}]}';
    const text = ["Voici :", "```json", remark, "```", "Fin."].join("\n");
    const result = extractJson(text);
    assert.equal(result, remark);
    const parsed = JSON.parse(result ?? "") as { remarks: unknown[] };
    assert.equal(parsed.remarks.length, 1);
  });

  test("du texte parasite avant et après un JSON contenant des accolades imbriquées est ignoré", () => {
    const remark =
      '{"remarks":[{"file":"a.ts","line":1,"severity":"info","message":"objet { imbriqué } ici"},{"file":"b.ts","line":2,"severity":"error","message":"m2"}]}';
    const text = `blabla du modèle avant\n${remark}\nblabla du modèle après`;
    assert.equal(extractJson(text), remark);
  });
});

describe("parseRemark", () => {
  test("accepte une remarque entièrement valide sans perte", () => {
    const result = parseRemark(
      { file: "a.ts", line: 42, severity: "warning", message: "m" },
      0,
    );
    assert.deepEqual(result, {
      remark: { file: "a.ts", line: 42, severity: "warning", message: "m" },
    });
  });

  test("convertit une ligne rendue en chaîne", () => {
    const result = parseRemark(
      { file: "a.ts", line: "42", severity: "info", message: "m" },
      0,
    );
    assert.deepEqual(result, {
      remark: { file: "a.ts", line: 42, severity: "info", message: "m" },
    });
  });

  test("rejette une ligne absente", () => {
    const result = parseRemark(
      { file: "a.ts", severity: "info", message: "m" },
      0,
    );
    assert.ok("rejected" in result);
    assert.match((result as { rejected: string }).rejected, /"line"/);
  });

  test("rejette une ligne non entière (chaîne non numérique, flottant, ou <= 0)", () => {
    for (const line of ["abc", 1.5, 0, -1]) {
      const result = parseRemark(
        { file: "a.ts", line, severity: "info", message: "m" },
        0,
      );
      assert.ok("rejected" in result, `line=${line} aurait dû être rejeté`);
    }
  });

  test("rejette un message qui n'est pas une chaîne", () => {
    const result = parseRemark(
      { file: "a.ts", line: 1, severity: "info", message: { oops: true } },
      0,
    );
    assert.ok("rejected" in result);
    assert.match((result as { rejected: string }).rejected, /"message"/);
  });

  test("rejette un fichier absent", () => {
    const result = parseRemark({ line: 1, severity: "info", message: "m" }, 0);
    assert.ok("rejected" in result);
    assert.match((result as { rejected: string }).rejected, /"file"/);
  });

  test("replie une sévérité inconnue ou absente sur 'info' sans rejeter la remarque", () => {
    const inconnue = parseRemark(
      { file: "a.ts", line: 1, severity: "catastrophique", message: "m" },
      0,
    );
    assert.deepEqual(inconnue, {
      remark: { file: "a.ts", line: 1, severity: "info", message: "m" },
    });

    const absente = parseRemark({ file: "a.ts", line: 1, message: "m" }, 0);
    assert.deepEqual(absente, {
      remark: { file: "a.ts", line: 1, severity: "info", message: "m" },
    });
  });

  test("rejette une entrée qui n'est pas un objet", () => {
    const result = parseRemark("pas un objet", 0);
    assert.ok("rejected" in result);
  });
});
