import { config } from "../config.ts";
import { gitlab, resourceKind } from "../gitlab/client.ts";
import type { AgentRequest, GitLabUser, Todo } from "../types.ts";

const RELEVANT_ACTIONS = new Set(["mentioned", "directly_addressed"]);

export type BuildResult =
  { ok: true; request: AgentRequest } | { ok: false; reason: string };

function extractNoteId(targetUrl: string): number | null {
  const match = /#note_(\d+)/.exec(targetUrl);
  return match?.[1] ? Number(match[1]) : null;
}

export function defuseMentions(text: string): string {
  return text.replace(/@[a-zA-Z0-9_.-]+/g, (mention) => `\`${mention}\``);
}

export async function buildRequest(
  todo: Todo,
  bot: GitLabUser,
): Promise<BuildResult> {
  if (!RELEVANT_ACTIONS.has(todo.action_name)) {
    return {
      ok: false,
      reason: `action « ${todo.action_name} » hors périmètre`,
    };
  }

  const kind = resourceKind(todo.target_type);
  if (!kind)
    return { ok: false, reason: `cible « ${todo.target_type} » non gérée` };

  const projectId = todo.project?.id;
  const iid = todo.target?.iid;
  if (!projectId || !iid)
    return { ok: false, reason: "projet ou iid absent du to-do" };

  const noteId = extractNoteId(todo.target_url);

  let text: string;
  let requester: string;

  if (noteId === null) {
    // Mention dans la description de l'issue ou de la MR, pas dans un commentaire.
    text = todo.body;
    requester = todo.author.username;
  } else {
    // Relecture de la note : le body du to-do peut être tronqué.
    const note = await gitlab.getNote(projectId, kind, iid, noteId);
    if (note.system) return { ok: false, reason: "note système" };
    if (note.author.id === bot.id)
      return { ok: false, reason: "note écrite par le bot lui-même" };
    text = note.body;
    requester = note.author.username;
  }

  // Garde-fou anti-boucle : la mention doit être littéralement présente.
  if (!text.includes(`@${config.botUsername}`)) {
    return {
      ok: false,
      reason: "le texte ne mentionne pas le bot (réponse dans un thread ?)",
    };
  }

  return {
    ok: true,
    request: {
      key:
        noteId === null ? `desc:${projectId}:${kind}:${iid}` : `note:${noteId}`,
      todoId: todo.id,
      projectId,
      projectPath: todo.project?.path_with_namespace ?? String(projectId),
      kind,
      iid,
      noteId,
      requester,
      text,
      targetUrl: todo.target_url,
    },
  };
}
