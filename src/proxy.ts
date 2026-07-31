import { createServer, request as httpRequest } from "node:http";
import { writeFileSync } from "node:fs";

const UPSTREAM = { host: "127.0.0.1", port: 1234 };
const PORT = 1235;

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));

  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const isChat = req.url?.includes("chat/completions") ?? false;

    if (isChat) {
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        const messages = parsed.messages ?? [];
        const tools = parsed.tools ?? [];
        const chars = JSON.stringify(messages).length + JSON.stringify(tools).length;

        console.log(`\n--- requête ---`);
        console.log(`  modèle   : ${parsed.model}`);
        console.log(`  stream   : ${parsed.stream === true}`);
        console.log(`  messages : ${messages.length}`);
        console.log(`  outils   : ${tools.length} → ${tools.map((t: any) => t.function?.name).join(", ")}`);
        console.log(`  volume   : ${chars} car. (~${Math.round(chars / 3.5)} tokens)`);
        writeFileSync("/tmp/cds-proxy-request.json", JSON.stringify(parsed, null, 2), "utf8");
      } catch {
        console.log("  corps non JSON");
      }
    }

    const proxied = httpRequest(
      {
        host: UPSTREAM.host,
        port: UPSTREAM.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}` },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        let seen = "";
        upstream.on("data", (chunk: Buffer) => {
          seen += chunk.toString("utf8");
          res.write(chunk);
        });
        upstream.on("end", () => {
          res.end();
          if (isChat) {
            const tool = seen.includes("tool_calls");
            const narration = seen.includes("```bash") || seen.includes("TOOL_REQUEST");
            console.log(`  réponse  : tool_calls=${tool}  narration=${narration}`);
            writeFileSync("/tmp/cds-proxy-response.txt", seen, "utf8");
          }
        });
      },
    );

    proxied.on("error", (error) => {
      res.writeHead(502);
      res.end(String(error));
    });
    proxied.end(body);
  });
}).listen(PORT, () => {
  console.log(`proxy http://127.0.0.1:${PORT} → ${UPSTREAM.host}:${UPSTREAM.port}`);
});
