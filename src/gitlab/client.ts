import { config } from "../config.ts";
import type {
  GitLabUser,
  Note,
  ResourceKind,
  Todo,
  MergeRequestDetail,
  DiffFile,
  IssueDetail,
} from "../types.ts";

export class GitLabError extends Error {
  // Champs déclarés explicitement (plutôt qu'en propriétés de paramètres du
  // constructeur) : le mode "type stripping" natif de Node n'accepte pas la
  // syntaxe raccourcie `constructor(readonly x: T)`, seulement les
  // déclarations de champs classiques — nécessaire pour que `node --test`
  // puisse charger ce module sans transformation (voir request.test.ts).
  readonly status: number;
  readonly url: string;
  readonly payload: string;

  constructor(status: number, url: string, payload: string) {
    super(`GitLab ${status} sur ${url} — ${payload.slice(0, 400)}`);
    this.name = "GitLabError";
    this.status = status;
    this.url = url;
    this.payload = payload;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${config.gitlabUrl}/api/v4${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "PRIVATE-TOKEN": config.token,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  if (!response.ok) throw new GitLabError(response.status, url, text);
  return (text ? JSON.parse(text) : null) as T;
}

export async function apiForm<T>(
  path: string,
  form: Record<string, string | number | undefined>,
): Promise<T> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value !== undefined) body.set(key, String(value));
  }

  const url = `${config.gitlabUrl}/api/v4${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": config.token,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) throw new GitLabError(response.status, url, text);
  return (text ? JSON.parse(text) : null) as T;
}

export function resourceKind(targetType: string): ResourceKind | null {
  if (targetType === "Issue") return "issues";
  if (targetType === "MergeRequest") return "merge_requests";
  return null;
}

export const gitlab = {
  currentUser: () => api<GitLabUser>("/user"),

  pendingTodos: () => api<Todo[]>("/todos?state=pending&per_page=100"),

  doneTodos: () => api<Todo[]>("/todos?state=done&per_page=100"),

  /** GitLab répond 304 si le to-do est déjà done — ce n'est pas une erreur. */
  async markTodoDone(todoId: number): Promise<"done" | "already-done"> {
    try {
      await api(`/todos/${todoId}/mark_as_done`, { method: "POST" });
      return "done";
    } catch (error) {
      if (
        error instanceof GitLabError &&
        (error.status === 304 || error.status === 404)
      ) {
        return "already-done";
      }
      throw error;
    }
  },

  getNote: (
    projectId: number,
    kind: ResourceKind,
    iid: number,
    noteId: number,
  ) => api<Note>(`/projects/${projectId}/${kind}/${iid}/notes/${noteId}`),

  createNote: (
    projectId: number,
    kind: ResourceKind,
    iid: number,
    body: string,
  ) =>
    api<Note>(`/projects/${projectId}/${kind}/${iid}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),

  awardOnNote: (
    projectId: number,
    kind: ResourceKind,
    iid: number,
    noteId: number,
    name: string,
  ) =>
    api(
      `/projects/${projectId}/${kind}/${iid}/notes/${noteId}/award_emoji?name=${encodeURIComponent(name)}`,
      { method: "POST" },
    ),

  awardOnResource: (
    projectId: number,
    kind: ResourceKind,
    iid: number,
    name: string,
  ) =>
    api(
      `/projects/${projectId}/${kind}/${iid}/award_emoji?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
      },
    ),

  mergeRequest: (projectId: number, iid: number) =>
    api<MergeRequestDetail>(`/projects/${projectId}/merge_requests/${iid}`),

  mergeRequestDiffs: (projectId: number, iid: number) =>
    api<DiffFile[]>(
      `/projects/${projectId}/merge_requests/${iid}/diffs?per_page=100`,
    ),

  closesIssues: (projectId: number, iid: number) =>
    api<IssueDetail[]>(
      `/projects/${projectId}/merge_requests/${iid}/closes_issues`,
    ),

  issue: (projectId: number, iid: number) =>
    api<IssueDetail>(`/projects/${projectId}/issues/${iid}`),

  notes: (projectId: number, kind: ResourceKind, iid: number) =>
    api<Note[]>(
      `/projects/${projectId}/${kind}/${iid}/notes?per_page=100&sort=asc`,
    ),

  project: (path: string) =>
    api<{ id: number; path_with_namespace: string }>(
      `/projects/${encodeURIComponent(path)}`,
    ),

  mergeRequestVersions: (projectId: number, iid: number) =>
    api<
      {
        base_commit_sha: string;
        head_commit_sha: string;
        start_commit_sha: string;
      }[]
    >(`/projects/${projectId}/merge_requests/${iid}/versions`),

  createDiscussion: (
    projectId: number,
    iid: number,
    form: Record<string, string | number | undefined>,
  ) =>
    apiForm<{ id: string }>(
      `/projects/${projectId}/merge_requests/${iid}/discussions`,
      form,
    ),

  branch: (projectId: number, name: string) =>
    api<{ name: string; protected: boolean }>(
      `/projects/${projectId}/repository/branches/${encodeURIComponent(name)}`,
    ),
};
