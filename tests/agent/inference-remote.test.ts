import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentSandboxFixture,
  providerOf,
  runAndReadOpencodeConfig,
  type AgentSandboxFixture,
} from "./inference-fixture.ts";

/**
 * INFERENCE_API_KEY : viser un fournisseur d'inférence distant (Scaleway,
 * OpenRouter, une passerelle interne) plutôt que LM Studio en local. La clé
 * est posée par le proxy de l'hôte — l'en-tête lui-même est vérifié dans
 * tests/tools/proxy.test.ts. Ce fichier couvre l'autre moitié du contrat,
 * côté conteneur : ce qui descend, ou surtout ne descend PAS, dans la
 * configuration opencode générée par runAgentInSandbox.
 *
 * L'environnement est posé avant l'import de sandbox.ts : config.ts fige la
 * configuration au chargement du module.
 */

const SECRET = "cle-fournisseur-tres-secrete";

describe("inférence distante — chemin normal (proxy filtrant)", () => {
  let fixture: AgentSandboxFixture;
  let runAgentInSandbox: Parameters<typeof runAndReadOpencodeConfig>[0];

  before(async () => {
    fixture = createAgentSandboxFixture();
    process.env.INFERENCE_API_KEY = SECRET;
    process.env.INFERENCE_UPSTREAM_URL = "https://api.exemple.test/v1";
    process.env.AGENT_MODEL = "scaleway/mistral-nemo-instruct";
    // Valeurs non par défaut : vérifie que ces deux variables sont réellement
    // câblées jusqu'à la config du conteneur, pas seulement que le bloc
    // `limit` existe.
    process.env.INFERENCE_CONTEXT_LIMIT = "64000";
    process.env.INFERENCE_OUTPUT_LIMIT = "8000";
    ({ runAgentInSandbox } = await import("../../src/agent/sandbox.ts"));
  });

  after(() => {
    fixture.cleanup();
    delete process.env.INFERENCE_API_KEY;
    delete process.env.INFERENCE_UPSTREAM_URL;
    delete process.env.AGENT_MODEL;
    delete process.env.INFERENCE_CONTEXT_LIMIT;
    delete process.env.INFERENCE_OUTPUT_LIMIT;
  });

  test("la clé n'atteint jamais le conteneur, et l'agent ne voit que le proxy local", async () => {
    const { argv, opencodeConfig } = await runAndReadOpencodeConfig(
      runAgentInSandbox,
      fixture,
    );
    const provider = providerOf(opencodeConfig, "scaleway");

    assert.equal(
      provider.options.apiKey,
      "lm-studio",
      "placeholder inerte : c'est le proxy de l'hôte qui authentifie",
    );
    // Vérification large : le secret ne doit apparaître NULLE PART dans la
    // ligne de commande docker (config opencode, autres -e, montages...).
    assert.ok(
      !argv.some((value) => value.includes(SECRET)),
      "INFERENCE_API_KEY ne doit jamais atteindre le conteneur agent",
    );
    assert.match(
      provider.options.baseURL,
      /^http:\/\/host\.docker\.internal:\d+\/v1$/,
    );
    assert.ok(
      !provider.options.baseURL.includes("api.exemple.test"),
      "l'URL du fournisseur reste connue du seul hôte",
    );
  });

  test("le fournisseur et le modèle déclarés à opencode suivent AGENT_MODEL", async () => {
    const { opencodeConfig } = await runAndReadOpencodeConfig(
      runAgentInSandbox,
      fixture,
    );

    // Le bloc provider doit porter le nom passé à `opencode run --model
    // <fournisseur>/<modèle>` : figé sur "lmstudio", opencode chercherait un
    // fournisseur qu'on ne lui a jamais décrit.
    assert.deepEqual(Object.keys(opencodeConfig.provider), ["scaleway"]);
    assert.deepEqual(Object.keys(providerOf(opencodeConfig, "scaleway").models), [
      "mistral-nemo-instruct",
    ]);
  });

  // Sans ce bloc, opencode réclame 32000 tokens de sortie par défaut
  // (opencode#1735) et trois modèles de la campagne du 1er août 2026
  // refusaient la requête avant même de commencer.
  test("le modèle déclare une limite de contexte et de sortie explicite", async () => {
    const { opencodeConfig } = await runAndReadOpencodeConfig(
      runAgentInSandbox,
      fixture,
    );
    const model = providerOf(opencodeConfig, "scaleway").models[
      "mistral-nemo-instruct"
    ] as { limit?: { context: number; output: number } };

    assert.deepEqual(model.limit, { context: 64_000, output: 8_000 });
  });
});
