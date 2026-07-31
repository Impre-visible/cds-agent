import { config } from "../config.ts";
import { gitlab } from "../gitlab/client.ts";
import type {
  AgentRequest,
  DiffFile,
  DiffRefs,
  IssueDetail,
  LinkedIssue,
  TaskContext,
} from "../types.ts";

const DIFF_REFS_RETRIES = 5;
const DIFF_REFS_DELAY_MS = 2_000;

/** diff_refs est peuplé de façon asynchrone par GitLab après création de la MR. */
async function waitForDiffRefs(
  projectId: number,
  iid: number,
): Promise<DiffRefs | null> {
  for (let attempt = 1; attempt <= DIFF_REFS_RETRIES; attempt++) {
    const mr = await gitlab.mergeRequest(projectId, iid);
    if (mr.diff_refs?.head_sha) return mr.diff_refs;
    console.log(
      `    diff_refs absent, nouvelle tentative ${attempt}/${DIFF_REFS_RETRIES}`,
    );
    await new Promise((resolve) => setTimeout(resolve, DIFF_REFS_DELAY_MS));
  }
  return null;
}

async function loadLinkedIssue(
  projectId: number,
  issue: IssueDetail,
  botUsername: string,
): Promise<LinkedIssue> {
  const notes = await gitlab.notes(projectId, "issues", issue.iid);
  const human = notes
    .filter((note) => !note.system)
    .filter(
      (note) =>
        note.author.username.toLowerCase() !== botUsername.toLowerCase(),
    )
    .map((note) => `@${note.author.username}: ${note.body}`);

  // Les échanges récents portent l'essentiel du contexte utile.
  return {
    iid: issue.iid,
    title: issue.title,
    description: issue.description ?? "",
    comments: human.slice(-15),
  };
}

export async function buildContext(
  request: AgentRequest,
): Promise<TaskContext> {
  const base = {
    instanceUrl: config.gitlabUrl,
    projectId: request.projectId,
    projectPath: request.projectPath,
    targetKind: request.kind,
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
    for (let attempt = 1; attempt <= DIFF_REFS_RETRIES; attempt++) {
      mr = await gitlab.mergeRequest(request.projectId, request.iid);
      files = await gitlab.mergeRequestDiffs(request.projectId, request.iid);

      if (mr.diff_refs?.head_sha && files.length > 0) {
        diffRefs = mr.diff_refs;
        break;
      }

      console.log(
        `    contexte incomplet (diff_refs=${Boolean(mr.diff_refs?.head_sha)}, fichiers=${files.length}), tentative ${attempt}/${DIFF_REFS_RETRIES}`,
      );
      await new Promise((resolve) => setTimeout(resolve, DIFF_REFS_DELAY_MS));
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
      console.warn(`    ticket lié illisible : ${(error as Error).message}`);
    }

    return {
      ...base,
      targetTitle: mr.title,
      targetDescription: mr.description ?? "",
      linkedIssue,
      sourceBranch: mr.source_branch,
      diffRefs,
      files,
    };
  }

  const issue = await gitlab.issue(request.projectId, request.iid);
  return {
    ...base,
    targetTitle: issue.title,
    targetDescription: issue.description ?? "",
    linkedIssue: await loadLinkedIssue(
      request.projectId,
      issue,
      config.botUsername,
    ),
    sourceBranch: null,
    diffRefs: null,
    files: [],
  };
}
