import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  describeDeployable,
  describeQuantization,
  extraBodyFor,
  loadQuantizationTable,
  parseQuantizationTable,
  ignoredProvidersFor,
  type Quantization,
  type Quantizations,
} from "../../src/openhands/quantization.ts";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/** Fabrique une table complète à partir des seuls modèles. */
function tbl(
  models: Record<string, { quantizations: Quantization[]; deployable: boolean; ignore?: string[] }>,
  ignore: string[] = [],
): Quantizations {
  return { models: models as Quantizations["models"], global: { ignore } };
}

const TABLE = tbl({
  "openrouter/openai/gpt-oss-120b": { quantizations: ["fp4"], deployable: true },
  "openrouter/moonshotai/kimi-k2.6": { quantizations: ["int4"], deployable: false },
});

describe("extraBodyFor — le corps envoyé à OpenRouter", () => {
  test("pose la quantification ET allow_fallbacks: false", () => {
    // Sans allow_fallbacks: false, OpenRouter reprend la main dès qu'aucun
    // fournisseur de la quantification demandée n'est disponible, en silence.
    // C'est exactement ce que ce chantier existe pour empêcher.
    assert.deepEqual(extraBodyFor("openrouter/openai/gpt-oss-120b", TABLE), {
      provider: { quantizations: ["fp4"], allow_fallbacks: false },
    });
  });

  test("modèle absent de la table : {} — et c'est un {} qu'il FAUT envoyer", () => {
    // Le banc enchaîne les modèles sur une même instance et les réglages
    // fusionnent : une contrainte laissée par le modèle précédent
    // s'appliquerait au suivant. Un fp8 oublié sur un modèle qui n'en a pas,
    // c'est un 404 sur ses trois tirages.
    assert.deepEqual(extraBodyFor("openrouter/inconnu/modele", TABLE), {});
  });

  test("plusieurs quantifications acceptables passent dans l'ordre donné", () => {
    const table = tbl({ m: { quantizations: ["int4", "fp4"], deployable: false } });
    const body = extraBodyFor("m", table) as {
      provider: { quantizations: string[] };
    };
    assert.deepEqual(body.provider.quantizations, ["int4", "fp4"]);
  });
});

describe("écarter un fournisseur cassé", () => {
  test("l'entrée globale « * » s'applique à TOUS les modèles", () => {
    // Un fournisseur cassé l'est pour tous les modèles qu'il sert. Inceptron
    // rendait 422 (« missing field `content` ») sur minimax ET kimi ET
    // glm-5.2 : le lister par modèle demanderait de le répéter, et de le
    // rajouter le jour où il sert un quatrième modèle.
    const table = tbl(
      { m: { quantizations: ["fp8"], deployable: true } },
      ["inceptron"],
    );
    assert.deepEqual(extraBodyFor("m", table), {
      provider: { quantizations: ["fp8"], allow_fallbacks: false, ignore: ["inceptron"] },
    });
  });

  test("s'applique MÊME à un modèle absent de la table", () => {
    // Un fournisseur cassé l'est indépendamment de la quantification demandée.
    const table = tbl({}, ["inceptron"]);
    assert.deepEqual(extraBodyFor("openrouter/inconnu/x", table), {
      provider: { ignore: ["inceptron"] },
    });
  });

  test("global et par modèle se cumulent, sans doublon", () => {
    const table = tbl(
      { m: { quantizations: ["fp8"], deployable: true, ignore: ["novita", "inceptron"] } },
      ["inceptron"],
    );
    assert.deepEqual(ignoredProvidersFor("m", table), ["inceptron", "novita"]);
  });

  test("aucun ignore nulle part : rien n'est ajouté au corps", () => {
    assert.deepEqual(extraBodyFor("openrouter/openai/gpt-oss-120b", TABLE), {
      provider: { quantizations: ["fp4"], allow_fallbacks: false },
    });
  });

  test("l'entrée « * » refuse une quantification — elle n'aurait pas de sens", () => {
    // Chaque modèle a la sienne ; en imposer une globalement laisserait croire
    // le contraire.
    assert.throws(
      () => parseQuantizationTable({ "*": { quantizations: ["fp8"] } }, "t"),
      /l'entrée "\*" n'accepte que "ignore"/,
    );
  });

  test("un slug vide ou non-chaîne est refusé, et le message dit SLUG", () => {
    // Le nom affiché est « Inceptron », le slug « inceptron » — les confondre
    // produirait un ignore silencieusement inopérant.
    for (const bad of [["Inceptron", ""], "inceptron", [3]]) {
      assert.throws(
        () => parseQuantizationTable({ "*": { ignore: bad } }, "t"),
        /ignore doit être un tableau de slugs/,
      );
    }
  });
});

