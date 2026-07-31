import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startInferenceProxy } from "../../src/tools/proxy.ts";

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
