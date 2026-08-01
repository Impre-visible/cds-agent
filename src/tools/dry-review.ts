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

const { remarks, belowSeverity, overCap, durationMs, truncated, omittedFiles } =
  await runReview(context, context.sourceBranch);

if (truncated) {
  console.log(
    `\n⚠️ diff tronqué pour tenir sous le plafond du prompt${omittedFiles.length ? ` — non montré(s) : ${omittedFiles.join(", ")}` : ""}`,
  );
}

function describe(remark: (typeof remarks)[number]): string {
  const where =
    remark.position === null
      ? `${remark.file.new_path} (fichier)`
      : `${remark.file.new_path}:${remark.position.newLine}`;
  // ×N : le nombre de passes qui ont signalé cette ligne. Sous `union` (donc
  // sous `exclusion`), plus rien ne filtre sur la corroboration — mais elle
  // reste le meilleur signal de certitude disponible, et l'afficher est ce qui
  // évite de la perdre en abandonnant le vote.
  const corroboration = remark.passes > 1 ? ` ×${remark.passes}` : "";
  return `  ${where} [${remark.severity}]${corroboration} ${remark.message}`;
}

function section(title: string, items: typeof remarks): void {
  if (items.length === 0) return;
  console.log(`\n${items.length} ${title} :\n`);
  for (const remark of items) console.log(describe(remark));
}

console.log(
  `\n${remarks.length} remarque(s) publiée(s) en ${Math.round(durationMs / 1000)} s :\n`,
);
for (const remark of remarks) console.log(describe(remark));

// Compter les défauts trouvés à travers les filtres de publication reviendrait
// à mesurer les filtres, pas le modèle : sur la MR !5, c'est exactement ce qui
// a fait disparaître la seule détection du défaut D4 de toute la campagne. Cet
// outil de mesure montre donc AUSSI ce qui a été écarté, cause par cause.
section(
  `remarque(s) retenue(s) mais SOUS LE SEUIL (MIN_SEVERITY=${config.minSeverity})`,
  belowSeverity,
);
section(
  `remarque(s) recevable(s) mais AU-DELÀ DU PLAFOND (MAX_REMARKS=${config.maxRemarks})`,
  overCap,
);

if (remarks.length === 0 && belowSeverity.length > 0) {
  console.log(
    `\n⚠️ aucune remarque publiée alors que ${belowSeverity.length} ont été retenues : ` +
      `toutes sont sous MIN_SEVERITY=${config.minSeverity}.`,
  );
}