describe("parseQuantizationTable — fail-closed, comme projects.json", () => {
  test("table vide ou absente : acceptée, routage libre", () => {
    assert.deepEqual(parseQuantizationTable(undefined, "t"), { models: {}, global: { ignore: [] } });
    assert.deepEqual(parseQuantizationTable({}, "t"), { models: {}, global: { ignore: [] } });
  });

  test("une quantification inventée est REFUSÉE", () => {
    // Elle ferait échouer tous les appels du modèle par un 404 OpenRouter, et
    // ce chantier existe pour ne plus découvrir ça au dépouillement.
    assert.throws(
      () => parseQuantizationTable({ m: { quantizations: ["q4_k_m"], deployable: true } }, "t"),
      /n'est pas une quantification OpenRouter/,
    );
  });

  test("les douze valeurs d'OpenRouter sont acceptées", () => {
    for (const q of ["int4", "int8", "fp4", "mxfp4", "nvfp4", "fp6", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"]) {
      const table = parseQuantizationTable({ m: { quantizations: [q], deployable: true } }, "t");
      assert.deepEqual(table.models.m?.quantizations, [q]);
    }
  });

  test("liste vide refusée : elle ne contraindrait rien tout en le prétendant", () => {
    assert.throws(
      () => parseQuantizationTable({ m: { quantizations: [], deployable: true } }, "t"),
      /tableau non vide/,
    );
  });

  test("deployable manquant ou non booléen : refusé", () => {
    assert.throws(
      () => parseQuantizationTable({ m: { quantizations: ["fp8"] } }, "t"),
      /deployable doit être un booléen/,
    );
    assert.throws(
      () => parseQuantizationTable({ m: { quantizations: ["fp8"], deployable: "oui" } }, "t"),
      /deployable doit être un booléen/,
    );
  });

  test("clé inconnue refusée plutôt qu'ignorée", () => {
    // Un « quantization » au singulier qui ne ferait rien serait le pire cas :
    // on croirait mesurer du fp8 sans en mesurer.
    assert.throws(
      () => parseQuantizationTable({ m: { quantization: ["fp8"], deployable: true } }, "t"),
      /clé inconnue "quantization"/,
    );
  });

  test("le message nomme le modèle fautif", () => {
    assert.throws(
      () => parseQuantizationTable({ "openrouter/z-ai/glm-5.2": 3 }, "quantizations.json"),
      /quantizations\.json → "openrouter\/z-ai\/glm-5\.2"/,
    );
  });
});

describe("loadQuantizationTable — absent tolérant, présent exigeant", () => {
  test("fichier absent : table vide, comportement inchangé", () => {
    assert.deepEqual(
      loadQuantizationTable(join(tmpdir(), "cds-quantizations-inexistant.json")),
      { models: {}, global: { ignore: [] } },
    );
  });

  test("fichier présent mais invalide : ÉCHOUE", () => {
    // Quelqu'un a voulu contraindre le routage : le faire à moitié serait pire
    // que pas du tout.
    const dir = mkdtempSync(join(tmpdir(), "cds-quant-"));
    try {
      const path = join(dir, "q.json");
      writeFileSync(path, "{ pas du JSON", "utf8");
      assert.throws(() => loadQuantizationTable(path), /JSON invalide/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fichier valide : relu tel quel", () => {
    const dir = mkdtempSync(join(tmpdir(), "cds-quant-"));
    try {
      const path = join(dir, "q.json");
      writeFileSync(path, JSON.stringify({ m: { quantizations: ["fp8"], deployable: true } }));
      assert.deepEqual(loadQuantizationTable(path), {
        models: { m: { quantizations: ["fp8"], deployable: true, ignore: [] } },
        global: { ignore: [] },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ce qui atterrit dans le CSV", () => {
  test("la quantification, ou « libre » si personne n'a contraint", () => {
    assert.equal(describeQuantization("openrouter/openai/gpt-oss-120b", TABLE), "fp4");
    assert.equal(describeQuantization("openrouter/inconnu/modele", TABLE), "libre");
    assert.equal(
      describeQuantization("m", tbl({ m: { quantizations: ["int4", "fp4"], deployable: false } })),
      "int4+fp4",
    );
  });

  test("deployable : oui / non / ? — et « ? » n'est PAS « non »", () => {
    // Écrire « non » pour un modèle absent laisserait croire qu'une borne
    // haute a été identifiée comme telle, alors que personne ne s'est
    // prononcé.
    assert.equal(describeDeployable("openrouter/openai/gpt-oss-120b", TABLE), "oui");
    assert.equal(describeDeployable("openrouter/moonshotai/kimi-k2.6", TABLE), "non");
    assert.equal(describeDeployable("openrouter/inconnu/modele", TABLE), "?");
  });
});

describe("la table livrée est cohérente avec le banc", () => {
  test("quantizations.json se charge et couvre les modèles du banc", () => {
    // Une table qui ne se charge pas empêcherait le daemon de démarrer ; une
    // table qui ne couvre pas un modèle du banc le laisserait en routage libre
    // sans que personne ne le remarque avant le dépouillement.
    const table = loadQuantizationTable("quantizations.json");
    // Inceptron rend 422 sur tout message d'assistant sans `content` : il a
    // fait échouer minimax et kimi le 4 août 2026, et allow_fallbacks:false
    // interdit de le contourner.
    assert.ok(
      table.global.ignore.includes("inceptron"),
      "inceptron doit rester écarté globalement",
    );
    const models = readFileSync("bench-models.txt", "utf8")
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim().split(/\s+/)[0])
      .filter((model): model is string => Boolean(model));

    const manquants = models.filter((model) => !(model in table.models));
    assert.deepEqual(manquants, [], `modèles du banc absents de la table : ${manquants.join(", ")}`);
  });
});
