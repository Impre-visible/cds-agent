export class TaskQueue<T> {
  private readonly waiting: T[] = [];
  private running = false;

  constructor(private readonly worker: (item: T) => Promise<void>) {}

  /** Nombre de tâches dans le système : celle en cours plus celles en attente. */
  get depth(): number {
    return this.waiting.length + (this.running ? 1 : 0);
  }

  /** Empile et renvoie la position de la tâche (1 = démarre maintenant). */
  push(item: T): number {
    this.waiting.push(item);
    const position = this.depth;
    void this.pump();
    return position;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const item = this.waiting.shift();
        if (item === undefined) break;
        try {
          await this.worker(item);
        } catch (error) {
          console.error(`  [worker] tâche en échec : ${(error as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
