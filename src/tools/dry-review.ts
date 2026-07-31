import { config } from "../config.ts";
import { gitlab, resourceKind } from "../gitlab/client.ts";
import { buildContext } from "../tasks/context.ts";
import { runReview } from "../tasks/review.ts";
import { loadProjectsFile, firstProjectPath } from "../projects.ts";
import type { AgentRequest } from "../types.ts";

const iid = Number(process.argv[2]);
if (!iid) {
  console.error("usage : npm run review -- <mr-iid>");
  process.exit(1);
}

// Chantier "projects.json" : premier dépôt déclaré, comme ALLOWED_PROJECTS[0] avant ce chantier.
const projectsFile = loadProjectsFile(config.projectsFile);
const projectPath = firstProjectPath(projectsFile);
if (!projectPath) throw new Error(`${config.projectsFile} ne déclare aucun projet`);
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
if (context.targetKind !== "merge_requests")
  throw new Error("contexte MR attendu");

const { remarks, durationMs, truncated, omittedFiles } = await runReview(
  context,
  context.sourceBranch,
);

if (truncated) {
  console.log(
    `\n⚠️ diff tronqué pour tenir sous le plafond du prompt${omittedFiles.length ? ` — non montré(s) : ${omittedFiles.join(", ")}` : ""}`,
  );
}

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
