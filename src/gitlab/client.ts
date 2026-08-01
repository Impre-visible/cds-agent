import { config } from "../config.ts";
import { performFetch } from "./proxy-fetch.ts";
import { GITLAB_ERROR_BODY_CHARS, MAX_LIST_PAGES } from "../limits.ts";
import type {
  Discussion,
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
    super(`GitLab ${status} sur ${url} — ${payload.slice(0, GITLAB_ERROR_BODY_CHARS)}`);
    this.name = "GitLabError";
    this.status = status;
    this.url = url;
    this.payload = payload;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Un 429 ou un 5xx sont transitoires : la même requête a une chance
 * raisonnable de réussir un instant plus tard (limite de débit qui se
 * relâche, instance qui redémarre un worker surchargé...). Tout autre 4xx
 * (400, 401, 403, 404, 422...) signale une erreur de programmation ou de
 * permission : la réessayer ne change rien, sinon marteler l'API en pure
 * perte et noyer le vrai problème dans du bruit de logs.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * GET/HEAD sont sans effet de bord : les réessayer ne peut pas dupliquer une
 * écriture. Un POST (createNote, createDiscussion, markTodoDone...) qui
 * timeout ne dit en revanche pas si GitLab a reçu et traité la requête avant
 * de cesser de répondre — le réessayer pourrait publier deux fois le même
 * commentaire. On ne réessaie donc jamais automatiquement une écriture au
 * niveau transport (voir resilientFetch ci-dessous) : l'erreur remonte
 * telle quelle, et c'est la couche appelante (compteur d'échecs par to-do,
 * voir daemon/index.ts, combiné à la clé d'idempotence d'AgentRequest, voir
 * daemon/seen.ts) qui décide de rejouer la tâche entière au cycle de
 * polling suivant — pas une duplication silencieuse au niveau HTTP.
 */
function isIdempotentMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/**
 * `Retry-After` peut être un nombre de secondes ou une date HTTP (RFC 7231).
 * GitLab renvoie systématiquement des secondes en pratique, mais on gère les
 * deux formes plutôt que de silencieusement les ignorer si un proxy
 * intermédiaire réécrit l'en-tête.
 */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/**
 * Backoff exponentiel à jitter complet ("Exponential Backoff And Jitter",
 * AWS Architecture Blog) : un tirage uniforme entre 0 et le délai
 * exponentiel, plutôt qu'un délai fixe ou un jitter partiel. Sans jitter,
 * un incident GitLab qui touche plusieurs installations en même temps les
 * ferait toutes réessayer en cadence — exactement le motif qui prolonge un
 * incident au lieu de le résorber sur un PAT partagé.
 */
function jitteredBackoffMs(attempt: number): number {
  const cap = Math.min(
    config.gitlabRetryMaxDelayMs,
    config.gitlabRetryBaseMs * 2 ** (attempt - 1),
  );
  return Math.random() * cap;
}

/**
 * Remplace le `fetch` nu d'origine (§3.4) : sans lui, un GitLab qui pend
 * bloquait le worker indéfiniment (aucun timeout), et un 429/5xx isolé
 * remontait tel quel jusqu'à la boucle de polling — qui repartait à
 * l'identique 30 s plus tard, sans backoff ni jitter, de quoi transformer un
 * simple ralentissement en incident sur un PAT partagé.
 *
 * Le timeout s'applique à toutes les requêtes, écritures comprises (une
 * écriture qui pend doit aussi rendre la main). Le réessai automatique, en
 * revanche, ne s'applique qu'aux méthodes idempotentes — voir
 * isIdempotentMethod ci-dessus pour la justification côté écritures.
 */
