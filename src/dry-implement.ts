import { config } from "./env.ts";
import { gitlab, resourceKind } from "./gitlab.ts";
import { buildContext } from "./context.ts";
import { runImplement } from "./implement.ts";
import type { AgentRequest } from "./types.ts";

const iid = Number(process.argv[2]);
const branch = process.argv[3];
if (!iid || !branch) {
  console.error("usage : npm run implement -- <mr-iid> <branche>");
  process.exit(1);
}

const projectPath = config.allowedProjects[0]!;
const project = await gitlab.project(projectPath);

const request: AgentRequest = {
  key: `dry:implement:${iid}`,
  todoId: 0,
  projectId: project.id,
  projectPath,
  kind: resourceKind("MergeRequest")!,
  iid,
  noteId: null,
  requester: "dry-run",
  text: "implémente les tests pour la route /hello/:name",
  targetUrl: "",
};

const context = await buildContext(request);
const result = await runImplement(context, branch);

console.log(`\nstatut  : ${result.status}`);
console.log(`détail  : ${result.detail}`);
console.log(`fichiers: ${result.files.join(", ") || "aucun"}`);
console.log(`durée   : ${Math.round(result.durationMs / 1000)} s`);
