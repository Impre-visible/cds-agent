import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";

// Pas de dépendance à config.ts ici (contrairement à client.test.ts) :
// proxy-fetch.ts n'importe pas config.ts, donc pas besoin de GITLAB_TOKEN/
// BOT_USERNAME avant l'import.
let selectProxyForUrl: (target: URL) => URL | null;
let performFetch: (url: string, init: RequestInit) => Promise<Response>;

before(async () => {
  ({ selectProxyForUrl, performFetch } = await import("../../src/gitlab/proxy-fetch.ts"));
});

const PROXY_ENV_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of PROXY_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("selectProxyForUrl", () => {
  test("aucun proxy configuré : retourne null (cas nominal, aucun changement de comportement)", () => {
    assert.equal(selectProxyForUrl(new URL("http://example.invalid/x")), null);
    assert.equal(selectProxyForUrl(new URL("https://example.invalid/x")), null);
  });

  test("HTTP_PROXY s'applique aux cibles http:, HTTPS_PROXY aux cibles https:", () => {
    process.env.HTTP_PROXY = "http://proxy-http.invalid:3128";
    process.env.HTTPS_PROXY = "http://proxy-https.invalid:3129";

    const http = selectProxyForUrl(new URL("http://example.invalid/x"));
    const https = selectProxyForUrl(new URL("https://example.invalid/x"));

    assert.equal(http?.hostname, "proxy-http.invalid");
    assert.equal(https?.hostname, "proxy-https.invalid");
  });

  test("NO_PROXY exclut l'hôte exact", () => {
    process.env.HTTP_PROXY = "http://proxy.invalid:3128";
    process.env.NO_PROXY = "example.invalid";

    assert.equal(selectProxyForUrl(new URL("http://example.invalid/x")), null);
    // Un hôte différent n'est pas couvert par cette entrée NO_PROXY.
    assert.notEqual(selectProxyForUrl(new URL("http://autre.invalid/x")), null);
  });

  test("NO_PROXY couvre aussi les sous-domaines", () => {
    process.env.HTTP_PROXY = "http://proxy.invalid:3128";
    process.env.NO_PROXY = "corp.invalid";

    assert.equal(selectProxyForUrl(new URL("http://gitlab.corp.invalid/x")), null);
  });

  test('NO_PROXY="*" désactive le proxy pour tout le monde', () => {
    process.env.HTTP_PROXY = "http://proxy.invalid:3128";
    process.env.NO_PROXY = "*";

    assert.equal(selectProxyForUrl(new URL("http://n-importe-quoi.invalid/x")), null);
  });

  test("variantes minuscules (http_proxy/https_proxy/no_proxy) reconnues", () => {
    process.env.http_proxy = "http://proxy-minuscule.invalid:3128";
    assert.equal(
      selectProxyForUrl(new URL("http://example.invalid/x"))?.hostname,
      "proxy-minuscule.invalid",
    );
  });
});

/**
 * Faux proxy HTTP jetable, sur le même modèle que les serveurs `node:http`
 * de gitlab/client.test.ts et tasks/publish.test.ts : compte les connexions
 * reçues (méthode + url tels que vus par le proxy), pour vérifier qu'une
 * requête est bien repartie vers LUI plutôt que directement vers la cible.
 */
