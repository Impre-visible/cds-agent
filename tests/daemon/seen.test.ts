import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SeenTracker } from "../../src/daemon/seen.ts";

/** Horloge falsifiable : chaque test contrôle exactement le temps qui passe, sans vrai setTimeout. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("SeenTracker — §3.8, déduplication en mémoire distincte du store persistant", () => {
  test("un to-do jamais vu n'est pas considéré examiné", () => {
    const tracker = new SeenTracker(60_000);
    assert.equal(tracker.hasExamined(1), false);
  });

  test("markExamined rend le to-do 'déjà vu'", () => {
    const tracker = new SeenTracker(60_000);
    tracker.markExamined(42);
    assert.equal(tracker.hasExamined(42), true);
  });

  test("recordFailure incrémente et renvoie le compteur cumulé", () => {
    const tracker = new SeenTracker(60_000);
    assert.equal(tracker.recordFailure(7), 1);
    assert.equal(tracker.recordFailure(7), 2);
    assert.equal(tracker.recordFailure(7), 3);
  });

  test("markExamined efface le compteur de tentatives (succès après des échecs)", () => {
    const tracker = new SeenTracker(60_000);
    tracker.recordFailure(9);
    tracker.recordFailure(9);
    tracker.markExamined(9);
    // Un nouvel échec repart de 1, pas de 3 : la remise à zéro a bien eu lieu.
    assert.equal(tracker.recordFailure(9), 1);
  });

  test("l'état en mémoire ne croît plus indéfiniment : purge après maxAgeMs", () => {
    const clock = fakeClock();
    const tracker = new SeenTracker(10_000, clock.now);

    for (let id = 0; id < 500; id += 1) tracker.markExamined(id);
    assert.equal(tracker.size, 500);

    clock.advance(10_001);
    // La purge se déclenche à la prochaine lecture/écriture, sans minuteur dédié.
    assert.equal(tracker.hasExamined(0), false);
    assert.equal(tracker.size, 0);
  });

  test("un to-do encore actif (réessais récents) n'est pas purgé avant maxAgeMs", () => {
    const clock = fakeClock();
    const tracker = new SeenTracker(10_000, clock.now);

    tracker.recordFailure(1);
    clock.advance(9_000);
    tracker.recordFailure(1); // touche à nouveau, repousse l'échéance de purge

    clock.advance(9_000);
    // Déclenche la purge globale : 18s se sont écoulées depuis la 1ère
    // tentative, mais seulement 9s depuis la dernière activité sur id=1
    // (< maxAgeMs) — elle ne doit donc pas être effacée par cette purge.
    tracker.hasExamined(999);

    assert.equal(tracker.recordFailure(1), 3);
  });

  test("purge combinée : examen ET compteur de tentatives disparaissent ensemble", () => {
    const clock = fakeClock();
    const tracker = new SeenTracker(5_000, clock.now);

    tracker.recordFailure(3);
    tracker.recordFailure(3);
    clock.advance(5_001);

    assert.equal(tracker.hasExamined(3), false);
    // Un nouvel échec après purge doit repartir de 1, pas reprendre à 3.
    assert.equal(tracker.recordFailure(3), 1);
  });
});
