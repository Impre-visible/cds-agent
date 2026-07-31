import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { runAgent, type AgentResult } from "../agent/runner.ts";
import { createWorkspace } from "../agent/workspace.ts";
import type { TaskContext } from "../types.ts";
import { validateRemarks, type ValidatedRemark } from "./diff.ts";
import { runAgentInSandbox } from "../agent/sandbox.ts";

export interface Remark {
  file: string;
  line: number;
  severity: string;
  message: string;
}

const OUTPUT_FILE = ".cds-review.json";

function buildPrompt(context: TaskContext): string {
  const paths = context.files.map((file) => file.new_path);

  const linked = context.linkedIssue
    ? `## Ticket lié #${context.linkedIssue.iid} (contexte uniquement)\n${context.linkedIssue.title}\n${context.linkedIssue.description.slice(0, 1500)}`
    : "";

  const diff = context.files
    .map((file) => `### ${file.new_path}\n${file.diff}`)
    .join("\n\n");

  return [
    `Revue de la merge request !${context.targetIid} du dépôt ${context.projectPath}.`,
    `Demande de @${context.requester} : ${context.requestText}`,
    linked,
    `## Seuls ces fichiers sont modifiés par la MR\n${paths.map((p) => `- ${p}`).join("\n")}`,
    `Toute remarque portant sur un autre fichier sera rejetée.`,
    `## Diff à relire\n${diff}`,
    `Réponds uniquement par ce JSON, sans autre texte :`,
    `{"remarks":[{"file":"${paths[0] ?? "chemin"}","line":42,"severity":"warning","message":"..."}]}`,
    `Le champ line doit être un numéro de ligne visible dans le diff ci-dessus.`,
    `Maximum ${config.maxRemarks} remarques.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Le modèle écrit parfois le JSON dans le fichier, parfois sur stdout. */
// Exportée pour être testée unitairement (voir review.test.ts).
export function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
  if (fenced?.[1]) return fenced[1];

  const start = text.indexOf('{"remarks"');
  const loose = start === -1 ? text.indexOf('{ "remarks"') : start;
  if (loose === -1) return null;

  let depth = 0;
  for (let i = loose; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(loose, i + 1);
  }
  return null;
}

export async function runReview(
  context: TaskContext,
  sourceBranch: string,
): Promise<{ remarks: ValidatedRemark[]; durationMs: number }> {
  const workspace = createWorkspace(context.projectPath, sourceBranch);

  try {
    // Contrairement à implement.ts, aucune commande git n'est relancée côté
    // hôte après que l'agent ait tourné dans ce workspace (pas d'add/commit/
    // push : seul le fichier OUTPUT_FILE est relu, en pur fs). L'agent peut
    // toujours écrire un hook ou modifier .git/config, mais rien ici ne les
    // exécute. Si ce fichier gagne un jour un appel à git() après l'exécution
    // de l'agent, il faudra lui appliquer la même vérification de fingerprint
    // qu'implement.ts (voir fingerprintGitMeta dans agent/workspace.ts).
    // Le fichier de sortie ne doit jamais entrer dans un commit.
    writeFileSync(
      join(workspace.repo, ".git", "info", "exclude"),
      `\n${OUTPUT_FILE}\n`,
      {
        flag: "a",
      },
    );

    let result: AgentResult;

    if (config.useDocker) {
      writeFileSync(
        join(workspace.meta, "prompt.txt"),
        buildPrompt(context),
        "utf8",
      );
      result = await runAgentInSandbox(
        workspace.repo,
        workspace.meta,
        context.projectPath,
      );
    } else {
      result = await runAgent(workspace.repo, buildPrompt(context));
    }

    if (result.timedOut)
      throw new Error(
        `agent interrompu après ${config.agentTimeoutMs / 60_000} min`,
      );

    let raw: string | null = null;
    let channel = "fichier";
    try {
      raw = readFileSync(join(workspace.repo, OUTPUT_FILE), "utf8");
    } catch {
      raw = extractJson(result.stdout);
      channel = "stdout";
    }
    if (!raw) {
      throw new Error(
        `aucun JSON exploitable, ni fichier ni stdout (code ${result.code})`,
      );
    }
    console.log(`    JSON récupéré via ${channel}`);

    const parsed = JSON.parse(raw) as { remarks?: unknown };
    if (!Array.isArray(parsed.remarks))
      throw new Error(`JSON sans tableau "remarks"`);

    const { valid, rejected } = validateRemarks(
      parsed.remarks as Remark[],
      context.files,
    );
    for (const reason of rejected)
      console.log(`    remarque rejetée : ${reason}`);

    return {
      remarks: valid.slice(0, config.maxRemarks),
      durationMs: result.durationMs,
    };
  } finally {
    workspace.dispose();
  }
}
