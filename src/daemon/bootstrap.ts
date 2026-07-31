import type { Todo } from "../types.ts";

/**
 * Amorçage au tout premier démarrage (§3.7) : sans lui, un fichier d'état
 * vide (machine neuve, ou state/processed.jsonl effacé) fait que le premier
 * poll() récupère TOUS les to-dos en attente du compte — y compris ceux
 * d'il y a six mois — et poste un accusé de réception sur chacun, comme
 * s'ils venaient d'arriver.
 *
 * On considère donc tout ce qui existe déjà à l'instant précis du démarrage
 * comme "vu" :
 * - les to-dos encore "pending" sont clos sans notification, via `finishTodo`
 *   (même chemin que pour un to-do ignoré ou refusé dans handle() —
 *   rien de nouveau ici) ;
 * - tous (pending et done récents) sont marqués examinés via `markExamined`,
 *   pour qu'aucun ne soit reproposé au tout premier poll() qui suivra.
 *
 * Ne s'applique qu'au tout premier lancement : `main()` n'appelle cette
 * fonction que si `store.isEmpty()` (voir store.ts). Un redémarrage normal —
 * store déjà peuplé — ne passe jamais par ici : poll()/handle() tournent
 * alors normalement dès le premier cycle, et une demande arrivée pendant
 * l'arrêt est bien traitée (rejeu géré par canProcess(), voir store.ts).
 *
 * Dépendances injectées plutôt qu'importées en dur (gitlab, config...) pour
 * rester testable sans réseau ni token GitLab valide — voir bootstrap.test.ts.
 * Notez qu'`acknowledge`/`createNote` n'apparaissent nulle part dans ces
 * dépendances : il est donc structurellement impossible que cette fonction
 * poste un accusé de réception, quoi qu'elle fasse par ailleurs.
 */
export interface BootstrapDeps {
  collectTodos: () => Promise<Todo[]>;
  finishTodo: (todoId: number) => Promise<void>;
  markExamined: (todoId: number) => void;
  log: (message: string) => void;
}

export async function bootstrapIfFresh(
  isFreshStore: boolean,
  deps: BootstrapDeps,
): Promise<void> {
  if (!isFreshStore) return;

  const todos = await deps.collectTodos();
  if (todos.length === 0) return;

  deps.log(
    `Premier démarrage (état vide) : ${todos.length} to-do(s) préexistant(s), marqué(s) vu(s) sans accusé de réception.`,
  );

  for (const todo of todos) {
    deps.markExamined(todo.id);
    // "done" (fenêtre de rattrapage de collectTodos()) : déjà clos côté
    // GitLab, rien à faire d'autre — il sortira de lui-même de cette
    // fenêtre (voir config.lookbackMs) et ne réapparaîtra plus.
    if (todo.state !== "done") {
      await deps.finishTodo(todo.id);
    }
  }
}
