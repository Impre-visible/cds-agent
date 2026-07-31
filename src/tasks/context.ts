import { config } from "../config.ts";
import { gitlab } from "../gitlab/client.ts";
import { log } from "../log.ts";
import {
  DIFF_REFS_RETRIES,
  DIFF_REFS_DELAY_MS,
  RECENT_HUMAN_COMMENTS,
  MAX_LIST_PAGES,
} from "../limits.ts";
import type {
  AgentRequest,
  DiffFile,
  DiffRefs,
  IssueDetail,
  LinkedIssue,
  Note,
  TaskContext,
} from "../types.ts";

// DIFF_REFS_RETRIES, DIFF_REFS_DELAY_MS, RECENT_HUMAN_COMMENTS et
// MAX_LIST_PAGES viennent de src/limits.ts (§5.8). MAX_LIST_PAGES borne le
// nombre de pages explorées pour rassembler les commentaires récents (voir
// gitlab.notesPage ci-dessous) : un fil noyé sous des centaines de notes
// système (labels, réassignations...) ne doit pas non plus déclencher un
// rapatriement sans fin si aucun commentaire humain récent ne s'y trouve.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Les derniers commentaires humains d'un ticket, du plus ancien au plus
 * récent — c'est ce que `loadLinkedIssue` présente au modèle comme "les
 * échanges récents".
 *
 * Interroge l'API en ordre antichronologique (sort=desc) et s'arrête dès
 * que RECENT_HUMAN_COMMENTS commentaires humains ont été rassemblés, plutôt
 * que de rapatrier l'intégralité de l'historique pour n'en garder que les
 * 15 derniers : l'ancien code (per_page=100, sort=asc, puis
 * `comments.slice(-15)`) ne récupérait même pas la bonne fenêtre sur un
 * ticket de plus de 100 commentaires — il gardait les commentaires 86 à
 * 100 de la première page, les plus récents étant restés sur des pages
 * jamais lues (voir §3.5 : le commentaire "les échanges récents" décrivait
 * un comportement que le code n'avait pas). MAX_LIST_PAGES borne malgré
 * tout le nombre de pages explorées, pour la même raison que le nombre de
 * pages est borné côté pagination générique dans gitlab/client.ts.
 */
async function recentHumanNotes(
  projectId: number,
  issue: IssueDetail,
  botUsername: string,
): Promise<Note[]> {
  const human: Note[] = [];

  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const { items, nextPage } = await gitlab.notesPage(
      projectId,
      "issues",
      issue.iid,
      page,
      "desc",
    );

    for (const note of items) {
      if (note.system) continue;
      if (note.author.username.toLowerCase() === botUsername.toLowerCase())
        continue;
      human.push(note);
      if (human.length >= RECENT_HUMAN_COMMENTS) break;
    }

    if (human.length >= RECENT_HUMAN_COMMENTS || !nextPage) break;
  }

  // Rapatriés du plus récent au plus ancien (sort=desc) : on les repasse en
  // ordre chronologique pour les présenter comme une conversation qu'on lit.
  return human.reverse();
}

async function loadLinkedIssue(
  projectId: number,
  issue: IssueDetail,
  botUsername: string,
): Promise<LinkedIssue> {
  const notes = await recentHumanNotes(projectId, issue, botUsername);
  return {
    iid: issue.iid,
    title: issue.title,
    description: issue.description ?? "",
    comments: notes.map((note) => `@${note.author.username}: ${note.body}`),
  };
}

