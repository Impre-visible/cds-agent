import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bootstrapIfFresh } from "../../src/daemon/bootstrap.ts";
import type { Todo } from "../../src/types.ts";

function makeTodo(id: number, state: "pending" | "done"): Todo {
  return {
    id,
    action_name: "mentioned",
    target_type: "Issue",
    target: { id, iid: id, project_id: 1 },
    target_url: `https://gitlab.example/grp/repo/-/issues/${id}#note_${id}`,
    body: "@test-bot fais un truc",
    state,
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01T00:00:00.000Z",
    author: { id: 1, username: "alice", name: "Alice" },
    project: { id: 1, path_with_namespace: "grp/repo" },
  };
}

describe("bootstrapIfFresh — §3.7, amorçage au premier démarrage", () => {
  test("redémarrage normal (store non vide) : ne touche à rien, poll()/handle() gèrent le rattrapage eux-mêmes", async () => {
    let collectCalled = false;
    await bootstrapIfFresh(false, {
      collectTodos: async () => {
        collectCalled = true;
        return [makeTodo(1, "pending")];
      },
      finishTodo: async () => {
        throw new Error("ne doit jamais être appelé");
      },
      markExamined: () => {
        throw new Error("ne doit jamais être appelé");
      },
      log: () => {
        throw new Error("ne doit jamais être appelé");
      },
    });
    assert.equal(collectCalled, false, "collectTodos ne doit même pas être interrogé hors premier démarrage");
  });

  test("premier démarrage, store vide, aucun to-do préexistant : silence total", async () => {
    let finishCalls = 0;
    let logCalls = 0;
    await bootstrapIfFresh(true, {
      collectTodos: async () => [],
      finishTodo: async () => {
        finishCalls += 1;
      },
      markExamined: () => {},
      log: () => {
        logCalls += 1;
      },
    });
    assert.equal(finishCalls, 0);
    assert.equal(logCalls, 0);
  });

  test("premier démarrage : les vieux to-dos pending sont clos SANS accusé de réception, et marqués examinés", async () => {
    const finished: number[] = [];
    const examined: number[] = [];
    let logged = "";

    await bootstrapIfFresh(true, {
      collectTodos: async () => [makeTodo(101, "pending"), makeTodo(102, "pending")],
      finishTodo: async (todoId) => {
        finished.push(todoId);
      },
      markExamined: (todoId) => {
        examined.push(todoId);
      },
      log: (message) => {
        logged = message;
      },
    });

    // finishTodo() est le seul canal de clôture utilisé ici : aucune
    // dépendance "acknowledge"/"createNote" n'existe dans BootstrapDeps, il
    // est donc structurellement impossible qu'un accusé de réception parte.
    assert.deepEqual(finished, [101, 102]);
    assert.deepEqual(examined, [101, 102]);
    assert.match(logged, /2 to-do\(s\) préexistant/);
  });

  test("premier démarrage : les to-dos déjà 'done' (fenêtre de rattrapage) sont marqués examinés mais PAS reclos", async () => {
    const finished: number[] = [];
    const examined: number[] = [];

    await bootstrapIfFresh(true, {
      collectTodos: async () => [makeTodo(201, "done")],
      finishTodo: async (todoId) => {
        finished.push(todoId);
      },
      markExamined: (todoId) => {
        examined.push(todoId);
      },
      log: () => {},
    });

    assert.deepEqual(finished, [], "un to-do déjà done ne doit pas redéclencher finishTodo()");
    assert.deepEqual(examined, [201]);
  });

  test("premier démarrage : mélange pending/done, chacun traité selon son état", async () => {
    const finished: number[] = [];
    const examined: number[] = [];

    await bootstrapIfFresh(true, {
      collectTodos: async () => [
        makeTodo(301, "pending"),
        makeTodo(302, "done"),
        makeTodo(303, "pending"),
      ],
      finishTodo: async (todoId) => {
        finished.push(todoId);
      },
      markExamined: (todoId) => {
        examined.push(todoId);
      },
      log: () => {},
    });

    assert.deepEqual(finished, [301, 303]);
    assert.deepEqual(examined, [301, 302, 303]);
  });
});
