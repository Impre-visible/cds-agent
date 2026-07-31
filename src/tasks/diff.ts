import type { DiffFile } from "../types.ts";

export interface LinePosition {
  newLine: number;
  /** Renseigné uniquement pour les lignes de contexte (inchangées). */
  oldLine: number | null;
}

export function parseDiff(diff: string): Map<number, LinePosition> {
  const lines = new Map<number, LinePosition>();
  let oldCursor = 0;
  let newCursor = 0;

  for (const line of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk?.[1] && hunk[2]) {
      oldCursor = Number(hunk[1]);
      newCursor = Number(hunk[2]);
      continue;
    }
    if (line.startsWith("+")) {
      lines.set(newCursor, { newLine: newCursor, oldLine: null });
      newCursor++;
    } else if (line.startsWith("-")) {
      oldCursor++;
    } else if (line.startsWith(" ")) {
      lines.set(newCursor, { newLine: newCursor, oldLine: oldCursor });
      newCursor++;
      oldCursor++;
    }
  }

  return lines;
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

  for (const remark of remarks) {
    const file = byPath.get(remark.file);
    if (!file) {
      rejected.push(`${remark.file} — fichier absent du diff`);
      continue;
    }
    const position = lineIndex.get(remark.file)?.get(remark.line) ?? null;
    valid.push({
      file,
      position,
      severity: remark.severity ?? "info",
      message: remark.message,
    });
  }

  return { valid, rejected };
}
