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

const { remarks, retained, durationMs, truncated, omittedFiles } =
  await runReview(context, context.sourceBranch);

if (truncated) {
  console.log(
    `\n⚠️ diff tronqué pour tenir sous le plafond du prompt${omittedFiles.length ? ` — non montré(s) : ${omittedFiles.join(", ")}` : ""}`,
  );
}

function describe(remark: (typeof retained)[number]): string {
  const where =
    remark.position === null
      ? `${remark.file.new_path} (fichier)`
      : `${remark.file.new_path}:${remark.position.newLine}`;
  return `  ${where} [${remark.severity}] ${remark.message}`;
}

console.log(
  `\n${remarks.length} remarque(s) publiée(s) en ${Math.round(durationMs / 1000)} s :\n`,
);
for (const remark of remarks) console.log(describe(remark));

// Compter les défauts trouvés à travers le plafond de publication reviendrait
// à mesurer le plafond, pas le modèle : sur la MR !5, c'est exactement ce qui
// a fait disparaître la seule détection du défaut D4 de toute la campagne.
// Cet outil de mesure montre donc AUSSI ce que le plafond a coupé.
const overflow = retained.slice(remarks.length);
if (overflow.length > 0) {
  console.log(
    `\n${overflow.length} remarque(s) retenue(s) mais NON publiée(s) ` +
      `(plafond MAX_REMARKS=${config.maxRemarks}) :\n`,
  );
  for (const remark of overflow) console.log(describe(remark));
}
