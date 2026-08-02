/**
 * Comment une demande rend son résultat à celui qui l'a posée.
 *
 * Extrait de tasks/router.ts, qui portait à la fois l'aiguillage d'intention,
 * l'exécution maison et le compte rendu. Sur cette branche, l'exécution est
 * entièrement déléguée à OpenHands (voir tasks/openhands.ts) et router.ts
 * n'existe plus — mais le compte rendu, lui, reste la responsabilité du
 * daemon : c'est lui qui a posé la réaction 👀 au moment de l'accusé de
 * réception (daemon/index.ts::acknowledge), lui seul sait la faire évoluer.
 *
 * Rien ici n'a changé de comportement en passant d'un fichier à l'autre.
 */

import { gitlab } from "../gitlab/client.ts";
import { log } from "../log.ts";
import type { AckHandle, AgentRequest } from "../types.ts";

/**
 * Issue d'une demande, du point de vue de quelqu'un qui parcourt une liste de
 * MR sans lire les commentaires.
 *
 * C'était un booléen (`ok`) jusqu'au 1er août 2026, et la campagne de mesure a
 * montré que deux valeurs ne suffisent pas : un résultat qui demande une
 * décision humaine n'appartient à aucun des deux sacs. Le ranger avec les
 * succès confondrait les deux issues les plus opposées qui existent ; le
 * ranger avec les pannes le ferait passer pour un dysfonctionnement, alors
 * qu'il signale précisément le contraire — quelque chose à regarder.
 *
 * - "delivered" : livré ;
 * - "to-triage" : rien n'est livré, mais il y a une décision humaine à
 *   prendre — c'est un résultat, pas une panne ;
 * - "failed"    : échec réel.
 */
export type TaskOutcome = "delivered" | "to-triage" | "failed";

/**
 * L'API award emoji accepte n'importe quel nom de la table gemoji : rien
 * n'obligeait à se limiter à deux réactions.
 */
const OUTCOME_EMOJI: Record<TaskOutcome, string> = {
  delivered: "white_check_mark",
  "to-triage": "mag",
  failed: "x",
};

/**
 * §6.10 : fait évoluer la réaction 👀 (posée par daemon/index.ts::acknowledge())
 * vers ✅, 🔍 ou ❌ selon l'issue de la tâche. L'API award emoji ne propose pas
 * de mise à jour en place : on supprime l'ancienne réaction (si elle a pu être
 * posée, voir AckHandle.awardId) avant d'en poser une nouvelle. Best-effort,
 * comme l'accusé de réception initial : un échec ici ne doit jamais faire
 * perdre le résultat déjà publié par report() ci-dessous.
 */
async function evolveReaction(
  request: AgentRequest,
  ack: AckHandle,
  outcome: TaskOutcome,
): Promise<void> {
  const { projectId, kind, iid, noteId } = request;
  const emoji = OUTCOME_EMOJI[outcome];

  try {
    if (ack.awardId !== null) {
      if (noteId === null) {
        await gitlab.deleteAwardOnResource(projectId, kind, iid, ack.awardId);
      } else {
        await gitlab.deleteAwardOnNote(projectId, kind, iid, noteId, ack.awardId);
      }
    }
    if (noteId === null) {
      await gitlab.awardOnResource(projectId, kind, iid, emoji);
    } else {
      await gitlab.awardOnNote(projectId, kind, iid, noteId, emoji);
    }
  } catch (error) {
    log.warn(
      `évolution de la réaction emoji impossible : ${(error as Error).message}`,
    );
  }
}

/**
 * §6.10 : édite l'accusé de réception (request.ack) plutôt que de poster une
 * nouvelle note, pour qu'une seule note porte le statut vivant de la demande
 * — voir daemon/index.ts::acknowledge() pour la pose initiale de cette note
 * et de sa réaction 👀.
 *
 * Si l'édition échoue (note supprimée entre-temps par un humain, par
 * exemple) : le résultat n'est pas perdu, on republie une note neuve — sans
 * ack (dry-run, tests), report() se comporte comme une simple création.
 */
export async function report(
  request: AgentRequest,
  body: string | null,
  outcome: TaskOutcome,
): Promise<void> {
  // La réaction d'abord, et toujours : elle n'ajoute aucune note à la
  // conversation et survit à la suppression de tout le reste.
  if (request.ack) await evolveReaction(request, request.ack, outcome);

  // `null` : rien à dire. Un « traitement terminé, tout va bien » n'apprend
  // rien que la réaction ne dise déjà, et s'accumule à chaque demande sur une
  // merge request active.
  if (body === null) return;

  const fullBody = `${body}\n\n<sub>cds-agent</sub>`;

  // ackNoteId n'est plus renseigné depuis qu'aucune note n'est postée à la
  // réception (voir acknowledge dans daemon/index.ts) ; le chemin d'édition
  // reste là pour une demande accusée par une version antérieure du daemon,
  // toujours en file au moment d'une mise à jour.
  if (request.ack?.ackNoteId != null) {
    try {
      await gitlab.updateNote(
        request.projectId,
        request.kind,
        request.iid,
        request.ack.ackNoteId,
        fullBody,
      );
      return;
    } catch (error) {
      log.warn(
        `édition de l'accusé de réception impossible (${(error as Error).message}) — ` +
          `note peut-être supprimée entre-temps : republication d'une nouvelle note`,
      );
    }
  }

  await gitlab.createNote(request.projectId, request.kind, request.iid, fullBody);
}
