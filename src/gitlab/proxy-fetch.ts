import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { Duplex } from "node:stream";

/**
 * §A (durcissement proxy d'entreprise) : `fetch()` natif de Node n'honore
 * *aucune* variable de proxy par défaut — contrairement à `git`, qui lit son
 * propre `http.<url>.proxy` depuis `~/.gitconfig`. Node 26 propose bien un
 * mécanisme natif (`--use-env-proxy` / `NODE_USE_ENV_PROXY`), mais vérifié
 * empiriquement dans cet environnement (Node 24.14 et 26.3, via
 * `diagnostics_channel` sur `undici:client:connectError` pour observer le
 * host réellement contacté) : ce mécanisme fonctionne pour `node:http`/
 * `node:https`, PAS pour `fetch()` — la connexion part tout droit vers la
 * cible, jamais vers le proxy, quel que soit `HTTP_PROXY`/`HTTPS_PROXY`, la
 * variable ou le flag. Voir le rapport de la tâche pour le détail des tests
 * qui l'ont établi (aucune dépendance à ce comportement, potentiellement
 * spécifique à cette version de Node, n'est donc prise ici).
 *
 * Ce module réimplémente, sur les seules primitives `node:http`/
 * `node:https`/`node:tls`, le strict nécessaire pour qu'une requête
 * `fetch()`-like reparte vers le proxy configuré — indépendamment de tout
 * flag Node, donc de la façon dont le daemon a été démarré (`npm run dev`
 * ou `tsx src/daemon/index.ts` directement, voir README). Utilisé
 * uniquement quand un proxy s'applique réellement à l'URL visée
 * (selectProxyForUrl) : sans HTTP_PROXY/HTTPS_PROXY dans l'environnement,
 * cette fonction n'entre jamais en jeu et `resilientFetch` continue
 * d'utiliser le `fetch()` natif tel quel — cas nominal (développement local
 * sans proxy) strictement inchangé.
 */

function readProxyEnv(name: string): string {
  return process.env[name] || process.env[name.toLowerCase()] || "";
}

/**
 * Convention NO_PROXY usuelle (curl, undici...) : entrées séparées par des
 * virgules ou des espaces, "*" désactive tout proxy pour tout hôte, une
 * entrée "hôte[:port]" matche l'hôte exact ou l'un de ses sous-domaines (un
 * "." de tête est équivalent, purement cosmétique — "*.example.com" et
 * "example.com" ont le même effet ici).
 */
function matchesNoProxy(hostname: string, port: number, noProxy: string): boolean {
  const entries = noProxy
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return false;
  if (entries.includes("*")) return true;

  const host = hostname.toLowerCase();
  for (const entry of entries) {
    const withPort = entry.match(/^(.+):(\d+)$/);
    const entryHost = (withPort?.[1] ?? entry).replace(/^\.|^\*/, "").toLowerCase();
    const entryPort = withPort?.[2] !== undefined ? Number(withPort[2]) : null;
    if (entryPort !== null && entryPort !== port) continue;
    if (host === entryHost || host.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

/**
 * Résout le proxy à utiliser pour une URL cible donnée, ou `null` si aucun
 * ne s'applique (pas de HTTP_PROXY/HTTPS_PROXY pertinent, ou hôte couvert
 * par NO_PROXY) — auquel cas l'appelant doit retomber sur le `fetch()`
 * natif, pas sur ce module.
 */
export function selectProxyForUrl(target: URL): URL | null {
  const port = target.port
    ? Number(target.port)
    : target.protocol === "https:"
      ? 443
      : 80;
  if (matchesNoProxy(target.hostname, port, readProxyEnv("NO_PROXY"))) return null;

  const raw =
    target.protocol === "https:" ? readProxyEnv("HTTPS_PROXY") : readProxyEnv("HTTP_PROXY");
  if (!raw) return null;

  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * En-tête Proxy-Authorization si le proxy porte des identifiants dans son
 * URL (`http://utilisateur:motdepasse@proxy:port`, forme vue en pratique
 * pour un proxy d'entreprise authentifié). Jamais loggé ailleurs dans ce
 * module : ces identifiants peuvent être un secret à part entière (observé
 * en pratique : un jeton GitLab réutilisé comme mot de passe de proxy).
 */
function proxyAuthHeader(proxyUrl: URL): Record<string, string> {
  if (!proxyUrl.username) return {};
  const credentials = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
  return { "Proxy-Authorization": `Basic ${Buffer.from(credentials).toString("base64")}` };
}

function toBodyBuffer(body: unknown): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  if (Buffer.isBuffer(body)) return body;
  throw new Error(
    "proxy-fetch: type de corps de requête non supporté (attendu: string | URLSearchParams | Buffer)",
  );
}

// RequestInit["headers"] plutôt qu'un import direct de HeadersInit (défini
// dans undici-types, pas réexporté globalement par @types/node) : indexer le
// type déjà global évite une dépendance à un module qui n'est pas le nôtre.
function normalizeHeaders(headers: RequestInit["headers"]): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers } as Record<string, string>;
}

function nodeHeadersToFetchHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(key, entry);
  }
  return headers;
}

function collectResponse(res: http.IncomingMessage): Promise<Response> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => {
      resolve(
        new Response(Buffer.concat(chunks), {
          status: res.statusCode ?? 502,
          statusText: res.statusMessage ?? "",
          headers: nodeHeadersToFetchHeaders(res.headers),
        }),
      );
    });
    res.on("error", reject);
  });
}

