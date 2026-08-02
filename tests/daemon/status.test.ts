import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DaemonStatus, describeActivity } from "../../src/daemon/status.ts";

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

describe("describeActivity — ce que dit la ligne « rien de neuf »", () => {
  const task = { key: "note:42", projectPath: "grp/repo", iid: 5, since: 1_000_000 };

  test("rien en cours, file vide : chaîne vide — la ligne reste courte quand elle est vraie", () => {
    assert.equal(describeActivity(undefined, 0, 1_000_000), "");
  });

  test("une tâche en cours est nommée, avec son ancienneté", () => {
    // Le cas qui motive cette fonction : « rien de neuf » toutes les 30 s
    // pendant qu'une conversation travaille depuis dix minutes est exact et
    // parfaitement trompeur.
    const line = describeActivity(task, 0, 1_000_000 + 10 * 60_000);
    assert.match(line, /note:42/);
    assert.match(line, /grp\/repo!5/);
    assert.match(line, /10 min/);
  });

  test("sous la minute, l'ancienneté est en secondes — « 0 min » se lirait comme un bug", () => {
    assert.match(describeActivity(task, 0, 1_000_000 + 12_000), /12 s/);
    assert.match(describeActivity(task, 0, 1_000_000 + 59_000), /59 s/);
    assert.match(describeActivity(task, 0, 1_000_000 + 60_000), /1 min/);
  });

  test("une horloge qui recule ne produit pas une ancienneté négative", () => {
    assert.match(describeActivity(task, 0, 1_000_000 - 5_000), /0 s/);
  });

  test("la file en attente est comptée à côté de la tâche en cours", () => {
    assert.match(describeActivity(task, 3, 1_000_000), /3 en attente/);
  });

  test("file non vide sans tâche en cours : la fenêtre est courte, mais la taire ferait mentir la ligne", () => {
    assert.equal(describeActivity(undefined, 2, 1_000_000), "2 demande(s) en attente.");
  });
});
