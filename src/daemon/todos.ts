import type { Todo } from "../types.ts";

/**
 * Dépendances injectées (plutôt que `gitlab`/`config` importés en dur) pour
 * rester testable sans réseau ni token GitLab valide — même motif que
 * bootstrap.ts (voir todos.test.ts). `lookbackMs` vient de config.lookbackMs
 * côté appelant (daemon/index.ts).
 */
export interface CollectTodosDeps {
  pendingTodos: () => Promise<Todo[]>;
  doneTodos: () => Promise<Todo[]>;
  lookbackMs: number;
}

/**
 * Rassemble les to-dos à examiner : tous les `pending`, plus les `done`
 * récents (fenêtre de rattrapage, §3.5/ADR 0001).
 *
 * Un to-do peut avoir été auto-résolu par une écriture du bot avant qu'on
 * l'ait lu comme `pending` — on rattrape donc les « done » récents. Le
 * filtre porte sur `updated_at`, pas `created_at` : c'est `updated_at` qui
 * reflète le moment où le to-do a effectivement basculé pending → done
 * (GitLab n'expose pas de `completed_at` séparé, voir le commentaire sur
 * `Todo.updated_at` dans types.ts et docs/adr/0001-polling-plutot-que-webhook.md).
 * Filtrer sur `created_at` ici ferait l'inverse de ce que cette fenêtre est
 * censée faire : un to-do créé il y a longtemps mais résolu à l'instant
 * serait exclu, alors qu'un to-do créé ET résolu dans la fenêtre — déjà vu
 * comme `pending` avant sa résolution dans l'immense majorité des cas — n'a
 * pas besoin de ce rattrapage.
 */
export async function collectTodos(deps: CollectTodosDeps): Promise<Todo[]> {
  const [pending, done] = await Promise.all([
    deps.pendingTodos(),
    deps.doneTodos(),
  ]);

  const cutoff = Date.now() - deps.lookbackMs;
  const recentDone = done.filter(
    (todo) => Date.parse(todo.updated_at) >= cutoff,
  );

  const byId = new Map<number, Todo>();
  for (const todo of [...pending, ...recentDone]) byId.set(todo.id, todo);

  // FIFO par date de création de la demande, pas par ordre de découverte ni
  // par date de résolution : l'ordre de traitement doit suivre l'ordre
  // d'arrivée de la demande, pas celui — indépendant — de sa clôture.
  return [...byId.values()].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}
