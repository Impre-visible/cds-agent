import type { ResolvedProject } from "./projects.ts";

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
  /**
   * Horodatage de la dernière modification du to-do lui-même (pas de sa
   * cible) — confirmé présent sur l'objet top-level dans la documentation de
   * l'API GitLab (`GET /todos`, exemples de réponse), distinct de
   * `target.updated_at` qui porte sur l'issue/MR. C'est ce champ que
   * `collectTodos()` (`daemon/todos.ts`) utilise pour filtrer les to-dos
   * `done` récents : GitLab n'expose pas de `completed_at` séparé, mais un
   * changement d'état (pending → done) met à jour ce champ comme toute
   * autre modification du to-do — voir docs/adr/0001-polling-plutot-que-webhook.md.
   */
  updated_at: string;
  author: GitLabUser;
  project?: { id: number; path_with_namespace: string } | null;
}

export interface Note {
  id: number;
  body: string;
  system: boolean;
  created_at: string;
  author: GitLabUser;
  /**
   * "DiffNote" quand la note est ancrée à une ligne du diff, "DiscussionNote"
   * pour un fil sans ancrage, absent/null pour un commentaire isolé. Renseigné
   * par l'API des discussions ; sert au chantier « fil de discussion » à dire
   * à quel endroit du code une question se rapporte. Lu par personne sur
   * cette branche : le daemon ne construit plus de contexte de fil, il
   * transmet l'adresse de la note et laisse OpenHands remonter le fil.
   */
  type?: string | null;
  /** Ancrage de la note dans le diff, présent pour un type "DiffNote". */
  position?: {
    new_path?: string;
    old_path?: string;
    new_line?: number | null;
    old_line?: number | null;
  } | null;
}

/**
 * Un fil de discussion GitLab : la note d'origine et toutes ses réponses.
 * `individual_note` vaut true pour un commentaire isolé (pas un vrai fil) —
 * on ne peut alors pas y répondre en tant que discussion.
 *
 * Sert à retrouver DANS QUEL FIL une demande a été posée, pour dire à
 * OpenHands d'y répondre au lieu d'ouvrir un commentaire de plus au niveau de
 * la merge request (voir tasks/openhands.ts::findDiscussion).
 */
export interface Discussion {
  id: string;
  individual_note: boolean;
  notes: Note[];
}

export type ResourceKind = "issues" | "merge_requests";

/**
 * §6.10 : ce que l'accusé de réception (posté par daemon/index.ts::acknowledge())
 * laisse circuler jusqu'à report() (tasks/report.ts) pour éditer cette même
 * note une fois le résultat connu, plutôt que d'en poster une nouvelle —
 * les deux fonctions ne se connaissent pas autrement, AgentRequest est le
 * véhicule qui les relie (voir AgentRequest.ack).
 */
export interface AckHandle {
  /**
   * Identifiant de la note d'accusé de réception, à éditer avec le résultat
   * final — `null` depuis qu'aucune note n'est postée à la réception (voir
   * acknowledge() dans daemon/index.ts). La réaction 👀 posée sur la demande
   * elle-même suffit à dire « c'est pris en compte », sans ajouter de note à
   * la merge request.
   */
  ackNoteId: number | null;
  /**
   * Identifiant de la réaction 👀 posée sur la note/ressource déclenchante
   * (voir AgentRequest.noteId) au moment de l'accusé de réception, pour
   * pouvoir la supprimer avant de poser ✅/❌ — l'API award emoji ne propose
   * pas de mise à jour en place, seulement créer/supprimer (voir report()
   * dans router.ts). `null` si la réaction n'a pas pu être posée (best-effort,
   * voir acknowledge()) : rien à supprimer dans ce cas, on se contente de
   * poser la nouvelle.
   */
  awardId: number | null;
}

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
  /**
   * Renseigné par daemon/index.ts::handle() une fois l'accusé de réception
   * posté, avant que la demande n'entre dans la file (voir queue.ts) : le
   * worker (tasks/report.ts::report()) l'utilise pour éditer cette note au
   * lieu d'en poster une nouvelle (§6.10). Absent pour les usages hors
   * production (outils dry-run, tests) : report() se rabat alors sur son
   * ancien comportement (poster une note neuve).
   */
  ack?: AckHandle;
  /**
   * Chantier "projects.json" : configuration résolue de ce dépôt (capacités,
   * commandes, image Docker, répertoires de test), figée par
   * daemon/index.ts::handle() au tout début du traitement de la demande —
   * jamais relue depuis le registre par la suite, y compris si projects.json
   * est rechargé pendant que cette demande patiente en file ou s'exécute
   * (voir src/projects.ts::ProjectsRegistry). Garanti présent pour toute
   * demande qui atteint le worker (tasks/openhands.ts) : authorize()
   * n'autorise jamais une demande dont le projet est absent de
   * projects.json. Absent pour les usages hors production antérieurs à
   * l'accusé de réception (dry-run, tests) — même statut optionnel que
   * `ack` ci-dessus, pour la même raison.
   */
  project?: ResolvedProject;
}

export interface MergeRequestDetail {
  iid: number;
  title: string;
  description: string | null;
  author: GitLabUser;
  source_branch: string;
  target_branch: string;
  web_url: string;
}

