import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

/**
 * Le daemon tournant LUI-MÊME en conteneur (docker-compose.yml).
 *
 * Fichier séparé de sandbox.test.ts parce que config.ts fige la configuration
 * au chargement du module : l'environnement doit différer AVANT l'import, donc
 * dans un processus distinct (même raison qu'inference-direct.test.ts et
 * implement-no-conventions.test.ts).
 *
 * Ce que ces deux réglages évitent, et pourquoi ils méritent un test plutôt
 * qu'une ligne de documentation — les deux échecs sont SILENCIEUX :
 *
 * - sans AGENT_DOCKER_NETWORK, les conteneurs agent partent sur `bridge` et ne
 *   partagent aucun réseau avec le daemon : ils ne peuvent plus le joindre par
 *   son nom. Vérifié à la main, `getent hosts cds-agent-daemon` ne résout pas
 *   depuis `bridge` mais résout depuis le réseau partagé ;
 * - sans INFERENCE_PROXY_HOST, l'agent reçoit `host.docker.internal`, qui
 *   désigne l'HÔTE. Le proxy, lui, écoute dans le conteneur du daemon : la
 *   requête part vers une machine où personne n'écoute sur ce port.
 */

let buildDockerRunArgs: typeof import("../../src/agent/sandbox.ts").buildDockerRunArgs;
let startInferenceProxy: typeof import("../../src/tools/proxy.ts").startInferenceProxy;

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  process.env.AGENT_DOCKER_NETWORK = "cds-agent-net";
  process.env.INFERENCE_PROXY_HOST = "cds-agent-daemon";
  ({ buildDockerRunArgs } = await import("../../src/agent/sandbox.ts"));
  ({ startInferenceProxy } = await import("../../src/tools/proxy.ts"));
});

function networkOf(args: string[]): string | undefined {
  return args[args.indexOf("--network") + 1];
}

describe("AGENT_DOCKER_NETWORK — l'agent doit partager un réseau avec le daemon", () => {
  test("un conteneur qui a besoin du réseau rejoint le réseau configuré, pas bridge", () => {
    const args = buildDockerRunArgs("/repo", "img", "cmd", "nom", {
      network: true,
    });
    assert.equal(networkOf(args), "cds-agent-net");
  });

  test("sans réseau demandé, on reste sur `none` : le durcissement ne bouge pas", () => {
    // Le point à ne surtout pas régresser : ce réglage sert à JOINDRE le
    // daemon, pas à ouvrir le réseau des conteneurs qui n'en ont pas besoin.
    const args = buildDockerRunArgs("/repo", "img", "cmd", "nom", {
      network: false,
    });
    assert.equal(networkOf(args), "none");
    assert.equal(networkOf(buildDockerRunArgs("/repo", "img", "cmd", "nom")), "none");
  });

  test("le reste du durcissement est intact", () => {
    const args = buildDockerRunArgs("/repo", "img", "cmd", "nom", {
      network: true,
    });
    for (const flag of ["--cap-drop", "--read-only", "--security-opt", "--pids-limit"]) {
      assert.ok(args.includes(flag), `${flag} absent`);
    }
    assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  });
});

describe("INFERENCE_PROXY_HOST — l'agent joint le daemon, pas l'hôte", () => {
  test("containerUrl annonce le nom configuré, jamais host.docker.internal", async () => {
    const proxy = await startInferenceProxy({
      upstreamUrl: "http://127.0.0.1:9/v1",
      advertiseHost: "cds-agent-daemon",
    });
    try {
      assert.match(proxy.containerUrl, /^http:\/\/cds-agent-daemon:\d+\/v1$/);
      assert.doesNotMatch(proxy.containerUrl, /host\.docker\.internal/);
    } finally {
      await proxy.close();
    }
  });

  test("sans advertiseHost, le défaut historique est conservé au caractère près", async () => {
    // C'est la condition pour que le lancement depuis un terminal — le mode
    // par défaut, mesuré — ne change strictement pas.
    const proxy = await startInferenceProxy({ upstreamUrl: "http://127.0.0.1:9/v1" });
    try {
      assert.match(proxy.containerUrl, /^http:\/\/host\.docker\.internal:\d+\/v1$/);
    } finally {
      await proxy.close();
    }
  });

  test("le chemin de l'upstream est conservé quel que soit l'hôte annoncé", async () => {
    const proxy = await startInferenceProxy({
      upstreamUrl: "https://exemple.invalid/api/v1",
      advertiseHost: "cds-agent-daemon",
    });
    try {
      assert.match(proxy.containerUrl, /\/api\/v1$/);
    } finally {
      await proxy.close();
    }
  });
});
