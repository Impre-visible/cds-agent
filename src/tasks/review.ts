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

/**
 * Repère l'accolade fermante correspondant à celle ouverte en position
 * `start`, en tenant compte des chaînes de caractères et des échappements.
 * Un comptage naïf des accolades casse dès qu'une remarque cite du code
 * dans son message (ex. "remplacez par if (x) { return }") : l'accolade
 * fermante de la citation fait retomber la profondeur à zéro avant la fin
 * réelle de l'objet JSON, qui se retrouve tronqué. C'est pourtant le genre
 * de texte qu'un relecteur de code produit couramment — pas un cas limite.
 */
function findMatchingBrace(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return i;
  }
  return null;
}

/** Le modèle écrit parfois le JSON dans le fichier, parfois sur stdout. */
// Exportée pour être testée unitairement (voir review.test.ts).
export function extractJson(text: string): string | null {
  // Le bloc fenced souffrait du même comptage naïf : le contenu capturé est
  // désormais délimité par findMatchingBrace plutôt que par une regex qui
  // s'arrête à la première accolade rencontrée.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) {
    const braceStart = fenced[1].indexOf("{");
    if (braceStart !== -1) {
      const end = findMatchingBrace(fenced[1], braceStart);
      if (end !== null) return fenced[1].slice(braceStart, end + 1);
    }
  }

  const start = text.indexOf('{"remarks"');
  const loose = start === -1 ? text.indexOf('{ "remarks"') : start;
  if (loose === -1) return null;

  const end = findMatchingBrace(text, loose);
  return end === null ? null : text.slice(loose, end + 1);
}

const KNOWN_SEVERITIES = new Set(["info", "warning", "error"]);
const DEFAULT_SEVERITY = "info";

/**
 * Frontière de confiance avec le modèle : `JSON.parse` ne garantit que la
 * syntaxe, pas la forme. Un `as Remark[]` en amont serait un mensonge au
 * compilateur — cette fonction vérifie chaque champ un par un et renvoie
 * soit une remarque exploitable, soit un motif de rejet lisible (journalisé
 * par runReview aux côtés des rejets de validateRemarks).
 *
 * Tolérances retenues, pensées pour un petit modèle (7B) :
 * - `line` : une chaîne numérique ("42") est convertie, un modèle sérialise
 *   parfois les nombres en texte sans que ce soit significatif. Au-delà
 *   (texte non numérique, flottant, valeur <= 0), on rejette : une position
 *   fausse silencieuse (ex. bascule en commentaire de fichier sans raison
 *   apparente) est pire qu'un rejet explicite.
 * - `message` : aucune coercition. Un objet sérialisé en chaîne donnerait
 *   littéralement "[object Object]" publié tel quel dans la MR — on préfère
 *   rejeter avec un motif clair.
 * - `file` : aucune coercition, comparé tel quel à la liste des fichiers du
 *   diff par validateRemarks ensuite ; absent ou non-chaîne, on rejette ici
 *   pour ne pas propager `undefined`.
 * - `severity` : absente ou hors de l'ensemble connu, elle ne casse pas la
 *   remarque (le reste reste exploitable) mais on refuse de republier une
 *   valeur arbitraire — elle finit **en gras** dans un commentaire GitLab
 *   public (voir publish.ts). Repli sur "info".
 */
export function parseRemark(
  raw: unknown,
  index: number,
): { remark: Remark } | { rejected: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { rejected: `remarque #${index} — n'est pas un objet JSON` };
  }
  const value = raw as Record<string, unknown>;

  const file = value.file;
  if (typeof file !== "string" || file.length === 0) {
    return {
      rejected: `remarque #${index} — champ "file" absent ou non-chaîne`,
    };
  }

  const message = value.message;
  if (typeof message !== "string" || message.length === 0) {
    return {
      rejected: `${file} — champ "message" absent ou non-chaîne`,
    };
  }

  const rawLine = value.line;
  const line = typeof rawLine === "string" ? Number(rawLine) : rawLine;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    return {
      rejected: `${file} — champ "line" absent ou invalide (${JSON.stringify(rawLine)})`,
    };
  }

  const severity =
    typeof value.severity === "string" && KNOWN_SEVERITIES.has(value.severity)
      ? value.severity
      : DEFAULT_SEVERITY;

  return { remark: { file, line, severity, message } };
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

    // Frontière de confiance : chaque élément est vérifié un par un avant
    // d'entrer dans validateRemarks, qui lui continue de recevoir un
    // Remark[] réellement typé (son rôle reste l'appartenance au diff et la
    // déduplication, pas la forme du JSON).
    const shaped: Remark[] = [];
    const shapeRejected: string[] = [];
    parsed.remarks.forEach((item, index) => {
      const result = parseRemark(item, index);
      if ("rejected" in result) shapeRejected.push(result.rejected);
      else shaped.push(result.remark);
    });

    const { valid, rejected } = validateRemarks(shaped, context.files);
    for (const reason of [...shapeRejected, ...rejected])
      console.log(`    remarque rejetée : ${reason}`);

    return {
      remarks: valid.slice(0, config.maxRemarks),
      durationMs: result.durationMs,
    };
  } finally {
    workspace.dispose();
  }
}
