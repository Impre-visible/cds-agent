import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { collectTodos } from "../../src/daemon/todos.ts";
import type { Todo } from "../../src/types.ts";

const LOOKBACK_MS = 10 * 60 * 1000; // 10 minutes, comme la valeur par défaut de config.ts

function makeTodo(
  id: number,
  state: "pending" | "done",
  createdAgoMs: number,
  updatedAgoMs: number,
): Todo {
  const now = Date.now();
  return {
    id,
    action_name: "mentioned",
    target_type: "Issue",
    target: { id, iid: id, project_id: 1 },
    target_url: `https://gitlab.example/grp/repo/-/issues/${id}#note_${id}`,
    body: "@test-bot fais un truc",
    state,
    created_at: new Date(now - createdAgoMs).toISOString(),
    updated_at: new Date(now - updatedAgoMs).toISOString(),
    author: { id: 1, username: "alice", name: "Alice" },
    project: { id: 1, path_with_namespace: "grp/repo" },
  };
}

describe("collectTodos — fenêtre de rattrapage des to-dos done récents", () => {
  test("un to-do créé bien avant la fenêtre mais passé à done à l'instant est rattrapé", async () => {
    // Créé il y a 3h (bien en dehors des 10 min de fenêtre), mais résolu
    // (updated_at) il y a 10s seulement : c'est exactement le scénario que
    // la fenêtre de rattrapage doit couvrir.
    const todo = makeTodo(1, "done", 3 * 60 * 60 * 1000, 10_000);

    const result = await collectTodos({
      pendingTodos: async () => [],
      doneTodos: async () => [todo],
      lookbackMs: LOOKBACK_MS,
    });

    assert.deepEqual(result.map((t) => t.id), [1]);
  });

  test("un to-do résolu il y a longtemps n'est plus rattrapé", async () => {
    // Créé et résolu il y a 3h : en dehors de la fenêtre des deux points de
    // vue, ne doit pas être rattrapé.
    const todo = makeTodo(2, "done", 3 * 60 * 60 * 1000, 3 * 60 * 60 * 1000);

    const result = await collectTodos({
      pendingTodos: async () => [],
      doneTodos: async () => [todo],
      lookbackMs: LOOKBACK_MS,
    });

    assert.deepEqual(result, []);
  });

  test("régression : filtrer sur created_at aurait exclu à tort le to-do rattrapable", async () => {
    // Reproduit le bug corrigé : si le filtre portait sur created_at (comme
    // avant), ce to-do (créé il y a 3h) serait exclu malgré une résolution
    // toute récente. On vérifie ici que ce n'est plus le cas.
    const todo = makeTodo(3, "done", 3 * 60 * 60 * 1000, 1_000);
    const wouldBeExcludedByCreatedAt =
      Date.parse(todo.created_at) < Date.now() - LOOKBACK_MS;
    assert.equal(wouldBeExcludedByCreatedAt, true, "le scénario doit bien être hors fenêtre par created_at");

    const result = await collectTodos({
      pendingTodos: async () => [],
      doneTodos: async () => [todo],
      lookbackMs: LOOKBACK_MS,
    });

    assert.deepEqual(result.map((t) => t.id), [3]);
  });

  test("les to-dos pending sont toujours inclus, indépendamment de la fenêtre", async () => {
    const pending = makeTodo(4, "pending", 5 * 24 * 60 * 60 * 1000, 5 * 24 * 60 * 60 * 1000);

    const result = await collectTodos({
      pendingTodos: async () => [pending],
      doneTodos: async () => [],
      lookbackMs: LOOKBACK_MS,
    });

    assert.deepEqual(result.map((t) => t.id), [4]);
  });

  test("dédoublonne par id (un to-do pending ET dans les done récents ne compte qu'une fois)", async () => {
    const todo = makeTodo(5, "done", 1_000, 1_000);

    const result = await collectTodos({
      pendingTodos: async () => [todo],
      doneTodos: async () => [todo],
      lookbackMs: LOOKBACK_MS,
    });

    assert.equal(result.length, 1);
  });

  test("le tri reste FIFO par created_at, pas par updated_at ni ordre de découverte", async () => {
    // to-do A : créé le premier mais résolu (updated_at) le plus récemment.
    // to-do B : créé après A mais résolu bien avant lui.
    // Le tri doit suivre created_at (A avant B), pas updated_at (qui donnerait B avant A).
    const a = makeTodo(10, "done", 60_000, 1_000);
    const b = makeTodo(20, "pending", 30_000, 30_000);

    const result = await collectTodos({
      pendingTodos: async () => [b],
      doneTodos: async () => [a],
      lookbackMs: LOOKBACK_MS,
    });

    assert.deepEqual(result.map((t) => t.id), [10, 20]);
  });
});