export async function buildContext(
  request: AgentRequest,
): Promise<TaskContext> {
  // §6.8 : targetKind n'est plus dans ce socle commun — il varie de forme
  // (littéral "merge_requests" vs "issues", pas juste sa valeur) entre les
  // deux branches de l'union discriminée ci-dessous, chacune l'assigne donc
  // elle-même dans son propre `return`.
  const base = {
    instanceUrl: config.gitlabUrl,
    projectId: request.projectId,
    projectPath: request.projectPath,
    targetIid: request.iid,
    requester: request.requester,
    requestText: request.text,
  };

  if (request.kind === "merge_requests") {
    let diffRefs: DiffRefs | null = null;
    let files: DiffFile[] = [];
    let mr = await gitlab.mergeRequest(request.projectId, request.iid);

    // GitLab régénère le diff HEAD lors d'un recontrôle de mergeabilité.
    // Pendant cette fenêtre, diff_refs est nul et /diffs renvoie du vide.
    // Jusqu'à DIFF_REFS_RETRIES × DIFF_REFS_DELAY_MS (10 s) d'attente
    // synchrone dans le worker, en pur polling : coûteux dans l'absolu,
    // mais borné et rare (fenêtre de recalcul GitLab, pas le cas courant),
    // et le worker traite les to-dos en série de toute façon (voir
    // daemon/index.ts) — retarder celui-ci de quelques secondes ne bloque
    // rien d'autre que lui-même. Non corrigé ici : un vrai mécanisme
    // évènementiel demanderait un webhook GitLab, hors périmètre de ce
    // durcissement.
    for (let attempt = 1; attempt <= DIFF_REFS_RETRIES; attempt++) {
      mr = await gitlab.mergeRequest(request.projectId, request.iid);
      files = await gitlab.mergeRequestDiffs(request.projectId, request.iid);

      if (mr.diff_refs?.head_sha && files.length > 0) {
        diffRefs = mr.diff_refs;
        break;
      }

      log.info(
        `contexte incomplet (diff_refs=${Boolean(mr.diff_refs?.head_sha)}, fichiers=${files.length}), tentative ${attempt}/${DIFF_REFS_RETRIES}`,
      );
      await sleep(DIFF_REFS_DELAY_MS);
    }

    if (!diffRefs) {
      // Échec signalé (log), non traité comme fatal ici : diffRefs reste
      // `null` dans le contexte, et publishReview() (§5.4, tasks/publish.ts)
      // sait retenter sa propre résolution de SHA via
      // mergeRequestVersions() dans ce cas précis — seule situation où elle
      // le fait, puisqu'il n'y a alors aucun SHA figé ici à réutiliser ni à
      // comparer pour détecter un changement de la MR pendant la review. On
      // se contente ici de ne plus laisser `diffRefs: null` être la seule
      // trace de cet échec.
      log.warn(
        `diff_refs indisponible après ${DIFF_REFS_RETRIES} tentatives (${(DIFF_REFS_RETRIES * DIFF_REFS_DELAY_MS) / 1000}s d'attente) — le contexte part sans SHA figés`,
      );
    }

    let linkedIssue: LinkedIssue | null = null;
    try {
      const [closes] = await gitlab.closesIssues(
        request.projectId,
        request.iid,
      );
      if (closes)
        linkedIssue = await loadLinkedIssue(
          request.projectId,
          closes,
          config.botUsername,
        );
    } catch (error) {
      log.warn(`ticket lié illisible : ${(error as Error).message}`);
    }

    return {
      ...base,
      targetKind: "merge_requests",
      targetTitle: mr.title,
      targetDescription: mr.description ?? "",
      linkedIssue,
      sourceBranch: mr.source_branch,
      diffRefs,
      files,
    };
  }

  // Chemin "issue" : sans chemin de production aujourd'hui — router.ts
  // refuse tout to-do dont la cible n'est pas une merge request avant même
  // d'appeler buildContext() ("🤖 Seules les merge requests sont gérées
  // pour l'instant."). Conservé délibérément, et non supprimé comme code
  // mort (voir §5.9, qui concerne waitForDiffRefs — une fonction dupliquée
  // et jamais appelée, ce qui n'est pas le cas ici) : src/tools/dump-context.ts
  // appelle réellement cette branche pour inspecter le contexte d'une issue
  // directe, et le "pour l'instant" de router.ts documente une intention
  // déjà actée de traiter les issues plus tard sans reconstruire cette
  // branche depuis zéro. Si cette anticipation ne se concrétise jamais, il
  // faudra la supprimer avec dump-context.ts — pas avant.
  const issue = await gitlab.issue(request.projectId, request.iid);
  return {
    ...base,
    targetKind: "issues",
    targetTitle: issue.title,
    targetDescription: issue.description ?? "",
    linkedIssue: await loadLinkedIssue(
      request.projectId,
      issue,
      config.botUsername,
    ),
  };
}