async function resilientFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const retryBudget = isIdempotentMethod(method) ? config.gitlabMaxRetries : 0;

  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      // performFetch (§A) : proxy-aware — voir gitlab/proxy-fetch.ts. Retombe
      // sur le `fetch()` natif tel quel dès qu'aucun proxy ne s'applique à
      // `url`, donc sans changement de comportement dans le cas nominal
      // (aucun HTTP_PROXY/HTTPS_PROXY dans l'environnement).
      response = await performFetch(url, {
        ...init,
        signal: AbortSignal.timeout(config.gitlabRequestTimeoutMs),
      });
    } catch (error) {
      if (attempt > retryBudget) throw error;
      const wait = jitteredBackoffMs(attempt);
      console.warn(
        `  [gitlab] erreur réseau sur ${url} (${(error as Error).message}), nouvelle tentative ${attempt}/${retryBudget} dans ${Math.round(wait)} ms`,
      );
      await sleep(wait);
      continue;
    }

    if (
      response.ok ||
      !isRetryableStatus(response.status) ||
      attempt > retryBudget
    ) {
      return response;
    }

    // On consomme le corps de la réponse abandonnée avant de rejouer, pour
    // libérer proprement la connexion sous-jacente.
    await response.text().catch(() => {});

    const wait = retryAfterMs(response) ?? jitteredBackoffMs(attempt);
    console.warn(
      `  [gitlab] ${response.status} sur ${url}, nouvelle tentative ${attempt}/${retryBudget} dans ${Math.round(wait)} ms`,
    );
    await sleep(wait);
  }
}

interface RawResponse {
  text: string;
  response: Response;
}

