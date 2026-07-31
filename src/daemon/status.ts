/**
 * §6.5 : état d'exploitation partagé en lecture par le serveur
 * d'observabilité (health.ts) — alimenté uniquement par daemon/index.ts, seul
 * point du code à connaître le déroulé réel du polling et du worker. Ne
 * participe à aucune décision métier : une régression ici peut fausser
 * /healthz ou /metrics, jamais le traitement effectif des demandes.
 *
 * Volontairement une classe avec état mutable, pas un module de fonctions
 * sur variables de module (comme index.ts le fait déjà pour `bot`) : le
 * besoin d'une instance injectable par les tests (voir health.test.ts, qui
 * construit ses propres dépendances) l'emporte ici sur la cohérence de style
 * avec le reste du fichier daemon/index.ts.
 */
export interface RunningTask {
  key: string;
  projectPath: string;
  iid: number;
  /** Date.now() au moment où le worker a démarré cette tâche. */
  since: number;
}

export interface Counters {
  processed: number;
  refused: number;
  abandoned: number;
}

export class DaemonStatus {
  private readonly startedAt: number;
  private task: RunningTask | undefined;
  private lastPollSuccessAt: number | undefined;
  private readonly counters: Counters = {
    processed: 0,
    refused: 0,
    abandoned: 0,
  };

  constructor(now: () => number = Date.now) {
    this.startedAt = now();
  }

  getStartedAt(): number {
    return this.startedAt;
  }

  /** Appelé par trackedWorker() juste avant de lancer runTask() (voir index.ts). */
  taskStarted(task: RunningTask): void {
    this.task = task;
  }

  /** Appelé dans le `finally` de trackedWorker() : la tâche se termine, quelle qu'en soit l'issue. */
  taskEnded(): void {
    this.task = undefined;
  }

  getCurrentTask(): RunningTask | undefined {
    return this.task;
  }

  /** Appelé par la boucle principale après un cycle de poll() qui n'a pas levé. */
  pollSucceeded(at: number): void {
    this.lastPollSuccessAt = at;
  }

  getLastPollSuccessAt(): number | undefined {
    return this.lastPollSuccessAt;
  }

  recordProcessed(): void {
    this.counters.processed += 1;
  }

  recordRefused(): void {
    this.counters.refused += 1;
  }

  recordAbandoned(): void {
    this.counters.abandoned += 1;
  }

  /** Copie défensive : l'appelant (health.ts) ne doit pas pouvoir muter l'état interne. */
  getCounters(): Counters {
    return { ...this.counters };
  }
}

/** Instance unique du process, comme `store`/`queue`/`seen` dans index.ts. */
export const daemonStatus = new DaemonStatus();
