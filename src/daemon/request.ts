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

// Espace de largeur nulle (invisible à l'affichage, y compris une fois
// rendu en markdown) : voir neutralizeQuickActions ci-dessous.
export const ZERO_WIDTH_SPACE = "​";

// Une mention n'en est une que si le "@" démarre un nom d'utilisateur, pas
// s'il est précédé d'un caractère alphanumérique — sans ce lookbehind,
// "foo@bar.com" matchait sur "@bar.com" et se retrouvait défusé en
// "foo`@bar.com`" (bug corrigé ici, voir request.test.ts).
const MENTION_RE = /(?<![a-zA-Z0-9])@[a-zA-Z0-9_.-]+/g;

/**
 * GitLab interprète toute ligne d'un commentaire ou d'une description qui
 * COMMENCE par "/" comme une quick action (`/close`, `/assign @x`,
 * `/merge`, `/label ~x`...), exécutée avec les droits du PAT du bot au
 * moment où le texte est enregistré. Le texte republié ici (remarques du
 * LLM, sorties de commandes...) peut contenir une telle ligne sans aucune
 * intention malveillante côté modèle — il recopie parfois un chemin ou une
 * commande en tout début de ligne — mais GitLab ne fait pas la différence.
 *
 * On casse l'ancrage "premier caractère de la ligne" en insérant un espace
 * de largeur nulle juste avant le "/" : la ligne ne commence plus,
 * littéralement, par "/", et rien ne change à l'affichage (contrairement à
 * un entourage par des guillemets de code, qui aurait changé la police de
 * toute la ligne pour un simple "/api/users" placé en début de phrase).
 * Seule une ligne dont le contenu, espaces de tête mis à part, commence par
 * "/" est visée : une occurrence au milieu d'une phrase ("le point d'entrée
 * /api/users renvoie 404") n'est jamais en tout début de ligne et reste
 * donc intacte.
 */
function neutralizeQuickActions(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const leading = /^[ \t]*/.exec(line)?.[0] ?? "";
      const rest = line.slice(leading.length);
      return rest.startsWith("/")
        ? `${leading}${ZERO_WIDTH_SPACE}${rest}`
        : line;
    })
    .join("\n");
}

/**
 * Neutralise dans un texte non fiable (remarque du LLM, message d'erreur,
 * sortie de commande...) tout ce que GitLab pourrait interpréter comme une
 * action plutôt que du texte : les mentions (`@quelqu'un`, qui notifient
 * réellement la personne visée) et les quick actions (une ligne commençant
 * par "/", exécutée avec les droits du PAT du bot). À appliquer à tout texte
 * d'origine tierce avant de le republier dans un commentaire GitLab — voir
 * publish.ts et router.ts.
 */
export function defuseMentions(text: string): string {
  return neutralizeQuickActions(text).replace(
    MENTION_RE,
    (mention) => `\`${mention}\``,
  );
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
    // Garde-fou anti-boucle : sans lui, une note du bot qui mentionne le bot
    // crée un to-do, donc une tâche, donc une note… Le journal d'idempotence
    // ne l'arrête pas — chaque publication a un identifiant de note neuf,
    // donc une clé neuve.
    //
    // BENCH_ACCEPT_BOT_NOTES le lève pour que le banc de mesure puisse poster
    // sa demande avec le jeton du bot, sans second jeton à gérer. buildConfig
    // refuse ce drapeau sans CDS_MAX_TASKS : la boucle reste bornée par
    // construction (voir config.ts).
    if (note.author.id === bot.id && !config.benchAcceptBotNotes)
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
