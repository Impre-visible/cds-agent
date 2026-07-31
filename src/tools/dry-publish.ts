import { config } from "../config.ts";
import { gitlab, resourceKind } from "../gitlab/client.ts";
import { buildContext } from "../tasks/context.ts";
import { parseDiff, validateRemarks } from "../tasks/diff.ts";
import { publishReview } from "../tasks/publish.ts";
import type { AgentRequest } from "../types.ts";

const iid = Number(process.argv[2]);
if (!iid) {
  console.error("usage : npm run publish -- <mr-iid>");
  process.exit(1);
}

const projectPath = config.allowedProjects[0]!;
const project = await gitlab.project(projectPath);

const request: AgentRequest = {
  key: `dry:publish:${iid}`,
  todoId: 0,
  projectId: project.id,
  projectPath,
  kind: resourceKind("MergeRequest")!,
  iid,
  noteId: null,
  requester: "dry-run",
  text: "",
  targetUrl: "",
};

const context = await buildContext(request);
if (context.targetKind !== "merge_requests")
  throw new Error("contexte MR attendu");
const file = context.files[0];
if (!file) throw new Error("aucun fichier dans le diff");

const addressable = [...parseDiff(file.diff).values()];
const added = addressable.find((p) => p.oldLine === null);
const contextLine = addressable.find((p) => p.oldLine !== null);

console.log(`fichier : ${file.new_path}`);
console.log(
  `lignes adressables : ${addressable.map((p) => p.newLine).join(", ")}`,
);

// Trois cas volontaires : ligne ajoutée, ligne de contexte, ligne inexistante.
const handWritten = [
  {
    file: file.new_path,
    line: added?.newLine ?? 1,
    severity: "warning",
    message: "Test niveau 1 : ligne ajoutée.",
  },
  {
    file: file.new_path,
    line: contextLine?.newLine ?? 1,
    severity: "info",
    message: "Test niveau 1 bis : ligne de contexte.",
  },
  {
    file: file.new_path,
    line: 99999,
    severity: "error",
    message: "Test niveau 2 : ligne hors diff, doit tomber sur le fichier.",
  },
];

const { valid, rejected } = validateRemarks(handWritten, context.files);
for (const reason of rejected) console.log(`rejeté : ${reason}`);

const outcomes = await publishReview(context, valid);
console.log(`\n${outcomes.length} remarque(s) publiée(s) :`);
for (const outcome of outcomes) {
  console.log(`  [${outcome.placement}] ${outcome.message}`);
}
