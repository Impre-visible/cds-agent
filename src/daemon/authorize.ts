import type { AgentRequest } from "../types.ts";
import type { ResolvedProject } from "../projects.ts";

/**
 * `silent` distingue les deux motifs de refus possibles, de façon
 * exploitable par le code appelant (voir index.ts) et pas seulement dans le
 * texte de `reason` :
 *
 * - silent: true  → le dépôt lui-même est hors périmètre (absent de
 *   projects.json). Répondre révélerait à quelqu'un qui n'a rien à en
 *   savoir l'existence du bot, et permettrait d'énumérer les dépôts
 *   surveillés en essayant plusieurs projets. On se tait.
 * - silent: false → le dépôt est dans le périmètre surveillé (il a une
 *   entrée dans projects.json), mais l'auteur ne l'est pas (ou aucun auteur
 *   ne l'est). Le demandeur a déjà, par construction, mentionné le bot sur
 *   ce dépôt précis : répondre ne lui apprend rien qu'il ne sache déjà, et
 *   c'est potentiellement un collègue légitime qui a simplement besoin
 *   qu'on l'ajoute à la liste "users" du dépôt. On le lui dit explicitement
 *   plutôt que de le laisser croire le bot en panne.
 */
export type Authorization =
  | { allowed: true }
  | { allowed: false; reason: string; silent: boolean };

/**
 * Chantier "projects.json" : la liste blanche de dépôts (ALLOWED_PROJECTS)
 * et la liste blanche d'auteurs (ALLOWED_USERS, jusque-là globale) sont
 * remplacées par la présence d'une entrée dans projects.json et par sa
 * propre liste "users" — voir src/projects.ts::resolveProject.
 *
 * `project` est résolu UNE SEULE FOIS par l'appelant (daemon/index.ts::
 * handle(), au tout début du traitement de la demande) : cette fonction ne
 * lit ni le registre ni l'environnement elle-même, ce qui la rend testable
 * directement, sans sous-processus ni configuration globale — voir
 * authorize.test.ts.
 */
export function authorize(
  request: AgentRequest,
  project: ResolvedProject | null,
): Authorization {
  // Fail-closed : un dépôt absent de projects.json n'autorise rien. Traité
  // comme "hors périmètre" (silencieux), exactement comme l'ancien
  // ALLOWED_PROJECTS vide ou ne listant pas ce dépôt.
  if (!project) {
    return {
      allowed: false,
      reason: `dépôt « ${request.projectPath} » absent de projects.json`,
      silent: true,
    };
  }

  // À partir d'ici, le dépôt est dans le périmètre surveillé : les refus
  // suivants ne portent que sur l'auteur, et sont donc explicites (voir la
  // doc du type Authorization ci-dessus).
  if (project.users.length === 0) {
    return {
      allowed: false,
      reason: `aucun auteur autorisé pour « ${request.projectPath} » (users vide dans projects.json)`,
      silent: false,
    };
  }
  const requester = request.requester.toLowerCase();
  if (!project.users.some((user) => user.toLowerCase() === requester)) {
    return {
      allowed: false,
      reason: `auteur @${request.requester} hors liste blanche`,
      silent: false,
    };
  }

  return { allowed: true };
}
