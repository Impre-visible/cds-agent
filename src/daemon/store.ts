import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Cycle de vie d'une demande, du dépôt du to-do jusqu'à son sort final :
 *
 *   claimed → acked → running → done
 *                   ↘        ↘
 *                     failed  failed
 *
 * - claimed : réservation posée avant toute écriture (voir handle()), rien
 *   d'autre n'est garanti.
 * - acked   : l'accusé de réception a été posté avec succès sur GitLab.
 * - running : le worker (runTask) a effectivement démarré — potentiellement
 *   jusqu'à pousser du code sur la branche source.
 * - done    : le worker est allé au bout, quel qu'ait été le résultat métier
 *   rapporté au demandeur (revue publiée, tests rouges, push effectué...).
 * - failed  : soit le worker a levé une exception, soit le daemon a
 *   abandonné la demande après épuisement des tentatives (voir index.ts).
 *
 * done et failed sont terminaux : plus aucune écriture ne doit pouvoir les
 * faire régresser (voir record()).
 */
export type RequestStatus = "claimed" | "acked" | "running" | "done" | "failed";

/**
 * Rang de progression dans le cycle de vie, utilisé pour interdire toute
 * régression. done et failed partagent le même rang : ce sont deux issues
 * terminales concurrentes, ni l'une ni l'autre ne doit pouvoir écraser
 * l'autre. Le rang sert aussi à absorber une course bénigne mais réelle :
 * handle() planifie la tâche dans la file (queue.push) *avant* d'attendre
 * l'accusé de réception, donc le worker peut écrire "running", voire
 * "done"/"failed", pendant que handle() est encore en train d'attendre
 * acknowledge(). Sans ce garde-fou, l'écriture tardive de "acked" par
 * handle() écraserait à tort un statut plus avancé déjà connu.
 */
const RANK: Record<RequestStatus, number> = {
  claimed: 0,
  acked: 1,
  running: 2,
  done: 3,
  failed: 3,
};

interface Entry {
  key: string;
  todoId: number;
  status: RequestStatus;
  at: string;
  /** Diagnostic humain, notamment pour distinguer les causes d'un "failed". */
  reason?: string;
}

/**
 * Décide si une demande peut être (re)traitée, à partir de son statut connu.
 * Fonction pure, exportée séparément de la classe pour être testable sans
 * fichier ni horloge (voir store.test.ts) — c'est elle qui remplace l'ancien
 * `store.has()`, qui traitait indistinctement tout statut connu comme
 * "déjà traité" et empêchait donc tout rejeu, y compris après un simple
 * échec réseau de l'accusé de réception.
 *
 * - undefined (jamais vu), claimed, acked : rien d'irréversible n'a eu lieu
 *   (au pire un accusé de réception ou une réaction posté(e) deux fois, un
 *   désagrément mineur) → rejouable.
 * - running : le worker a démarré et peut être en train de pousser du code ;
 *   on ne sait pas jusqu'où il est allé → PAS rejouable. Asymétrie
 *   volontaire avec claimed/acked : toutes les étapes transitoires ne se
 *   valent pas, et l'irréversibilité potentielle d'un push l'emporte sur le
 *   confort d'un rejeu automatique.
 * - done, failed : issue terminale → jamais rejouable.
 */
export function canProcess(status: RequestStatus | undefined): boolean {
  return status === undefined || status === "claimed" || status === "acked";
}

export class RequestStore {
  private readonly states = new Map<string, RequestStatus>();

  // Champ déclaré explicitement (plutôt qu'en propriété de paramètre du
  // constructeur) : le mode "type stripping" natif de Node n'accepte pas la
  // syntaxe raccourcie `constructor(private readonly path: string)`, voir
  // GitLabError dans gitlab/client.ts pour la même contrainte.
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;

    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Entry;
        // Relecture rétrocompatible : un fichier écrit par une version
        // antérieure ne contient que des statuts "claimed"/"acked", qui
        // restent des valeurs valides de RequestStatus — aucune migration
        // n'est nécessaire, on applique juste le même garde-fou de rang que
        // pour une écriture en direct.
        this.apply(entry.key, entry.status);
      } catch {
        console.warn(`[store] ligne illisible ignorée : ${line.slice(0, 80)}`);
      }
    }
  }

  private apply(key: string, status: RequestStatus): boolean {
    const current = this.states.get(key);
    if (current !== undefined && RANK[status] <= RANK[current]) return false;
    this.states.set(key, status);
    return true;
  }

  statusOf(key: string): RequestStatus | undefined {
    return this.states.get(key);
  }

  /**
   * Vrai si aucune demande n'a jamais été enregistrée dans ce fichier
   * d'état — sert de proxy à "tout premier démarrage" (voir bootstrap.ts,
   * §3.7) : une machine neuve ou un fichier d'état effacé produit un store
   * vide, alors qu'un redémarrage normal en cours d'exploitation en contient
   * déjà au moins une (ne serait-ce que la toute première demande jamais
   * traitée). Ne distingue pas ces deux cas avec une certitude absolue (un
   * daemon qui n'a jamais reçu la moindre mention aurait aussi un store
   * vide), mais traiter ce cas limite comme un premier démarrage — c'est-à-
   * dire amorcer sans notification plutôt que traiter normalement — n'a
   * aucune conséquence négative : par définition il n'y a alors rien à
   * traiter en retard.
   */
  isEmpty(): boolean {
    return this.states.size === 0;
  }

  /**
   * Enregistre une transition. Les écritures qui régresseraient le statut
   * connu (voir RANK) sont silencieusement ignorées : le fichier reste un
   * journal fidèle des tentatives d'écriture, mais l'état "actuel" exposé
   * par statusOf() ne recule jamais.
   */
  record(
    key: string,
    todoId: number,
    status: RequestStatus,
    reason?: string,
  ): void {
    if (!this.apply(key, status)) return;
    const entry: Entry = { key, todoId, status, at: new Date().toISOString(), reason };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  /**
   * Demandes dans un état non terminal au chargement du fichier : la
   * précédente instance ne les a pas menées jusqu'à done/failed, qu'elle ait
   * crashé ou qu'on l'ait arrêtée en cours de route. Utile à un humain qui
   * redémarre le daemon (voir main()) — le statut renvoyé permet de
   * distinguer ce qui se rejouera tout seul (claimed/acked, si le to-do est
   * toujours ouvert côté GitLab) de ce qui restera bloqué par design
   * (running, voir canProcess()).
   */
  interrupted(): { key: string; status: RequestStatus }[] {
    return [...this.states.entries()]
      .filter(([, status]) => status !== "done" && status !== "failed")
      .map(([key, status]) => ({ key, status }));
  }
}
