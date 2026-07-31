export class TaskQueue<T> {
  private readonly waiting: T[] = [];
  /** Clés des tâches en attente, pour rendre push() idempotent (voir plus bas). */
  private readonly waitingKeys = new Set<string>();
  private running = false;

  // Champs déclarés explicitement plutôt qu'en propriétés de paramètres :
  // le type stripping natif de Node refuse la syntaxe raccourcie.
  private readonly worker: (item: T) => Promise<void>;
  private readonly keyOf: (item: T) => string;

  constructor(worker: (item: T) => Promise<void>, keyOf: (item: T) => string) {
    this.worker = worker;
    this.keyOf = keyOf;
  }

  /** Nombre de tâches dans le système : celle en cours plus celles en attente. */
  get depth(): number {
    return this.waiting.length + (this.running ? 1 : 0);
  }

  /**
   * Empile et renvoie la position de la tâche (1 = démarre maintenant).
   *
   * Une clé déjà en attente n'est pas réempilée : on renvoie sa position
   * actuelle. C'est indispensable depuis que le store autorise le rejeu d'une
   * demande restée à « claimed » — typiquement quand l'accusé de réception a
   * échoué. Sans ça, le rejeu repasse par handle() qui rappelle push(), et la
   * tâche est exécutée deux fois : deux revues publiées, ou pire, du code
   * poussé deux fois. Le store ne peut pas l'empêcher seul, puisque le worker
   * n'écrit « running » qu'au moment où il démarre réellement — une tâche
   * encore en file derrière une autre est toujours à « claimed ».
   */
  push(item: T): number {
    const key = this.keyOf(item);
    const queued = this.waiting.findIndex(
      (pending) => this.keyOf(pending) === key,
    );
    if (queued !== -1) return queued + 1 + (this.running ? 1 : 0);

    this.waiting.push(item);
    this.waitingKeys.add(key);
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
        // Retiré des clés en attente au moment exact où la tâche démarre : le
        // relais est pris par le statut « running » que le worker écrit dans
        // le store avant son premier await, sans fenêtre entre les deux.
        this.waitingKeys.delete(this.keyOf(item));
        try {
          await this.worker(item);
        } catch (error) {
          console.error(
            `  [worker] tâche en échec : ${(error as Error).message}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
