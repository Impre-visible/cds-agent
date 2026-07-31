import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TaskQueue } from "./queue.ts";

interface Item {
  key: string;
}

const keyOf = (item: Item) => item.key;

/** Laisse tourner la boucle d'événements pour que la file se vide. */
function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("TaskQueue", () => {
  test("exécute les tâches dans l'ordre, une à la fois", async () => {
    const seen: string[] = [];
    const queue = new TaskQueue<Item>(async (item) => {
      seen.push(`début ${item.key}`);
      await drain();
      seen.push(`fin ${item.key}`);
    }, keyOf);

    queue.push({ key: "a" });
    queue.push({ key: "b" });
    await drain();
    await drain();
    await drain();

    assert.deepEqual(seen, ["début a", "fin a", "début b", "fin b"]);
  });

  test("une tâche en échec n'interrompt pas les suivantes", async () => {
    const seen: string[] = [];
    const queue = new TaskQueue<Item>(async (item) => {
      if (item.key === "a") throw new Error("boum");
      seen.push(item.key);
    }, keyOf);

    queue.push({ key: "a" });
    queue.push({ key: "b" });
    await drain();
    await drain();

    assert.deepEqual(seen, ["b"]);
  });

  test("réempiler une clé déjà en attente ne l'exécute pas deux fois", async () => {
    // Le scénario qui motive la déduplication : le store autorise le rejeu
    // d'une demande restée à « claimed » (accusé de réception en échec).
    // handle() rappelle donc push() avec la même demande alors qu'elle est
    // encore en file derrière une autre — le worker n'a pas encore écrit
    // « running », le store ne peut pas s'y opposer. Sans déduplication ici,
    // la tâche part deux fois : deux revues publiées, ou du code poussé deux
    // fois sur la branche source.
    const executed: string[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const queue = new TaskQueue<Item>(async (item) => {
      executed.push(item.key);
      if (item.key === "occupant") await blocked;
    }, keyOf);

    // Une tâche occupe la file : celles qui suivent restent en attente.
    queue.push({ key: "occupant" });
    await drain();

    const first = queue.push({ key: "demande" });
    const replay = queue.push({ key: "demande" });

    assert.equal(first, 2, "derrière l'occupant");
    assert.equal(replay, 2, "le rejeu renvoie la position existante");

    release?.();
    await drain();
    await drain();
    await drain();

    assert.deepEqual(executed, ["occupant", "demande"]);
  });

  test("la même clé peut être réempilée une fois la tâche terminée", async () => {
    // La déduplication ne porte que sur les tâches en attente : une fois la
    // tâche sortie de la file, c'est le statut du store qui décide s'il faut
    // rejouer ou non. La file ne doit pas garder de mémoire au-delà.
    const executed: string[] = [];
    const queue = new TaskQueue<Item>(async (item) => {
      executed.push(item.key);
    }, keyOf);

    queue.push({ key: "demande" });
    await drain();
    await drain();
    queue.push({ key: "demande" });
    await drain();
    await drain();

    assert.deepEqual(executed, ["demande", "demande"]);
  });
});
