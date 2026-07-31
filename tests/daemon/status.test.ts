import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DaemonStatus } from "../../src/daemon/status.ts";

describe("DaemonStatus — §6.5", () => {
  test("aucune tâche en cours au départ, aucun polling encore réussi", () => {
    const status = new DaemonStatus(() => 1_000);
    assert.equal(status.getStartedAt(), 1_000);
    assert.equal(status.getCurrentTask(), undefined);
    assert.equal(status.getLastPollSuccessAt(), undefined);
    assert.deepEqual(status.getCounters(), {
      processed: 0,
      refused: 0,
      abandoned: 0,
    });
  });

  test("taskStarted puis taskEnded efface la tâche en cours", () => {
    const status = new DaemonStatus();
    status.taskStarted({ key: "k", projectPath: "p", iid: 1, since: Date.now() });
    assert.deepEqual(status.getCurrentTask(), {
      key: "k",
      projectPath: "p",
      iid: 1,
      since: status.getCurrentTask()!.since,
    });
    status.taskEnded();
    assert.equal(status.getCurrentTask(), undefined);
  });

  test("une nouvelle tâche remplace la précédente sans qu'un taskEnded intermédiaire soit nécessaire", () => {
    const status = new DaemonStatus();
    status.taskStarted({ key: "a", projectPath: "p", iid: 1, since: 1 });
    status.taskStarted({ key: "b", projectPath: "p", iid: 2, since: 2 });
    assert.equal(status.getCurrentTask()?.key, "b");
  });

  test("les compteurs s'incrémentent indépendamment les uns des autres", () => {
    const status = new DaemonStatus();
    status.recordProcessed();
    status.recordProcessed();
    status.recordRefused();
    status.recordAbandoned();
    status.recordAbandoned();
    status.recordAbandoned();
    assert.deepEqual(status.getCounters(), {
      processed: 2,
      refused: 1,
      abandoned: 3,
    });
  });

  test("getCounters() renvoie une copie : la muter ne touche pas l'état interne", () => {
    const status = new DaemonStatus();
    status.recordProcessed();
    const counters = status.getCounters();
    counters.processed = 999;
    assert.equal(status.getCounters().processed, 1);
  });

  test("pollSucceeded mémorise l'horodatage fourni par l'appelant", () => {
    const status = new DaemonStatus();
    status.pollSucceeded(12_345);
    assert.equal(status.getLastPollSuccessAt(), 12_345);
    status.pollSucceeded(99_999);
    assert.equal(status.getLastPollSuccessAt(), 99_999);
  });
});