async function rawRequest(url: string, init: RequestInit): Promise<RawResponse> {
  const response = await resilientFetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new GitLabError(response.status, url, text);
  return { text, response };
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${config.gitlabUrl}/api/v4${path}`;
  const { text } = await rawRequest(url, {
    ...init,
    headers: {
      "PRIVATE-TOKEN": config.token,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
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
  const { text } = await rawRequest(url, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": config.token,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  return (text ? JSON.parse(text) : null) as T;
}

interface Page<T> {
  items: T[];
  nextPage: number | null;
}

/** Une page brute d'une collection GitLab, avec l'indication de page suivante. */
async function apiPage<T>(path: string): Promise<Page<T>> {
  const url = `${config.gitlabUrl}/api/v4${path}`;
  const { text, response } = await rawRequest(url, {
    headers: {
      "PRIVATE-TOKEN": config.token,
      "Content-Type": "application/json",
    },
  });

  const nextPageHeader = response.headers.get("x-next-page");
  const nextPage = nextPageHeader ? Number(nextPageHeader) : NaN;

  return {
    items: (text ? JSON.parse(text) : []) as T[],
    nextPage: Number.isFinite(nextPage) && nextPage > 0 ? nextPage : null,
  };
}

/**
 * GitLab pagine toute collection au-delà de `per_page` (100 au maximum) et
 * l'indique via l'en-tête `x-next-page` — jamais via une erreur ni un champ
 * du corps de la réponse. Un `per_page=100` nu, sans lire cet en-tête, se
 * tait donc silencieusement sur tout ce qui dépasse la première page (voir
 * §3.5 : to-dos, fichiers de diff d'une grosse MR...). `maxPages` borne le
 * nombre de pages explorées : une ressource massive (des milliers de to-dos
 * en attente...) ne doit pas non plus déclencher un rapatriement sans fin
 * qui bloque le worker.
 */
async function paginate<T>(path: string, maxPages: number): Promise<T[]> {
  const separator = path.includes("?") ? "&" : "?";
  const items: T[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const result = await apiPage<T>(`${path}${separator}page=${page}`);
    items.push(...result.items);
    if (!result.nextPage) break;
  }

  return items;
}

// MAX_LIST_PAGES vient de src/limits.ts (§5.8) : jusqu'à 2000 éléments (100
// par page × 20 pages), largement au-delà de ce qu'un usage normal produit,
// tout en bornant le pire cas — partagée avec tasks/context.ts et
// tasks/publish.ts (voir là-bas).

export function resourceKind(targetType: string): ResourceKind | null {
  if (targetType === "Issue") return "issues";
  if (targetType === "MergeRequest") return "merge_requests";
  return null;
}

export const gitlab = {
  currentUser: () => api<GitLabUser>("/user"),

  pendingTodos: () =>
    paginate<Todo>("/todos?state=pending&per_page=100", MAX_LIST_PAGES),

  doneTodos: () =>
    paginate<Todo>("/todos?state=done&per_page=100", MAX_LIST_PAGES),

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

  /**
   * §6.10 : édite une note existante plutôt que d'en poster une nouvelle —
   * utilisé par tasks/router.ts::report() pour faire évoluer l'accusé de
   * réception vers le résultat final (une seule note, un statut vivant),
   * plutôt que d'empiler accusé de réception, remarques et synthèse.
   */
  updateNote: (
    projectId: number,
    kind: ResourceKind,
    iid: number,
    noteId: number,
    body: string,
  ) =>
    api<Note>(`/projects/${projectId}/${kind}/${iid}/notes/${noteId}`, {
      method: "PUT",
      body: JSON.stringify({ body }),
    }),

  /**
   * Chantier « fil de discussion » : supprime une note du bot.
   *
   * Sert à retirer l'accusé de réception une fois la réponse publiée DANS le
   * fil : sans ça, chaque question laisserait une note de plus au niveau de
   * la merge request, alors que tout ce qui compte est déjà dans le fil. La
   * réaction, elle, est posée sur la note de l'auteur (voir evolveReaction) —
   * elle survit à cette suppression et reste le signal de fin de traitement.
   */
  deleteNote: (
    projectId: number,
    kind: ResourceKind,
    iid: number,
    noteId: number,
  ) =>
    api<void>(`/projects/${projectId}/${kind}/${iid}/notes/${noteId}`, {
      method: "DELETE",
    }),

  // Réponse typée (id de la réaction posée) : §6.10 en a besoin pour pouvoir
  // ensuite la supprimer (deleteAwardOnNote/deleteAwardOnResource ci-dessous)
  // au moment de la faire évoluer 👀 → ✅/❌, l'API award emoji ne proposant
  // aucune mise à jour en place.
  awardOnNote: (
    projectId: number,
    kind: ResourceKind,
    iid: number,
    noteId: number,
    name: string,
  ) =>
    api<{ id: number }>(
      `/projects/${projectId}/${kind}/${iid}/notes/${noteId}/award_emoji?name=${encodeURIComponent(name)}`,
      { method: "POST" },
    ),

  awardOnResource: (
    projectId: number,
    kind: ResourceKind,
    iid: number,
    name: string,
  ) =>
    api<{ id: number }>(
      `/projects/${projectId}/${kind}/${iid}/award_emoji?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
      },
    ),

  /** §6.10 : supprime une réaction posée sur une note, avant d'en poser une nouvelle (voir awardOnNote ci-dessus). */
  deleteAwardOnNote: (
    projectId: number,
    kind: ResourceKind,
    iid: number,
    noteId: number,
    awardId: number,
  ) =>
    api<void>(
      `/projects/${projectId}/${kind}/${iid}/notes/${noteId}/award_emoji/${awardId}`,
      { method: "DELETE" },
    ),

  /** §6.10 : équivalent de deleteAwardOnNote, pour une réaction posée directement sur la ressource (mention dans une description). */
  deleteAwardOnResource: (
    projectId: number,
    kind: ResourceKind,
    iid: number,
    awardId: number,
  ) =>
    api<void>(
      `/projects/${projectId}/${kind}/${iid}/award_emoji/${awardId}`,
      { method: "DELETE" },
    ),

  mergeRequest: (projectId: number, iid: number) =>
    api<MergeRequestDetail>(`/projects/${projectId}/merge_requests/${iid}`),

  mergeRequestDiffs: (projectId: number, iid: number) =>
    paginate<DiffFile>(
      `/projects/${projectId}/merge_requests/${iid}/diffs?per_page=100`,
      MAX_LIST_PAGES,
    ),

  closesIssues: (projectId: number, iid: number) =>
    api<IssueDetail[]>(
      `/projects/${projectId}/merge_requests/${iid}/closes_issues`,
    ),

  issue: (projectId: number, iid: number) =>
    api<IssueDetail>(`/projects/${projectId}/issues/${iid}`),

  /**
   * Une page de notes, la plus ancienne ou la plus récente en tête selon
   * `order`, avec l'indication GitLab de page suivante. Exposé en primitive
   * page-par-page — plutôt qu'un `notes()` qui rapatrierait systématiquement
   * tout l'historique — pour que chaque appelant décide lui-même quand
   * s'arrêter, selon son propre besoin :
   * - tasks/context.ts::recentHumanNotes n'a besoin que des derniers
   *   commentaires humains et s'arrête dès qu'il en a assez (sort=desc,
   *   arrêt anticipé — voir §3.5, un ticket de 300 commentaires n'a pas à
   *   être rapatrié en entier pour ça) ;
   * - tasks/publish.ts::alreadyPublished a besoin, à l'inverse, de tout
   *   parcourir (une empreinte de déduplication peut se trouver n'importe
   *   où dans l'historique) mais préfère le faire en ordre chronologique et
   *   avec sa propre borne de pages, plutôt que via une méthode bulk qui
   *   masquerait ce choix.
   */
  notesPage: (
    projectId: number,
    kind: ResourceKind,
    iid: number,
    page: number,
    order: "asc" | "desc" = "asc",
  ) =>
    apiPage<Note>(
      `/projects/${projectId}/${kind}/${iid}/notes?per_page=100&sort=${order}&order_by=created_at&page=${page}`,
    ),

  /**
   * Chantier « fil de discussion » : les notes d'une cible, GROUPÉES par fil.
   * L'API des notes (notesPage ci-dessus) ne dit PAS à quelle discussion
   * appartient une note — c'est seulement ici que le lien existe. C'est donc
   * le seul moyen de retrouver le fil qui contient la note d'une demande, et
   * de savoir si le bot y a déjà parlé.
   */
  discussionsPage: (
    projectId: number,
    kind: ResourceKind,
    iid: number,
    page: number,
  ) =>
    apiPage<Discussion>(
      `/projects/${projectId}/${kind}/${iid}/discussions?per_page=100&page=${page}`,
    ),

  /**
   * Répond DANS un fil existant, plutôt que d'ouvrir un nouveau commentaire.
   * C'est ce qui fait qu'une explication reste attachée à la remarque qu'elle
   * explique, au lieu de repartir en bas de la merge request.
   */
  createDiscussionNote: (
    projectId: number,
    kind: ResourceKind,
    iid: number,
    discussionId: string,
    body: string,
  ) =>
    apiForm<{ id: number }>(
      `/projects/${projectId}/${kind}/${iid}/discussions/${encodeURIComponent(discussionId)}/notes`,
      { body },
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

  /**
   * Chantier "capacités" (§A.3, publishMode "dedicated-mr") : ouvre une
   * merge request depuis une branche déjà poussée par le bot
   * (tasks/implement.ts::openDedicatedMergeRequest) vers la branche source
   * d'origine, plutôt qu'un push direct dessus. `apiForm` (déjà utilisée par
   * createDiscussion ci-dessus) suffit : aucun besoin d'un nouveau mécanisme
   * HTTP pour cet appel.
   */
  createMergeRequest: (
    projectId: number,
    form: {
      source_branch: string;
      target_branch: string;
      title: string;
      description?: string;
    },
  ) =>
    apiForm<{ iid: number; web_url: string }>(
      `/projects/${projectId}/merge_requests`,
      form,
    ),

  /**
   * MR ouvertes ciblant une branche donnée — utilisé par tasks/implement.ts
   * pour retrouver une MR Draft "tests rouges" encore ouverte avant d'en
   * empiler une nouvelle (déduplication). Le filtre fin (préfixe de branche
   * du bot, titre) reste côté appelant : l'API ne sait filtrer que par état
   * et branche cible, et c'est suffisant pour borner la liste.
   */
  openMergeRequests: (projectId: number, targetBranch: string) =>
    paginate<{
      iid: number;
      web_url: string;
      source_branch: string;
      title: string;
    }>(
      `/projects/${projectId}/merge_requests?state=opened&target_branch=${encodeURIComponent(targetBranch)}&per_page=100`,
      MAX_LIST_PAGES,
    ),

  /** Met à jour titre/description d'une MR existante (rafraîchissement d'une MR Draft dédupliquée). */
  updateMergeRequest: (
    projectId: number,
    iid: number,
    form: { title?: string; description?: string },
  ) =>
    api<{ iid: number; web_url: string }>(
      `/projects/${projectId}/merge_requests/${iid}`,
      { method: "PUT", body: JSON.stringify(form) },
    ),
};
