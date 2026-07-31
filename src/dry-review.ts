import { config } from "./env.ts";
import { gitlab, resourceKind } from "./gitlab.ts";
import { buildContext } from "./context.ts";
import { runReview } from "./review.ts";
import type { AgentRequest } from "./types.ts";

const iid = Number(process.argv[2]);
if (!iid) {
  console.error("usage : npm run review -- <mr-iid>");
  process.exit(1);
}

const projectPath = config.allowedProjects[0];
if (!projectPath) throw new Error("ALLOWED_PROJECTS vide");
const project = await gitlab.project(projectPath);

const request: AgentRequest = {
  key: `dry:mr:${iid}`,
  todoId: 0,
  projectId: project.id,
  projectPath,
  kind: resourceKind("MergeRequest")!,
  iid,
  noteId: null,
  requester: "dry-run",
  text: "fais une review de cette MR",
  targetUrl: "",
};

const context = await buildContext(request);
if (!context.sourceBranch) throw new Error("branche source introuvable");

const { remarks, durationMs } = await runReview(context, context.sourceBranch);

console.log(
  `\n${remarks.length} remarque(s) en ${Math.round(durationMs / 1000)} s :\n`,
);
for (const remark of remarks) {
  const where =
    remark.position === null
      ? `${remark.file.new_path} (fichier)`
      : `${remark.file.new_path}:${remark.position.newLine}`;
  console.log(`  ${where} [${remark.severity}] ${remark.message}`);
}
