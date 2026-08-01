import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../config.ts";

interface ChatCompletionPayload {
  model?: string;
  stream?: boolean;
  messages?: unknown[];
  tools?: { function?: { name?: string } }[];
}

export interface InferenceProxyOptions {
  /**
   * Serveur d'inférence réel, vu depuis l'HÔTE (pas depuis un conteneur :
   * host.docker.internal n'a de sens que dans le netns d'un conteneur).
   */
  upstreamUrl: string;
  /**
   * Clé d'API de l'upstream (INFERENCE_API_KEY), absente pour une inférence
   * locale qui n'en demande pas. Renseignée, elle est ajoutée ICI en
   * `Authorization: Bearer` au moment de relayer : elle ne transite jamais
   * par le conteneur agent, qui ne voit que l'adresse de ce proxy.
   */
  apiKey?: string;
  /**
   * Nom d'hôte annoncé au conteneur agent dans `containerUrl`
   * (INFERENCE_PROXY_HOST, défaut `host.docker.internal`). Ce proxy écoute
   * toujours sur 0.0.0.0 ; seule change l'adresse par laquelle on dit à
   * l'agent de le joindre — l'hôte quand le daemon tourne dessus, le nom du
   * conteneur du daemon quand il tourne lui-même en conteneur.
   */
  advertiseHost?: string;
  /** Port d'écoute local ; 0 (recommandé) laisse l'OS choisir un port libre. */
  port?: number;
  /** Répertoire où déposer les traces requête/réponse (debug) ; omis = pas de trace disque. */
  logDir?: string;
}

export interface InferenceProxy {
  /** URL à donner au conteneur pour joindre ce proxy via host.docker.internal. */
  containerUrl: string;
  /** Port réellement lié (utile quand `port` valait 0). */
  port: number;
  close(): Promise<void>;
}

/**
 * Démarre un proxy HTTP filtrant entre le conteneur agent et le serveur
 * d'inférence réel (§1.7). Le conteneur agent ne reçoit QUE l'adresse de ce
 * proxy comme baseURL du modèle (voir runAgentInSandbox) — jamais une route
 * directe vers host.docker.internal, qui donnerait accès à tous les ports
 * de l'hôte, pas seulement celui de l'inférence.
 *
 * Limite assumée, à documenter clairement à l'appelant (voir le rapport de
 * la tâche pour le détail) : ce proxy ne restreint que le trafic
 * d'inférence configuré pour opencode. Il ne bloque PAS un appel réseau que
 * l'agent lancerait lui-même via un outil shell (curl, nc, un script
 * Python...) : le conteneur reste sur un réseau bridge avec accès à
 * host-gateway, donc potentiellement à internet et aux autres ports de
 * l'hôte. Fermer complètement cette porte demanderait un réseau Docker
 * "internal" dédié avec ce proxy comme seul point de sortie (conteneur à
 * double appartenance réseau, agent ↔ réseau interne ↔ proxy ↔ hôte/monde),
 * une bascule qui nécessite un Docker réellement lancé pour être construite
 * et vérifiée — non disponible dans ce contexte (voir contraintes de la
 * tâche).
 */
