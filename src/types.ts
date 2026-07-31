export interface GitLabUser {
  id: number;
  username: string;
  name: string;
}

export interface TodoTarget {
  id: number;
  iid?: number;
  title?: string;
  project_id?: number;
}

export interface Todo {
  id: number;
  action_name: string;
  target_type: string;
  target: TodoTarget | null;
  target_url: string;
  body: string;
  state: string;
  created_at: string;
  author: GitLabUser;
  project?: { id: number; path_with_namespace: string } | null;
}

export interface Note {
  id: number;
  body: string;
  system: boolean;
  created_at: string;
  author: GitLabUser;
}

export type ResourceKind = "issues" | "merge_requests";

export interface AgentRequest {
  /** Clé d'idempotence stable, dérivée de la note (ou de la description). */
  key: string;
  todoId: number;
  projectId: number;
  projectPath: string;
  kind: ResourceKind;
  iid: number;
  /** null quand la mention est dans la description et non dans un commentaire. */
  noteId: number | null;
  requester: string;
  /** Texte exact de la demande, relu depuis l'API. */
  text: string;
  targetUrl: string;
}

export interface DiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

export interface DiffFile {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
}

export interface MergeRequestDetail {
  iid: number;
  title: string;
  description: string | null;
  author: GitLabUser;
  source_branch: string;
  target_branch: string;
  web_url: string;
  diff_refs: DiffRefs | null;
}

export interface IssueDetail {
  iid: number;
  title: string;
  description: string | null;
  author: GitLabUser;
  web_url: string;
}

export interface LinkedIssue {
  iid: number;
  title: string;
  description: string;
  comments: string[];
}

export interface TaskContext {
  instanceUrl: string;
  projectId: number;
  projectPath: string;
  targetKind: ResourceKind;
  targetIid: number;
  targetTitle: string;
  targetDescription: string;
  requester: string;
  requestText: string;
  linkedIssue: LinkedIssue | null;
  diffRefs: DiffRefs | null;
  files: DiffFile[];
  sourceBranch: string | null;
}
