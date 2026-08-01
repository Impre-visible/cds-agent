import { config } from "../config.ts";
import { gitlab, resourceKind } from "../gitlab/client.ts";
import { buildContext } from "../tasks/context.ts";
import { runImplement } from "../tasks/implement.ts";
import {
  loadProjectsFile,
  firstProjectPath,
  resolveProject,
} from "../projects.ts";
import type { AgentRequest } from "../types.ts";

const iid = Number(process.argv[2]);
const branch = process.argv[3];
const requestText = process.argv[4] ?? "implémente les tests pour ce ticket";

if (!iid || !branch) {
  console.error(
    'usage : npm run implement -- <mr-iid> <branche> ["texte de la demande"]',
  );
  process.exit(1);
}

// Chantier "projects.json" : ces outils dry-run agissent sur le premier
// dépôt déclaré dans le fichier, comme ils prenaient auparavant
// ALLOWED_PROJECTS[0]. Chargement fatal si le fichier est absent/invalide,
// même exigence qu'au démarrage du daemon (voir projects.ts).
const projectsFile = loadProjectsFile(config.projectsFile);
const projectPath = firstProjectPath(projectsFile);
if (!projectPath)
  throw new Error(`${config.projectsFile} ne déclare aucun projet`);
const resolvedProject = resolveProject(projectsFile, projectPath, {
  commands: { install: config.installCommand, test: config.testCommand },
  docker: { image: config.dockerDefaultImage },
})!;

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
  text: requestText,
  targetUrl: "",
};

const context = await buildContext(request);
const result = await runImplement(context, branch, resolvedProject);

console.log(`\nstatut  : ${result.status}`);
console.log(`détail  : ${result.detail}`);
console.log(`fichiers: ${result.files.join(", ") || "aucun"}`);
console.log(`durée   : ${Math.round(result.durationMs / 1000)} s`);
