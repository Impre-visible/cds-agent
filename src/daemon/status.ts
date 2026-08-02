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

/**
 * Ce qui se passe en ce moment, en une phrase, pour la ligne « rien de neuf »
 * du polling.
 *
 * Sans ça, un cycle de polling qui ne trouve pas de nouveau to-do affiche
 * « rien de neuf » toutes les 30 s — y compris pendant qu'une conversation
 * OpenHands travaille depuis dix minutes. C'est exact et parfaitement
 * trompeur : ça décrit ce que le POLLING a trouvé, et ça se lit comme « le
 * daemon ne fait rien ». Sur ce backend, l'attente est longue par nature (le
 * daemon sonde une conversation distante), donc c'est l'état le plus fréquent
 * qu'on affichait le moins bien.
 *
 * Rend "" quand il n'y a effectivement rien : la ligne reste courte dans le
 * cas où elle est vraie.
 *
 * Fonction pure, exportée pour être testée sans horloge réelle ni daemon
 * (voir status.test.ts) — `now` est injecté pour la même raison.
 */
export function describeActivity(
  task: RunningTask | undefined,
  queueDepth: number,
  now: number,
): string {
  const waiting = queueDepth > 0 ? `, ${queueDepth} en attente` : "";

  if (!task) {
    // Une file non vide sans tâche en cours est une fenêtre très courte
    // (entre deux `pump()`), mais la taire ferait mentir la ligne.
    return queueDepth > 0 ? `${queueDepth} demande(s) en attente.` : "";
  }

  // Secondes en dessous d'une minute : au démarrage d'une tâche, « 0 min »
  // se lit comme une erreur d'affichage. Au-delà, la minute suffit — personne
  // ne suit une revue à la seconde près.
  const elapsedMs = Math.max(0, now - task.since);
  const elapsed =
    elapsedMs < 60_000
      ? `${Math.round(elapsedMs / 1000)} s`
      : `${Math.round(elapsedMs / 60_000)} min`;

  return `${task.key} (${task.projectPath}!${task.iid}) en cours depuis ${elapsed}${waiting}.`;
}

/** Instance unique du process, comme `store`/`queue`/`seen` dans index.ts. */
export const daemonStatus = new DaemonStatus();
