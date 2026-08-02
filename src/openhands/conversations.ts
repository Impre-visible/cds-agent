/**
 * Quelle conversation OpenHands appartient à quelle merge request.
 *
 * LE PROBLÈME QUE CE FICHIER RÉSOUT. Sans lui, chaque mention du bot démarre
 * une conversation neuve, donc un bac à sable neuf, donc un conteneur
 * `oh-agent-server-<id>` de plus. Deux relances sur la même merge request
 * laissaient deux conteneurs derrière elles — et rien ne les arrête, puisque
 * l'application server d'OpenHands n'a aucun ramasseur d'inactivité (son seul
 * nettoyage, `pause_old_sandboxes`, ne se déclenche qu'au démarrage d'un
 * nouveau bac à sable, au-delà d'une limite).
 *
 * Avec ce registre, une deuxième mention sur la même merge request REPREND la
 * conversation précédente : un seul conteneur par merge request, et — c'est
 * le gain qu'on n'attendait pas — l'agent garde le contexte de ce qu'il a
 * déjà dit. « J'ai pas compris ta remarque » arrive dans une conversation qui
 * contient la remarque.
 *
 * POURQUOI PAS `state/processed.jsonl`. Ce journal-là répond à « cette
 * demande a-t-elle déjà été traitée ? », clé par clé de demande, et il est
 * compacté. Ici la question est « ce dépôt+MR a-t-il une conversation
 * vivante ? » : une seule ligne par merge request, écrasée à chaque fois.
 * Deux questions différentes, deux fichiers — les mélanger obligerait à faire
 * survivre au compactage des entrées qui n'ont pas la même durée de vie.
 *
 * ÉCRITURE ATOMIQUE. Le fichier entier est réécrit à chaque enregistrement
 * (il compte une ligne par merge request active — quelques dizaines au pire).
 * Passer par un fichier temporaire puis `renameSync` évite qu'un arrêt en
 * plein milieu ne laisse un JSON tronqué, qui ferait repartir toutes les
 * merge requests sur des conversations neuves au prochain démarrage.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Ce qu'on retient d'une conversation, et rien de plus. */
export interface ConversationRef {
  conversationId: string;
  /**
   * Nécessaire pour relancer le bac à sable avant d'y envoyer un message
   * (`POST /api/v1/sandboxes/{id}/resume`) : l'API de reprise prend
   * l'identifiant du BAC À SABLE, pas celui de la conversation.
   */
  sandboxId: string | null;
}

/**
 * Clé stable d'une merge request. Le chemin du dépôt est normalisé en
 * minuscules, comme partout ailleurs dans le projet (voir authorize.ts et
 * projects.ts) : GitLab est insensible à la casse sur les chemins de projet,
 * et deux clés pour la même MR rouvriraient une conversation de trop.
 */
export function conversationKey(projectPath: string, iid: number): string {
  return `${projectPath.toLowerCase()}!${iid}`;
}

export class ConversationStore {
  readonly #path: string;
  #entries: Map<string, ConversationRef>;

  constructor(path: string) {
    this.#path = path;
    this.#entries = ConversationStore.#load(path);
  }

  static #load(path: string): Map<string, ConversationRef> {
    if (!existsSync(path)) return new Map();
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return new Map();
      }
      const entries = new Map<string, ConversationRef>();
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value === null || typeof value !== "object") continue;
        const ref = value as Record<string, unknown>;
        if (typeof ref.conversationId !== "string") continue;
        entries.set(key, {
          conversationId: ref.conversationId,
          sandboxId: typeof ref.sandboxId === "string" ? ref.sandboxId : null,
        });
      }
      return entries;
    } catch {
      // Fichier illisible ou corrompu : on repart d'un registre vide plutôt
      // que d'empêcher le daemon de démarrer. La perte est bénigne — au pire
      // chaque merge request rouvre une conversation — là où un démarrage
      // refusé bloquerait tout le service pour une information accessoire.
      return new Map();
    }
  }

  /** `null` : aucune conversation connue pour cette merge request. */
  get(key: string): ConversationRef | null {
    return this.#entries.get(key) ?? null;
  }

  /** Enregistre (ou remplace) la conversation associée à une merge request. */
  set(key: string, ref: ConversationRef): void {
    this.#entries.set(key, ref);
    this.#persist();
  }

  /**
   * Oublie la conversation d'une merge request — appelé quand elle s'avère
   * inutilisable (supprimée côté OpenHands, archivée, bac à sable perdu).
   * Sans ça, une conversation morte serait retentée à chaque relance.
   */
  forget(key: string): void {
    if (this.#entries.delete(key)) this.#persist();
  }

  #persist(): void {
    const directory = dirname(this.#path);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.#entries), null, 2));
    renameSync(temporary, this.#path);
  }
}
