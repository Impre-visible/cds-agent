import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ShutdownController, drain } from "../../src/daemon/shutdown.ts";
import { TaskQueue } from "../../src/daemon/queue.ts";

interface Item {
  key: string;
}

const keyOf = (item: Item) => item.key;

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ShutdownController", () => {
  test("running au départ : pas encore à l'arrêt", () => {
    const shutdown = new ShutdownController();
    assert.equal(shutdown.isStopping, false);
    assert.equal(shutdown.phaseName, "running");
  });

  test("premier signal : passe en 'draining', isStopping devient vrai", () => {
    const shutdown = new ShutdownController();
    const phase = shutdown.registerSignal();
    assert.equal(phase, "draining");
    assert.equal(shutdown.isStopping, true);
  });

  test("second signal : passe en 'forced' — c'est ce qui doit déclencher la sortie immédiate côté index.ts", () => {
    const shutdown = new ShutdownController();
    shutdown.registerSignal();
    const phase = shutdown.registerSignal();
    assert.equal(phase, "forced");
    assert.equal(shutdown.isStopping, true);
  });

  test("un troisième signal reste 'forced' (pas de régression d'état)", () => {
    const shutdown = new ShutdownController();
    shutdown.registerSignal();
    shutdown.registerSignal();
    assert.equal(shutdown.registerSignal(), "forced");
  });

  test("sleep() résout après le délai en l'absence de signal", async () => {
    const shutdown = new ShutdownController();
    const start = Date.now();
    await shutdown.sleep(20);
    assert.ok(Date.now() - start >= 15, "le délai doit être globalement respecté");
  });

  test("sleep() est réveillée immédiatement par un signal, sans attendre tout le délai — " +
    "c'est ce qui empêche un Ctrl-C de rester bloqué jusqu'à pollIntervalMs (jusqu'à 1h)", async () => {
    const shutdown = new ShutdownController();
    const start = Date.now();
    const sleeping = shutdown.sleep(10_000);
    await tick();
    shutdown.registerSignal();
    await sleeping;
    assert.ok(Date.now() - start < 1_000, "sleep() doit rendre la main bien avant le délai de 10s");
  });

  test("sleep() rend la main immédiatement si l'arrêt est déjà demandé", async () => {
    const shutdown = new ShutdownController();
    shutdown.registerSignal();
    const start = Date.now();
    await shutdown.sleep(10_000);
    assert.ok(Date.now() - start < 100);
  });
});

describe("drain() — séquence d'arrêt de la file (voir index.ts)", () => {
  test("attend la fin de la tâche en cours, dans la limite du délai", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const queue = new TaskQueue<Item>(async () => {
      await blocked;
      finished = true;
    }, keyOf);

    queue.push({ key: "en-cours" });
    await tick();

    const outcome = drain({ queue, gracePeriodMs: 1_000, onStranded: () => {} });
    release?.();

    assert.equal(await outcome, "clean");
    assert.equal(finished, true);
  });

  test("une fois l'arrêt demandé, aucune nouvelle tâche n'est acceptée : close() coupe court avant même waitForIdle()", async () => {
    const queue = new TaskQueue<Item>(async () => {}, keyOf);
    await drain({ queue, gracePeriodMs: 1_000, onStranded: () => {} });

    assert.throws(() => queue.push({ key: "trop-tard" }), /file fermée/);
  });

  test("le délai maximal est respecté : une tâche qui ne finit pas ne bloque pas l'arrêt indéfiniment", async () => {
    const neverEnds = new Promise<void>(() => {});
    const queue = new TaskQueue<Item>(async () => {
      await neverEnds;
    }, keyOf);

    queue.push({ key: "bloquée-pour-toujours" });
    await tick();

    const outcome = await drain({ queue, gracePeriodMs: 20, onStranded: () => {} });
    assert.equal(outcome, "timed-out");
  });

  test("les demandes encore en file (jamais démarrées) sont signalées explicitement à l'appelant — " +
    "c'est ce qui rend la perte visible plutôt que silencieuse (voir index.ts)", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new TaskQueue<Item>(async (item) => {
      if (item.key === "occupant") await blocked;
    }, keyOf);

    queue.push({ key: "occupant" });
    await tick();
    queue.push({ key: "jamais-démarrée-1" });
    queue.push({ key: "jamais-démarrée-2" });

    const stranded: Item[] = [];
    const outcome = drain({
      queue,
      gracePeriodMs: 1_000,
      onStranded: (items) => stranded.push(...items),
    });
    release?.();
    await outcome;

    assert.deepEqual(
      stranded.map((item) => item.key),
      ["jamais-démarrée-1", "jamais-démarrée-2"],
    );
  });
});
