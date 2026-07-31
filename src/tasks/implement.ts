import { config } from "../config.ts";
import { runAgent } from "../agent/runner.ts";
import { collectChanges } from "./guard.ts";
import { gitlab } from "../gitlab/client.ts";
import { createWorkspace, git, runCommand } from "../agent/workspace.ts";
import type { TaskContext } from "../types.ts";
import { basename, resolve } from "node:path";

export interface ImplementResult {
  status: "pushed" | "rejected" | "no-change" | "tests-red";
  detail: string;
  files: string[];
  durationMs: number;
}

function buildPrompt(context: TaskContext): string {
  const linked = context.linkedIssue
    ? `## Ticket #${context.linkedIssue.iid} : ${context.linkedIssue.title}\n${context.linkedIssue.description.slice(0, 1500)}`
    : "";

  return [
    `Dépôt ${context.projectPath}, cloné dans le répertoire courant.`,
    `Demande de @${context.requester} : ${context.requestText}`,
    linked,
    `Écris des tests automatisés dans le dossier tests/.`,
    `Lance \`${config.testCommand}\` et corrige tes tests jusqu'à ce que tout passe.`,
    `INTERDIT : modifier un fichier hors de tests/. Le code source ne doit pas être touché.`,
    `Si un test échoue à cause d'un bug du code source, écris quand même le test correct et arrête-toi.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function runImplement(
  context: TaskContext,
  branch: string,
): Promise<ImplementResult> {
  const started = Date.now();
  const workspace = createWorkspace(context.projectPath, branch);

  try {
    const repo = workspace.repo;
    git(repo, ["config", "user.name", config.gitAuthorName]);
    git(repo, ["config", "user.email", config.gitAuthorEmail]);

    console.log(`    installation des dépendances`);
    const install = await runCommand(repo, config.installCommand, {
      projectPath: context.projectPath,
      network: true,
    });
    if (!install.ok) {
      return {
        status: "tests-red",
        detail: `installation échouée :\n${install.output.slice(-1200)}`,
        files: [],
        durationMs: Date.now() - started,
      };
    }

    // Référence : si la suite est déjà rouge, on ne saura rien conclure ensuite.
    const baseline = await runCommand(repo, config.testCommand, {
      projectPath: context.projectPath,
    });

    if (!baseline.ok) {
      return {
        status: "tests-red",
        detail: `la suite était déjà rouge avant intervention :\n${baseline.output.slice(-1200)}`,
        files: [],
        durationMs: Date.now() - started,
      };
    }

    if (config.fakeAgentScript) {
      console.log(`    agent simulé : ${config.fakeAgentScript}`);

      // Le script vit sur l'hôte : en mode conteneur il faut le monter et réécrire son chemin.
      let command = config.fakeAgentScript;
      let mounts: { host: string; container: string }[] | undefined;

      if (config.useDocker) {
        const scriptPath = resolve(
          config.fakeAgentScript.replace(/^bash\s+/, ""),
        );
        const fixturesDir = resolve(scriptPath, "..");
        mounts = [{ host: fixturesDir, container: "/fixtures" }];
        command = `bash /fixtures/${basename(scriptPath)}`;
      }

      const fake = await runCommand(repo, command, {
        projectPath: context.projectPath,
        mounts,
      });
      console.log(fake.output);
    } else {
      await runAgent(repo, buildPrompt(context));
    }

    const { paths, offending } = collectChanges(
      git(repo, ["status", "--porcelain=v1", "-uall"]),
    );

    if (paths.length === 0) {
      return {
        status: "no-change",
        detail: "l'agent n'a modifié aucun fichier",
        files: [],
        durationMs: Date.now() - started,
      };
    }

    // Le garde-fou : c'est ce qui empêche de « faire passer les tests » en modifiant le code testé.
    if (offending.length > 0) {
      git(repo, ["checkout", "--", "."]);
      return {
        status: "rejected",
        detail: `fichiers hors périmètre modifiés : ${offending.join(", ")}`,
        files: paths,
        durationMs: Date.now() - started,
      };
    }

    // On ne croit pas l'agent sur parole : on relance la suite nous-mêmes.
    const verdict = await runCommand(repo, config.testCommand, {
      projectPath: context.projectPath,
    });
    if (!verdict.ok) {
      return {
        status: "tests-red",
        detail: `les tests écrits ne passent pas :\n${verdict.output.slice(-1200)}`,
        files: paths,
        durationMs: Date.now() - started,
      };
    }

    const branchInfo = await gitlab.branch(context.projectId, branch);
    if (branchInfo.protected) {
      return {
        status: "rejected",
        detail: `la branche ${branch} est protégée, aucun push`,
        files: paths,
        durationMs: Date.now() - started,
      };
    }

    git(repo, ["add", "--all"]);
    git(repo, [
      "commit",
      "-m",
      `test: ajout de tests demandés par @${context.requester}`,
    ]);
    git(repo, ["push", "origin", `HEAD:${branch}`], true);

    return {
      status: "pushed",
      detail: `${paths.length} fichier(s) de test poussé(s)`,
      files: paths,
      durationMs: Date.now() - started,
    };
  } finally {
    workspace.dispose();
  }
}
