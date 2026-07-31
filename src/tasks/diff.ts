import type { DiffFile } from "../types.ts";

export interface LinePosition {
  newLine: number;
  /** Renseigné uniquement pour les lignes de contexte (inchangées). */
  oldLine: number | null;
}

type DiffLineKind = "hunk" | "add" | "del" | "context" | "other";

interface DiffLineInfo {
  kind: DiffLineKind;
  /** Ligne du diff telle quelle, marqueur ("+"/"-"/" ") inclus. */
  text: string;
  /** Position dans le fichier après modification, null si non applicable. */
  newLine: number | null;
  /** Position dans le fichier avant modification, null si non applicable. */
  oldLine: number | null;
}

/**
 * Parcourt un diff unifié ligne à ligne en tenant à jour les compteurs de
 * ligne ancien/nouveau, remis à zéro à chaque en-tête de section `@@`.
 * Partagée par `parseDiff` (index ligne→position, utilisé par
 * `validateRemarks`) et `numberDiffLines` (annotation du diff envoyé au
 * modèle, voir review.ts §5.3) : les deux doivent impérativement s'accorder
 * sur la même numérotation, d'où la logique unique plutôt que deux copies
 * qui pourraient diverger silencieusement.
 */
function* walkDiffLines(diff: string): Generator<DiffLineInfo> {
  let oldCursor = 0;
  let newCursor = 0;

  for (const line of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk?.[1] && hunk[2]) {
      oldCursor = Number(hunk[1]);
      newCursor = Number(hunk[2]);
      yield { kind: "hunk", text: line, newLine: null, oldLine: null };
      continue;
    }
    if (line.startsWith("+")) {
      yield { kind: "add", text: line, newLine: newCursor, oldLine: null };
      newCursor++;
    } else if (line.startsWith("-")) {
      yield { kind: "del", text: line, newLine: null, oldLine: oldCursor };
      oldCursor++;
    } else if (line.startsWith(" ")) {
      yield {
        kind: "context",
        text: line,
        newLine: newCursor,
        oldLine: oldCursor,
      };
      newCursor++;
      oldCursor++;
    } else {
      // Ex. "\ No newline at end of file" : ni ajout, ni suppression, ni
      // contexte, ni en-tête — ignoré par parseDiff comme avant ce
      // refactor, reproduit tel quel par numberDiffLines.
      yield { kind: "other", text: line, newLine: null, oldLine: null };
    }
  }
}

export function parseDiff(diff: string): Map<number, LinePosition> {
  const lines = new Map<number, LinePosition>();

  for (const info of walkDiffLines(diff)) {
    if (info.kind === "add") {
      lines.set(info.newLine!, { newLine: info.newLine!, oldLine: null });
    } else if (info.kind === "context") {
      lines.set(info.newLine!, {
        newLine: info.newLine!,
        oldLine: info.oldLine,
      });
    }
  }

  return lines;
}

// Largeur fixe pour aligner les numéros de ligne façon "cat -n" : purement
// cosmétique (aide à la lecture par un humain qui déboguerait un prompt),
// aucune signification pour le modèle.
const LINE_NUMBER_WIDTH = 6;
// Numéro absent (ligne supprimée) : un modèle qui l'utiliserait quand même
// comme valeur de "line" échouerait de façon visible (Number("—") est NaN,
// rejeté par parseRemark dans review.ts) plutôt que de retomber
// silencieusement sur un numéro qui pointe ailleurs.
const NO_LINE_MARKER = "—".padStart(LINE_NUMBER_WIDTH);

/**
 * §5.3 : le prompt de review demandait au modèle un "numéro de ligne visible
 * dans le diff", sans préciser lequel des trois numéros visibles dans un
 * diff brut (ancien fichier, nouveau fichier, position dans le bloc affiché)
 * — alors que `validateRemarks`/`parseDiff` n'acceptent que le premier
 * (nouveau fichier). Cette fonction rend ce numéro explicite en préfixant
 * chaque ligne ajoutée ou de contexte par lui, pour qu'il n'y ait plus qu'une
 * seule lecture possible. Les lignes supprimées n'ont pas de numéro dans le
 * nouveau fichier : elles sont marquées par NO_LINE_MARKER plutôt que par le
 * numéro de l'ancien fichier, qu'un modèle pourrait être tenté de réutiliser
 * tel quel. Les en-têtes de section `@@` sont reproduits sans préfixe : ce
 * sont des repères structurels du diff, pas des lignes de contenu.
 */
export function numberDiffLines(diff: string): string {
  const out: string[] = [];

  for (const info of walkDiffLines(diff)) {
    if (info.kind === "hunk" || info.kind === "other") {
      out.push(info.text);
      continue;
    }
    const marker =
      info.newLine !== null
        ? String(info.newLine).padStart(LINE_NUMBER_WIDTH)
        : NO_LINE_MARKER;
    out.push(`${marker} | ${info.text}`);
  }

  return out.join("\n");
}

export interface ValidatedRemark {
  file: DiffFile;
  position: LinePosition | null;
  severity: string;
  message: string;
}

export function validateRemarks(
  remarks: { file: string; line: number; severity: string; message: string }[],
  files: DiffFile[],
): { valid: ValidatedRemark[]; rejected: string[] } {
  const byPath = new Map(files.map((file) => [file.new_path, file]));
  const lineIndex = new Map(
    files.map((file) => [file.new_path, parseDiff(file.diff)]),
  );
  const valid: ValidatedRemark[] = [];
  const rejected: string[] = [];

  const seen = new Set<string>();

  for (const remark of remarks) {
    const file = byPath.get(remark.file);
    if (!file) {
      rejected.push(`${remark.file} — fichier absent du diff`);
      continue;
    }

    const position = lineIndex.get(remark.file)?.get(remark.line) ?? null;
    const key = `${remark.file}:${position?.newLine ?? "file"}`;
    if (seen.has(key)) {
      rejected.push(`${key} — doublon, une seule remarque par ligne`);
      continue;
    }
    seen.add(key);

    valid.push({
      file,
      position,
      severity: remark.severity ?? "info",
      message: remark.message,
    });
  }

  return { valid, rejected };
}
