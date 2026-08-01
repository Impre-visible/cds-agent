import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentSandboxFixture,
  providerOf,
  runAndReadOpencodeConfig,
  type AgentSandboxFixture,
} from "./inference-fixture.ts";

/**
 * Dérogation CONTAINER_INFERENCE_URL : le proxy filtrant est court-circuité,
 * le conteneur parle directement à l'URL indiquée. Plus personne n'est alors
 * en position d'ajouter l'en-tête Authorization à sa place — la clé DOIT
 * descendre dans le conteneur, sans quoi un fournisseur distant répondrait
 * 401. Ce test fige ce compromis explicitement plutôt que de le laisser se
 * découvrir en production.
 *
 * Fichier séparé du scénario "proxy" (inference-remote.test.ts) : voir
 * inference-fixture.ts pour la raison (config.ts figé au chargement).
 */

const SECRET = "cle-fournisseur-tres-secrete";

describe("inférence distante — dérogation CONTAINER_INFERENCE_URL", () => {
  let fixture: AgentSandboxFixture;
  let runAgentInSandbox: Parameters<typeof runAndReadOpencodeConfig>[0];

  before(async () => {
    fixture = createAgentSandboxFixture();
    process.env.INFERENCE_API_KEY = SECRET;
    process.env.CONTAINER_INFERENCE_URL = "https://api.exemple.test/v1";
    process.env.AGENT_MODEL = "scaleway/mistral-nemo-instruct";
    ({ runAgentInSandbox } = await import("../../src/agent/sandbox.ts"));
  });

  after(() => {
    fixture.cleanup();
    delete process.env.INFERENCE_API_KEY;
    delete process.env.CONTAINER_INFERENCE_URL;
    delete process.env.AGENT_MODEL;
  });

  test("sans proxy, la clé est confiée au conteneur — prix assumé de l'échappatoire", async () => {
    const { argv, opencodeConfig } = await runAndReadOpencodeConfig(
      runAgentInSandbox,
      fixture,
    );
    const provider = providerOf(opencodeConfig, "scaleway");

    assert.equal(provider.options.baseURL, "https://api.exemple.test/v1");
    assert.equal(
      provider.options.apiKey,
      SECRET,
      "personne d'autre ne peut authentifier la requête sur ce chemin",
    );

    // L'upstream n'est pas host.docker.internal : --add-host n'a alors aucune
    // raison d'être accordé (voir needsHostGateway dans sandbox.ts).
    assert.ok(
      !argv.includes("host.docker.internal:host-gateway"),
      "aucun alias vers l'hôte n'est utile quand l'inférence est distante",
    );
  });
});
