import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

// review.ts importe (transitivement) src/config.ts, qui lit .env et jette au
// chargement du module si GITLAB_TOKEN ou BOT_USERNAME sont absents. On
// injecte donc les variables requises avant l'import dynamique, pour que le
// test soit reproductible même sur une machine sans .env (CI). Comme
// loadDotEnv() ne remplit que les clés absentes de process.env, ces valeurs
// explicites gagnent toujours, qu'un .env local existe ou non.
let extractJson: (text: string) => string | null;

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  ({ extractJson } = await import("./review.ts"));
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

  // TODO(T31): extractJson compte les accolades sans tenir compte des
  // chaînes de caractères. Une accolade fermante non appairée à l'intérieur
  // d'une chaîne (ex. un message de remarque citant du code) fait retomber
  // le compteur de profondeur à zéro prématurément : le JSON renvoyé est
  // tronqué et invalide.
  test("une accolade fermante isolée dans une chaîne tronque le JSON (bug connu)", () => {
    const text = '{"remarks":[{"message":"close } before open"}]}';
    const result = extractJson(text);
    // Le JSON renvoyé est tronqué avant la fin réelle de l'objet.
    assert.equal(result, '{"remarks":[{"message":"close } before open"}');
    assert.throws(() => JSON.parse(result ?? ""));
  });
});