/**
 * `https.Agent` à usage unique dont `createConnection` restitue directement
 * la socket TLS déjà établie à travers le tunnel CONNECT (voir
 * requestOverHttpsProxy) — jamais de véritable résolution DNS ni connexion :
 * la connexion existe déjà, seul le protocole HTTP par-dessus reste à
 * dérouler.
 */
class TunnelAgent extends https.Agent {
  private socket: tls.TLSSocket | undefined;

  constructor(socket: tls.TLSSocket) {
    super({ keepAlive: false });
    this.socket = socket;
  }

  createConnection(
    _options: unknown,
    callback?: (error: Error | null, socket: Duplex) => void,
  ): Duplex | null | undefined {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) {
      // Le typage de `Agent.createConnection` exige un `Duplex` non
      // optionnel en cas de succès ; ce chemin d'erreur n'a rien à donner —
      // `as Duplex` documente que c'est un cas d'échec, jamais consommé.
      callback?.(
        new Error("TunnelAgent : socket déjà consommée (une seule requête supportée)"),
        undefined as unknown as Duplex,
      );
      return undefined;
    }
    callback?.(null, socket);
    return undefined;
  }
}

/** Détache un abandon (AbortSignal) précédemment attaché — voir attachAbort. */
type Detach = () => void;

/**
 * Relie un AbortSignal à la destruction d'une requête en cours — même
 * contrat que le `signal` de `fetch()` : un abandon déjà survenu avant même
 * l'appel se déclenche au prochain tick plutôt que de façon réentrante.
 */
function attachAbort(
  signal: AbortSignal | null | undefined,
  destroy: (reason: unknown) => void,
): Detach {
  if (!signal) return () => {};
  if (signal.aborted) {
    queueMicrotask(() => destroy(signal.reason));
    return () => {};
  }
  const onAbort = () => destroy(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Requête à travers un proxy HTTP simple (cible en http:) : la ligne de
 * requête porte l'URI absolue de la cible (RFC 7230 §5.3.2) — le proxy sait
 * alors où relayer, aucun tunnel n'est nécessaire (contrairement au HTTPS
 * ci-dessous, où le contenu doit rester chiffré de bout en bout).
 */
function requestOverHttpProxy(
  target: URL,
  proxyUrl: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port ? Number(proxyUrl.port) : 80,
      method,
      path: target.toString(),
      headers: { ...headers, host: target.host, ...proxyAuthHeader(proxyUrl) },
    });

    const detach = attachAbort(signal, (reason) => req.destroy(reason as Error));

    req.on("error", (error) => {
      detach();
      reject(error);
    });
    req.on("response", (res) => {
      detach();
      collectResponse(res).then(resolve, reject);
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * Requête à travers un proxy HTTPS (cible en https: — le cas réel pour une
 * instance GitLab) : tunnel `CONNECT` d'abord (RFC 7231 §4.3.6), puis TLS
 * par-dessus la socket brute obtenue, exactement comme le ferait un
 * navigateur ou `curl` derrière un proxy d'entreprise. `TunnelAgent`
 * ci-dessus permet à `https.request` de dérouler la requête HTTP sur cette
 * socket déjà établie, sans jamais tenter sa propre connexion.
 */
function requestOverHttpsProxy(
  target: URL,
  proxyUrl: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port ? Number(proxyUrl.port) : 80,
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: proxyAuthHeader(proxyUrl),
    });

    let detachConnect = attachAbort(signal, (reason) => connectReq.destroy(reason as Error));

    connectReq.on("error", (error) => {
      detachConnect();
      reject(error);
    });

    connectReq.on("connect", (res, socket) => {
      detachConnect();
      if ((res.statusCode ?? 0) !== 200) {
        socket.destroy();
        reject(new Error(`tunnel proxy refusé (CONNECT ${res.statusCode})`));
        return;
      }

      const tlsSocket = tls.connect({ socket, servername: target.hostname });
      tlsSocket.on("error", reject);

      const req = https.request({
        method,
        path: `${target.pathname}${target.search}`,
        headers: { ...headers, host: target.host },
        agent: new TunnelAgent(tlsSocket),
      });

      const detachRequest = attachAbort(signal, (reason) => req.destroy(reason as Error));

      req.on("error", (error) => {
        detachRequest();
        reject(error);
      });
      req.on("response", (innerRes) => {
        detachRequest();
        collectResponse(innerRes).then(resolve, reject);
      });

      if (body) req.write(body);
      req.end();
    });

    connectReq.end();
    // Réassigné à un no-op une fois le CONNECT retombé sur detachConnect() ci-dessus,
    // pour ne pas détacher deux fois le même listener sans effet de bord.
    detachConnect = () => {};
  });
}

/**
 * Remplacement de `fetch()` conscient du proxy — voir le commentaire en tête
 * de fichier. Retombe sur le `fetch()` natif dès qu'aucun proxy ne
 * s'applique à l'URL visée : c'est le chemin emprunté par tous les tests
 * existants (aucun ne positionne HTTP_PROXY/HTTPS_PROXY), donc strictement
 * sans risque de régression sur eux.
 */
export function performFetch(url: string, init: RequestInit): Promise<Response> {
  const target = new URL(url);
  const proxyUrl = selectProxyForUrl(target);
  if (!proxyUrl) return fetch(url, init);

  const method = (init.method ?? "GET").toUpperCase();
  const headers = normalizeHeaders(init.headers);
  const body = toBodyBuffer(init.body);
  const signal = init.signal;

  return target.protocol === "https:"
    ? requestOverHttpsProxy(target, proxyUrl, method, headers, body, signal)
    : requestOverHttpProxy(target, proxyUrl, method, headers, body, signal);
}
