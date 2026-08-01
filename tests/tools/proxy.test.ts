import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// proxy.ts importe (transitivement) src/config.ts, qui jette au chargement du
// module si GITLAB_TOKEN ou BOT_USERNAME sont absents. Un import STATIQUE le
// déclenche avant que le corps du fichier ne tourne : ce test ne passait donc
// que sur une machine ayant un .env local, et échouait sur un runner CI
// vierge — mesuré au premier passage du workflow GitHub. Même parade que les
// autres tests du projet (review.test.ts, config.test.ts...) : variables
// renseignées AVANT un import dynamique.
let startInferenceProxy: typeof import("../../src/tools/proxy.ts").startInferenceProxy;

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  ({ startInferenceProxy } = await import("../../src/tools/proxy.ts"));
});

/** Petit serveur HTTP jetable qui joue le rôle du "vrai" LM Studio. */
function startFakeUpstream(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          echoedPath: req.url,
          echoedBody: Buffer.concat(chunks).toString("utf8"),
          echoedAuthorization: req.headers.authorization ?? null,
          echoedHost: req.headers.host ?? null,
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("startInferenceProxy (§1.7 : un seul endpoint joignable, pas tout host.docker.internal)", () => {
  test("relaie la requête vers l'upstream configuré et renvoie sa réponse telle quelle", async () => {
    const upstream = await startFakeUpstream();
    const proxy = await startInferenceProxy({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1`,
      port: 0,
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
        { method: "POST", body: JSON.stringify({ model: "x", messages: [] }) },
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        echoedPath: string;
        echoedBody: string;
      };
      assert.equal(body.echoedPath, "/v1/chat/completions");
      assert.match(body.echoedBody, /"model":"x"/);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("containerUrl pointe vers host.docker.internal et le port du proxy, jamais le port réel de l'upstream", async () => {
    const upstream = await startFakeUpstream();
    const proxy = await startInferenceProxy({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1`,
      port: 0,
    });

    try {
      assert.match(proxy.containerUrl, /^http:\/\/host\.docker\.internal:\d+\/v1$/);
      assert.ok(
        !proxy.containerUrl.includes(`:${upstream.port}`),
        "l'agent ne doit connaître que l'adresse du proxy, pas celle de l'upstream réel",
      );
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("INFERENCE_API_KEY : le proxy pose l'Authorization vers l'upstream, " +
    "sans que le conteneur ait eu à connaître la clé", async () => {
    const upstream = await startFakeUpstream();
    const proxy = await startInferenceProxy({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1`,
      apiKey: "cle-scaleway-secrete",
      port: 0,
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
        {
          method: "POST",
          // Ce que le conteneur envoie réellement : le placeholder inerte de
          // la config opencode générée par sandbox.ts.
          headers: { authorization: "Bearer lm-studio" },
          body: JSON.stringify({ model: "x", messages: [] }),
        },
      );
      const body = (await response.json()) as { echoedAuthorization: string };
      assert.equal(
        body.echoedAuthorization,
        "Bearer cle-scaleway-secrete",
        "la clé de l'hôte doit primer sur l'en-tête envoyé par le conteneur",
      );
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("sans clé configurée, l'en-tête du client passe tel quel (inférence locale inchangée)", async () => {
    const upstream = await startFakeUpstream();
    const proxy = await startInferenceProxy({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1`,
      port: 0,
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { authorization: "Bearer lm-studio" },
          body: "{}",
        },
      );
      const body = (await response.json()) as {
        echoedAuthorization: string | null;
        echoedHost: string;
      };
      assert.equal(body.echoedAuthorization, "Bearer lm-studio");
      // L'hôte reste celui de l'upstream, jamais celui du proxy : un
      // fournisseur en vhost/TLS refuserait autrement la requête.
      assert.equal(body.echoedHost, `127.0.0.1:${upstream.port}`);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("un upstream https:// est relayé en TLS, jamais en clair sur le même port", async () => {
    // Faute de certificat jetable, on vérifie le choix du client par la
    // NÉGATIVE : l'upstream est un serveur HTTP en clair déclaré en https://.
    // Un relais via node:http lui parlerait en clair et obtiendrait un 200
    // (le trafic d'inférence partirait alors en clair vers un fournisseur
    // distant, sans que rien ne le signale) ; node:https tente une poignée de
    // main TLS, que ce serveur ne peut pas honorer — d'où le 502.
    const upstream = await startFakeUpstream();
    const proxy = await startInferenceProxy({
      upstreamUrl: `https://127.0.0.1:${upstream.port}/v1`,
      port: 0,
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
        { method: "POST", body: "{}" },
      );
      assert.equal(response.status, 502);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("close() libère bien le port : une requête après fermeture échoue", async () => {
    const upstream = await startFakeUpstream();
    const proxy = await startInferenceProxy({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1`,
      port: 0,
    });
    const port = proxy.port;
    await proxy.close();
    await upstream.close();

    await assert.rejects(() =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        body: "{}",
      }),
    );
  });
});
