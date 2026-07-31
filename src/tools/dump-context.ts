import { writeFileSync } from "node:fs";
import { config } from "../config.ts";
import { gitlab, resourceKind } from "../gitlab/client.ts";
import { buildContext } from "../tasks/context.ts";
import type { AgentRequest } from "../types.ts";

const [kindArg, iidArg] = process.argv.slice(2);
if (!kindArg || !iidArg) {
  console.error("usage : npm run context -- <mr|issue> <iid>");
  process.exit(1);
}

const kind = resourceKind(kindArg === "mr" ? "MergeRequest" : "Issue");
if (!kind) throw new Error("type invalide");

const projectPath = config.allowedProjects[0];
if (!projectPath) throw new Error("ALLOWED_PROJECTS vide");

const project = await gitlab.project(projectPath);

const request: AgentRequest = {
  key: `dump:${kind}:${iidArg}`,
  todoId: 0,
  projectId: project.id,
  projectPath,
  kind,
  iid: Number(iidArg),
  noteId: null,
  requester: "dump",
  text: "@bot fais une review de cette MR",
  targetUrl: "",
};

const context = await buildContext(request);

console.log(
  `cible      : ${context.projectPath} ${context.targetKind} ${context.targetIid}`,
);
console.log(`titre      : ${context.targetTitle}`);
console.log(`diff_refs  : ${context.diffRefs ? "OK" : "ABSENT ⚠︎"}`);
if (context.diffRefs) {
  console.log(`  base  ${context.diffRefs.base_sha.slice(0, 10)}`);
  console.log(`  start ${context.diffRefs.start_sha.slice(0, 10)}`);
  console.log(`  head  ${context.diffRefs.head_sha.slice(0, 10)}`);
}
console.log(`fichiers   : ${context.files.length}`);
for (const file of context.files) {
  console.log(
    `  ${file.new_path} (${file.diff.split("\n").length} lignes de diff)`,
  );
}
console.log(
  `ticket lié : ${context.linkedIssue ? `#${context.linkedIssue.iid} (${context.linkedIssue.comments.length} commentaires)` : "aucun"}`,
);

writeFileSync("./context-dump.json", JSON.stringify(context, null, 2), "utf8");
console.log(`\nJSON complet : ./context-dump.json`);
