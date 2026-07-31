import type { AgentRequest } from "../types.ts";
import { defuseMentions } from "./request.ts";

/**
 * Corps de l'accusé de réception posté sur GitLab (§6.10) : cite la demande
 * telle que reçue (défusée, voir request.ts, pour ne pas re-déclencher de
 * mention), indique la position dans la file, et donne la clé d'idempotence
 * de la demande.
 *
 * Ne mentionne plus le contrat de fiabilité de la file en mémoire (perte
 * possible d'une demande accusée mais jamais démarrée si le daemon s'arrête
 * ou crashe avant) : décision du propriétaire du projet — aucune annonce de
 * contrat de fiabilité, faible ou fort, dans ce qui est adressé à
 * l'utilisateur. L'information elle-même n'a pas disparu : elle reste vraie,
 * le comportement du daemon ne change pas (une tâche jamais démarrée est
 * toujours marquée `failed` avec sa raison dans le store, voir
 * shutdownSequence() dans index.ts), et elle reste documentée pour qui
 * regarde le code ou la doc du projet — README.md (§ Limites connues) et
 * docs/adr/0004-contrat-fiabilite-file-memoire.md.
 */
export function ackBody(request: AgentRequest, position: number): string {
  const quoted = defuseMentions(request.text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  const status =
    position <= 1
      ? "traitement en cours."
      : `mise en file d'attente, position ${position}.`;

  return [
    `🤖 Demande reçue de @${request.requester}, ${status}`,
    "",
    quoted,
    "",
    `<sub>cds-agent · POC local · clé \`${request.key}\`</sub>`,
  ].join("\n");
}