function startFakeProxy(): Promise<{
  port: number;
  hits: { method: string; url: string }[];
  connectHits: string[];
  close: () => Promise<void>;
}> {
  const hits: { method: string; url: string }[] = [];
  const connectHits: string[] = [];
  // Une socket "upgradée" par un CONNECT n'est pas suivie comme une requête
  // HTTP normale par node:http : server.close()/closeAllConnections()
  // n'attendent/ne ferment jamais cette socket-là toute seule (vérifié
  // empiriquement : server.close() reste sinon bloqué indéfiniment après un
  // CONNECT, même une fois le client TLS retombé en erreur côté appelant).
  // On la garde donc de côté pour la détruire nous-mêmes à la fermeture.
  const connectSockets: { destroy(): void }[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push({ method: req.method ?? "", url: req.url ?? "" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ viaProxy: true }));
  });

  // CONNECT (tunnel HTTPS) : on note la cible demandée puis on ferme —
  // suffisant pour prouver que le proxy a bien été sollicité, sans avoir à
  // dérouler un vrai handshake TLS ensuite (voir la description du test
  // dédié plus bas).
  server.on("connect", (req, socket) => {
    connectHits.push(req.url ?? "");
    connectSockets.push(socket);
    socket.end("HTTP/1.1 200 Connection Established\r\n\r\n");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({
        port,
        hits,
        connectHits,
        close: () => {
          for (const socket of connectSockets) socket.destroy();
          server.closeAllConnections();
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
  });
}

describe("performFetch — cible http:, proxy HTTP simple", () => {
  test("avec un proxy configuré, la requête part vers le proxy (compté), pas directement vers la cible", async () => {
    const proxy = await startFakeProxy();
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;

    try {
      const res = await performFetch("http://cible.invalid/api/v4/test", {
        method: "GET",
        headers: { "X-Test": "1" },
      });
      const body = await res.json();

      assert.equal(proxy.hits.length, 1, "le proxy doit avoir reçu exactement une connexion");
      assert.equal(proxy.hits[0]?.method, "GET");
      // Forme d'URI absolue (RFC 7230 §5.3.2) : le proxy sait ainsi où relayer.
      assert.equal(proxy.hits[0]?.url, "http://cible.invalid/api/v4/test");
      assert.deepEqual(body, { viaProxy: true });
      assert.equal(res.status, 200);
    } finally {
      await proxy.close();
    }
  });

  test("sans proxy configuré, rien ne change : la requête part directement vers la cible", async () => {
    // Ici la "cible" est notre propre serveur local (pas de proxy impliqué) :
    // performFetch doit s'y connecter directement, exactement comme fetch()
    // natif l'aurait fait.
    const origin = await startFakeProxy(); // réutilisé comme simple serveur HTTP
    try {
      const res = await performFetch(`http://127.0.0.1:${origin.port}/direct`, {
        method: "GET",
      });
      assert.equal(res.status, 200);
      assert.equal(origin.hits.length, 1);
      assert.equal(origin.hits[0]?.url, "/direct", "forme origine, pas absolue : pas de proxy impliqué");
    } finally {
      await origin.close();
    }
  });

  test("NO_PROXY respecté : l'hôte exclu est atteint directement, pas via le proxy", async () => {
    const proxy = await startFakeProxy();
    const directTarget = await startFakeProxy(); // sert de serveur "direct"
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    process.env.NO_PROXY = "127.0.0.1";

    try {
      const res = await performFetch(`http://127.0.0.1:${directTarget.port}/direct`, {
        method: "GET",
      });
      assert.equal(res.status, 200);
      assert.equal(proxy.hits.length, 0, "le proxy ne doit recevoir aucune connexion");
      assert.equal(directTarget.hits.length, 1, "la cible doit être atteinte directement");
    } finally {
      await proxy.close();
      await directTarget.close();
    }
  });

  test("un corps (POST, URLSearchParams-like string) est bien transmis à travers le proxy", async () => {
    const proxy = await startFakeProxy();
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;

    try {
      await performFetch("http://cible.invalid/api/v4/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "hello" }),
      });
      assert.equal(proxy.hits.length, 1);
      assert.equal(proxy.hits[0]?.method, "POST");
    } finally {
      await proxy.close();
    }
  });
});

describe("performFetch — cible https:, tunnel CONNECT", () => {
  test("avec HTTPS_PROXY configuré, un tunnel CONNECT est bien demandé au proxy vers hôte:443", async () => {
    const proxy = await startFakeProxy();
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;

    try {
      // Le proxy de test répond au CONNECT puis ferme la socket sans faire de
      // TLS réel : la requête HTTPS elle-même échoue nécessairement ensuite
      // (pas un vrai serveur TLS de l'autre côté) — ce qui nous intéresse ici
      // est la preuve que le CONNECT est bien parti vers le proxy, avec la
      // bonne cible, pas la réussite de bout en bout (déjà couverte côté
      // http: ci-dessus, où le protocole ne nécessite pas de tunnel).
      await assert.rejects(() =>
        performFetch("https://cible-https.invalid/api/v4/test", { method: "GET" }),
      );
      assert.equal(proxy.connectHits.length, 1);
      assert.equal(proxy.connectHits[0], "cible-https.invalid:443");
    } finally {
      await proxy.close();
    }
  });
});
