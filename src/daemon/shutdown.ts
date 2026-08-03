export type ShutdownPhase = "running" | "draining" | "forced";

/**
 * Coordonne l'arrêt gracieux du daemon, extrait d'index.ts pour être
 * testable : index.ts démarre sa boucle au chargement du module (`void
 * main()`), ce qui interdit de l'exercer directement depuis un test. Cette
 * classe ne dépend que d'un minuteur — aucune E/S, aucun process réel —, ce
 * qui permet de prouver par un test les deux comportements attendus d'un
 * signal : refus des nouvelles tâches dès le premier, sortie immédiate dès
 * le second (quelqu'un qui tape Ctrl-C deux fois veut que ça s'arrête
 * maintenant).
 */
export class ShutdownController {
  private phase: ShutdownPhase = "running";
  private wake: (() => void) | undefined;

  get phaseName(): ShutdownPhase {
    return this.phase;
  }

  /** true dès le premier signal : plus aucune nouvelle tâche ne doit démarrer. */
  get isStopping(): boolean {
    return this.phase !== "running";
  }

  /**
   * Demande un arrêt gracieux sans signal — utilisé quand le daemon a fini le
   * travail qu'on lui avait donné (CDS_MAX_TASKS, voir daemon/index.ts).
   *
   * Passe par la MÊME phase "draining" qu'un SIGINT plutôt que par un
   * `process.exit()` : la file est drainée, ce qui n'a jamais démarré est
   * consigné comme perdu, le serveur d'observabilité est fermé et le verrou
   * libéré. Un banc de mesure qui laisserait des verrous ou des demandes
   * dans un état ambigu derrière lui ne serait pas un banc de mesure.
   *
   * Sans effet si un arrêt est déjà en cours : un signal reçu au même moment
   * ne doit pas être « rétrogradé ».
   */
  requestStop(): void {
    if (this.phase !== "running") return;
    this.phase = "draining";
    this.wake?.();
  }

  /**
   * Enregistre un signal (SIGINT/SIGTERM). Renvoie la phase résultante :
   * "draining" au premier appel (on laisse une chance à la tâche en cours de
   * se terminer), "forced" à partir du second — à charge pour l'appelant de
   * sortir immédiatement sans plus attendre.
   */
  registerSignal(): ShutdownPhase {
    this.phase = this.phase === "running" ? "draining" : "forced";
    this.wake?.();
    return this.phase;
  }

  /**
   * Attente interruptible : résout après `ms`, ou immédiatement si un signal
   * arrive entre-temps (via registerSignal ci-dessus). Remplace le
   * `setTimeout` brut de la boucle de polling dans index.ts, qui ignorait
   * tout signal jusqu'à l'écoulement complet de pollIntervalMs — jusqu'à 1 h
   * avec les bornes définies dans config.ts.
   */
  sleep(ms: number): Promise<void> {
    if (this.isStopping) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}

/** Ce qu'une file doit savoir faire pour être drainée à l'arrêt (voir drain() ci-dessous). */
export interface DrainableQueue<T> {
  close(): T[];
  waitForIdle(timeoutMs: number): Promise<boolean>;
}

export interface DrainOptions<T> {
  queue: DrainableQueue<T>;
  /** Délai maximal accordé à la tâche en cours pour se terminer, en ms. */
  gracePeriodMs: number;
  /**
   * Appelé avec les demandes encore en attente (jamais démarrées) au moment
   * de l'arrêt : c'est le point d'extension par lequel index.ts rend leur
   * perte explicite dans le store, plutôt que de les laisser à "acked" pour
   * toujours (voir le commentaire dans index.ts pour le raisonnement complet
   * — en résumé, le to-do GitLab correspondant est déjà marqué "done" à ce
   * stade, donc rien ne les rejouera jamais tout seul).
   */
  onStranded: (items: T[]) => void;
}

/**
 * Séquence de drain à l'arrêt, indépendante d'index.ts pour être testable
 * sans process ni signal réel : ferme la file (plus aucun push() n'est
 * accepté ensuite, voir queue.ts), signale ce qui n'avait pas démarré, puis
 * attend au plus gracePeriodMs que la tâche en cours (s'il y en a une) se
 * termine. "timed-out" indique que la tâche en cours continue en tâche de
 * fond au-delà du délai — c'est l'appelant qui décide alors du code de
 * sortie et du nettoyage best-effort des ressources qu'elle a pu laisser
 * ouvertes (conteneur Docker, répertoire temporaire).
 */
export async function drain<T>(options: DrainOptions<T>): Promise<"clean" | "timed-out"> {
  const stranded = options.queue.close();
  if (stranded.length > 0) options.onStranded(stranded);

  const idle = await options.queue.waitForIdle(options.gracePeriodMs);
  return idle ? "clean" : "timed-out";
}
