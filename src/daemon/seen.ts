/**
 * Cache en mémoire, propre à la durée de vie du process, qui évite de
 * réexaminer un to-do déjà vu pendant CE run (voir index.ts, poll()) et
 * compte les tentatives d'échec avant abandon (voir config.maxAttempts).
 *
 * Extrait d'index.ts pour être testable (voir seen.test.ts) — les deux
 * structures qu'il remplaçait (`examined: Set<number>` et
 * `attempts: Map<number, number>`) grandissaient sans borne pendant toute la
 * durée de vie du daemon (des mois, en usage réel) et ne garantissaient pas
 * la même chose que le store persistant :
 *
 * - RequestStore (store.ts) est la source de vérité pour la décision
 *   "peut-on traiter cette demande ?" (canProcess()) : persistante,
 *   indexée par request.key (dérivé de la note/description), elle survit à
 *   un redémarrage. C'est elle qui empêche un double traitement réel.
 * - SeenTracker est une pure optimisation locale, indexée par todo.id : elle
 *   évite de rappeler buildRequest()/authorize() (donc un aller-retour
 *   GitLab, getNote() notamment) sur un to-do déjà vu dans ce process. Sans
 *   elle, le pire qui arrive est un appel réseau superflu suivi d'un refus
 *   par canProcess() — jamais un double traitement. Elle n'a donc aucune
 *   raison de survivre à un redémarrage, contrairement au store.
 *
 * D'où la purge par âge : un to-do qu'on ne reverra plus jamais dans
 * collectTodos() — parce qu'il a été marqué done côté GitLab et qu'il est
 * sorti de la fenêtre de rattrapage des done récents (voir
 * config.lookbackMs) — peut être oublié sans risque, puisqu'il ne
 * réapparaîtra tout simplement plus. maxAgeMs doit donc être au moins
 * lookbackMs ; index.ts l'utilise directement.
 */
export class SeenTracker {
  private readonly examinedIds = new Set<number>();
  private readonly attemptCounts = new Map<number, number>();
  /** Horodatage de la dernière activité connue pour ce to-do (examen ou échec) — sert uniquement à la purge. */
  private readonly lastTouch = new Map<number, number>();

  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(maxAgeMs: number, now: () => number = Date.now) {
    this.maxAgeMs = maxAgeMs;
    this.now = now;
  }

  private touch(id: number): void {
    this.lastTouch.set(id, this.now());
  }

  /**
   * Purge tout to-do dont la dernière activité remonte à plus de maxAgeMs.
   * Appelée automatiquement à chaque lecture/écriture : pas besoin d'un
   * minuteur ni d'un appel explicite depuis index.ts.
   */
  private prune(): void {
    const cutoff = this.now() - this.maxAgeMs;
    for (const [id, at] of this.lastTouch) {
      if (at < cutoff) {
        this.lastTouch.delete(id);
        this.examinedIds.delete(id);
        this.attemptCounts.delete(id);
      }
    }
  }

  hasExamined(id: number): boolean {
    this.prune();
    return this.examinedIds.has(id);
  }

  /** Marque un to-do comme traité (avec succès, ignoré, refusé, ou abandonné) : n'est plus reproposé à poll(). */
  markExamined(id: number): void {
    this.examinedIds.add(id);
    this.attemptCounts.delete(id);
    this.touch(id);
  }

  /** Enregistre un échec et renvoie le nombre cumulé de tentatives pour ce to-do. */
  recordFailure(id: number): number {
    const count = (this.attemptCounts.get(id) ?? 0) + 1;
    this.attemptCounts.set(id, count);
    this.touch(id);
    return count;
  }

  /** Nombre d'identifiants actuellement suivis (examinés ou en cours de réessai), après purge — utile aux tests. */
  get size(): number {
    this.prune();
    return this.lastTouch.size;
  }
}
