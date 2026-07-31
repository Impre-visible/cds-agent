import { config } from "../config.ts";
import type { AgentRequest } from "../types.ts";

/**
 * `silent` distingue les deux motifs de refus possibles, de façon
 * exploitable par le code appelant (voir index.ts) et pas seulement dans le
 * texte de `reason` :
 *
 * - silent: true  → le dépôt lui-même est hors périmètre (ou aucun dépôt
 *   n'est autorisé du tout). Répondre révélerait à quelqu'un qui n'a rien à
 *   en savoir l'existence du bot, et permettrait d'énumérer les dépôts
 *   surveillés en essayant plusieurs projets. On se tait.
 * - silent: false → le dépôt est dans le périmètre surveillé, mais
 *   l'auteur ne l'est pas (ou aucun auteur ne l'est). Le demandeur a déjà,
 *   par construction, mentionné le bot sur ce dépôt précis : répondre ne lui
 *   apprend rien qu'il ne sache déjà, et c'est potentiellement un collègue
 *   légitime qui a simplement besoin qu'on l'ajoute à ALLOWED_USERS. On le
 *   lui dit explicitement plutôt que de le laisser croire le bot en panne.
 */
export type Authorization =
  | { allowed: true }
  | { allowed: false; reason: string; silent: boolean };

export function authorize(request: AgentRequest): Authorization {
  // Fail-closed : une liste de dépôts vide n'autorise rien. Traité comme
  // "hors périmètre" (silencieux) : tant qu'aucun dépôt n'est déclaré, on ne
  // peut pas distinguer un dépôt qui deviendrait légitime une fois la liste
  // remplie d'un dépôt réellement hors sujet — le silence reste le choix le
  // plus prudent.
  if (config.allowedProjects.length === 0) {
    return {
      allowed: false,
      reason: "ALLOWED_PROJECTS vide — aucun dépôt autorisé",
      silent: true,
    };
  }
  if (!config.allowedProjects.includes(request.projectPath.toLowerCase())) {
    return {
      allowed: false,
      reason: `dépôt « ${request.projectPath} » hors liste blanche`,
      silent: true,
    };
  }

  // À partir d'ici, le dépôt est dans le périmètre surveillé : les refus
  // suivants ne portent que sur l'auteur, et sont donc explicites (voir la
  // doc du type Authorization ci-dessus).
  if (config.allowedUsers.length === 0) {
    return {
      allowed: false,
      reason: "ALLOWED_USERS vide — aucun auteur autorisé",
      silent: false,
    };
  }
  if (!config.allowedUsers.includes(request.requester.toLowerCase())) {
    return {
      allowed: false,
      reason: `auteur @${request.requester} hors liste blanche`,
      silent: false,
    };
  }

  return { allowed: true };
}
