import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
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
 * §6.6 : au-delà de ce nombre de lignes brutes relues au démarrage, on
 * compacte (voir compact() ci-dessous) plutôt que de laisser le fichier
 * grossir indéfiniment. Un cycle de vie complet (claimed → acked → running →
 * done|failed) écrit jusqu'à quatre lignes pour une seule demande alors
 * qu'une seule information utile subsiste au final (son dernier statut) :
 * à quelques centaines de demandes par jour, ce seuil est franchi en
 * quelques jours d'exploitation, ce qui borne à la fois le temps de
 * relecture au démarrage et l'empreinte mémoire — sans pour autant compacter
 * à chaque redémarrage un fichier encore petit (le cas courant, en
 * développement ou juste après un démarrage à blanc).
 */
const COMPACT_THRESHOLD_LINES = 500;

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
  // Une seule entrée par clé : le dernier statut connu, avec assez
  // d'information (todoId, at, reason) pour pouvoir réécrire une ligne
  // équivalente lors d'un compactage (voir compact()) sans rien perdre de ce
  // qu'un lecteur du fichier pourrait vouloir inspecter après coup.
  private readonly latest = new Map<string, Entry>();

  // Champ déclaré explicitement (plutôt qu'en propriété de paramètre du
  // constructeur) : le mode "type stripping" natif de Node n'accepte pas la
  // syntaxe raccourcie `constructor(private readonly path: string)`, voir
  // GitLabError dans gitlab/client.ts pour la même contrainte.
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;

    let rawLines = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      rawLines++;
      try {
        const entry = JSON.parse(line) as Entry;
        // Relecture rétrocompatible : un fichier écrit par une version
        // antérieure ne contient que des statuts "claimed"/"acked", qui
        // restent des valeurs valides de RequestStatus — aucune migration
        // n'est nécessaire, on applique juste le même garde-fou de rang que
        // pour une écriture en direct.
        this.apply(entry);
      } catch {
        console.warn(`[store] ligne illisible ignorée : ${line.slice(0, 80)}`);
      }
    }

    // §6.6 : compactage au démarrage, seulement si le fichier a dépassé le
    // seuil — un fichier tout juste écrit n'a rien à gagner à être réécrit
    // à chaque redémarrage. rawLines compte aussi les lignes corrompues :
    // elles coûtent le même I/O et la même relecture qu'une ligne valide, et
    // le compactage les purge définitivement (this.latest ne les contient
    // de toute façon jamais).
    if (rawLines > COMPACT_THRESHOLD_LINES) {
      try {
        this.compact();
      } catch (error) {
        // this.latest est déjà complet et correct en mémoire, peu importe
        // que la réécriture physique ait réussi : un compactage manqué (par
        // exemple disque plein, ou système de fichiers en lecture seule) ne
        // doit pas empêcher le daemon de démarrer avec le fichier tel qu'il
        // est — seulement le laisser un peu plus longtemps qu'espéré.
        console.warn(
          `[store] compactage échoué, fichier laissé tel quel : ${(error as Error).message}`,
        );
      }
    }
  }

  private apply(entry: Entry): boolean {
    const current = this.latest.get(entry.key);
    if (current !== undefined && RANK[entry.status] <= RANK[current.status])
      return false;
    this.latest.set(entry.key, entry);
    return true;
  }

  /**
   * Réécrit le fichier avec une seule ligne par clé (son dernier statut
   * connu) : ce que this.latest contient déjà en mémoire. Écrit dans un
   * fichier temporaire puis renomme atomiquement par-dessus l'original —
   * jamais de réécriture en place — pour qu'un crash pendant le compactage
   * ne puisse jamais laisser le fichier dans un état à moitié écrit :
   * `renameSync` remplace l'ancien fichier par le nouveau en une seule
   * opération côté OS (même système de fichiers), ce qui n'est pas le cas
   * d'une écriture directe sur `this.path` (qui laisserait un fichier
   * tronqué, donc potentiellement illisible, si le process meurt au milieu).
   * Si le process meurt entre l'écriture du temporaire et le renommage, le
   * pire cas est un fichier `.tmp` orphelin à côté d'un `this.path` intact
   * et jamais touché — jamais une corruption.
   */
  private compact(): void {
    const tmpPath = `${this.path}.compact.tmp`;
    const lines = [...this.latest.values()]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    writeFileSync(tmpPath, lines.length > 0 ? `${lines}\n` : "", "utf8");
    renameSync(tmpPath, this.path);
  }

  statusOf(key: string): RequestStatus | undefined {
    return this.latest.get(key)?.status;
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
    return this.latest.size === 0;
  }

  /**
   * Enregistre une transition. Les écritures qui régresseraient le statut
   * connu (voir RANK) sont silencieusement ignorées : le fichier reste un
   * journal fidèle des tentatives d'écriture, mais l'état "actuel" exposé
   * par statusOf() ne recule jamais.
   *
   * Durabilité : `appendFileSync` écrit dans le cache du système de
   * fichiers, pas sur le disque — sans `fsync`, rien ne garantit qu'une
   * ligne survit à un crash brutal de la machine (perte d'alimentation,
   * kill -9 du process avant que le noyau n'ait vidé son cache), même si
   * l'appel a déjà retourné. Le commentaire de handle() dans index.ts
   * ("réservation AVANT toute écriture : en cas de crash, on préfère perdre
   * une demande plutôt que de la traiter deux fois") est donc un peu
   * optimiste dans le pire cas : une ligne "claimed" peut elle-même ne
   * jamais atteindre le disque, auquel cas la demande n'est pas seulement
   * perdue mais rejouée depuis zéro au redémarrage (canProcess() la
   * retraite alors comme jamais vue) — la garantie réellement tenue est
   * "jamais de double traitement silencieux tant que le fichier a
   * effectivement été écrit", pas une garantie absolue de non-répétition.
   * Non corrigé ici (un fsync à chaque écriture aurait un coût réel sur le
   * chemin chaud de handle()) : ce commentaire documente l'écart entre ce
   * que le code garantit et ce qu'il énonce, sans le corriger.
   */
  record(
    key: string,
    todoId: number,
    status: RequestStatus,
    reason?: string,
  ): void {
    const entry: Entry = { key, todoId, status, at: new Date().toISOString(), reason };
    if (!this.apply(entry)) return;
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
    return [...this.latest.values()]
      .filter((entry) => entry.status !== "done" && entry.status !== "failed")
      .map((entry) => ({ key: entry.key, status: entry.status }));
  }
}
