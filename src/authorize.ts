import { config } from "./env.ts";
import type { AgentRequest } from "./types.ts";

export type Authorization = { allowed: true } | { allowed: false; reason: string };

export function authorize(request: AgentRequest): Authorization {
  // Fail-closed : une liste vide n'autorise rien.
  if (config.allowedProjects.length === 0) {
    return { allowed: false, reason: "ALLOWED_PROJECTS vide — aucun dépôt autorisé" };
  }
  if (config.allowedUsers.length === 0) {
    return { allowed: false, reason: "ALLOWED_USERS vide — aucun auteur autorisé" };
  }

  if (!config.allowedProjects.includes(request.projectPath.toLowerCase())) {
    return { allowed: false, reason: `dépôt « ${request.projectPath} » hors liste blanche` };
  }
  if (!config.allowedUsers.includes(request.requester.toLowerCase())) {
    return { allowed: false, reason: `auteur @${request.requester} hors liste blanche` };
  }

  return { allowed: true };
}