export function startInferenceProxy(
  options: InferenceProxyOptions,
): Promise<InferenceProxy> {
  const upstream = new URL(options.upstreamUrl);

  const server = createServer((req, res) => {
    handleRequest(req, res, upstream, options.apiKey, options.logDir);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // 0.0.0.0, pas 127.0.0.1 : le conteneur atteint ce process via
    // host.docker.internal, une adresse différente de la loopback locale du
    // host — un bind loopback-only serait injoignable depuis le conteneur
    // (piège classique de ce genre de proxy).
    server.listen(options.port ?? 0, "0.0.0.0", () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : (options.port ?? 0);
      resolve({
        containerUrl: `http://${options.advertiseHost ?? "host.docker.internal"}:${port}${upstream.pathname}`,
        port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

/**
 * En-têtes envoyés à l'upstream. `host` est réécrit (celui reçu désigne le
 * proxy, pas la cible — un upstream en vhost/TLS répondrait 404 ou refuserait
 * le SNI). L'`Authorization` est TOUJOURS remplacé quand une clé est
 * configurée : le conteneur envoie celui de sa configuration opencode (un
 * placeholder, voir agent/sandbox.ts) et il ne doit jamais primer sur la vraie
 * clé de l'hôte. Sans clé configurée on laisse passer ce que le client a
 * envoyé — comportement inchangé pour une inférence locale sans
 * authentification.
 */
function upstreamHeaders(
  req: IncomingMessage,
  upstream: URL,
  apiKey: string | undefined,
): NodeJS.Dict<string | string[]> {
  const headers: NodeJS.Dict<string | string[]> = {
    ...req.headers,
    host: upstream.host,
  };
  if (apiKey) {
    // Node normalise les en-têtes entrants en minuscules ; poser "authorization"
    // suffit donc à écraser celui du client, sans risque de doublon de casse.
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: URL,
  apiKey: string | undefined,
  logDir: string | undefined,
): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));

  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const isChat = req.url?.includes("chat/completions") ?? false;

    if (isChat && logDir) logChatRequest(body, logDir);

    // Un upstream distant (Scaleway, OpenRouter, une passerelle interne...)
    // est en HTTPS : le relayer avec node:http produirait une connexion en
    // clair sur le port 443, qui échoue de façon opaque côté TLS. Le choix
    // du client suit donc le protocole de l'URL upstream — la liaison
    // conteneur → proxy, elle, reste en HTTP local (voir containerUrl).
    const secure = upstream.protocol === "https:";
    const sendRequest = secure ? httpsRequest : httpRequest;

    const proxied = sendRequest(
      {
        host: upstream.hostname,
        port: upstream.port || (secure ? 443 : 80),
        path: req.url,
        method: req.method,
        headers: upstreamHeaders(req, upstream, apiKey),
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        const seen: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => {
          if (isChat && logDir) seen.push(chunk);
          res.write(chunk);
        });
        upstreamRes.on("end", () => {
          res.end();
          if (isChat && logDir) logChatResponse(Buffer.concat(seen), logDir);
        });
      },
    );

    proxied.on("error", (error) => {
      res.writeHead(502);
      res.end(String(error));
    });
    proxied.end(body);
  });
}

function logChatRequest(body: Buffer, logDir: string): void {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as ChatCompletionPayload;
    const messages = parsed.messages ?? [];
    const tools = parsed.tools ?? [];
    const chars =
      JSON.stringify(messages).length + JSON.stringify(tools).length;

    console.log(`\n--- requête ---`);
    console.log(`  modèle   : ${parsed.model}`);
    console.log(`  stream   : ${parsed.stream === true}`);
    console.log(`  messages : ${messages.length}`);
    console.log(
      `  outils   : ${tools.length} → ${tools.map((t) => t.function?.name).join(", ")}`,
    );
    console.log(`  volume   : ${chars} car. (~${Math.round(chars / 3.5)} tokens)`);
    // Un nom par pid plutôt qu'un chemin fixe en dur : évite d'écraser la
    // trace d'une requête précédente encore utile pendant le débogage si
    // deux exécutions se chevauchent, et reste confiné au tmpdir plutôt
    // qu'un chemin /tmp/cds-proxy-*.json partagé par tout le monde sur la
    // machine.
    writeFileSync(
      join(logDir, `cds-proxy-request-${process.pid}.json`),
      JSON.stringify(parsed, null, 2),
      "utf8",
    );
  } catch {
    console.log("  corps non JSON");
  }
}

function logChatResponse(body: Buffer, logDir: string): void {
  const seen = body.toString("utf8");
  const tool = seen.includes("tool_calls");
  const narration = seen.includes("```bash") || seen.includes("TOOL_REQUEST");
  console.log(`  réponse  : tool_calls=${tool}  narration=${narration}`);
  writeFileSync(
    join(logDir, `cds-proxy-response-${process.pid}.txt`),
    seen,
    "utf8",
  );
}

// CLI autonome (`npm run proxy`) : utile pour observer manuellement le
// trafic entre opencode et LM Studio en dehors de tout conteneur, sans
// dépendre de runAgentInSandbox. Piloté par la même config que le reste du
// daemon (INFERENCE_UPSTREAM_URL / INFERENCE_PROXY_PORT), plutôt que des
// 127.0.0.1:1234 → 1235 en dur comme avant ce correctif.
if (import.meta.url === `file://${process.argv[1]}`) {
  startInferenceProxy({
    upstreamUrl: config.inferenceUpstreamUrl,
    apiKey: config.inferenceApiKey,
    port: config.inferenceProxyPort,
    logDir: tmpdir(),
  }).then((proxy) => {
    console.log(
      `proxy http://0.0.0.0:${proxy.port} → ${config.inferenceUpstreamUrl}`,
    );
  });
}
