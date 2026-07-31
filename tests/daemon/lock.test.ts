import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { InstanceLock, isProcessAlive } from "../../src/daemon/lock.ts";

let root: string;
let deadPid: number;

before(() => {
  root = mkdtempSync(join(tmpdir(), "cds-agent-lock-test-"));
  // PID garanti mort : un sous-processus qui vient de sortir. Un vrai PID
  // ayant existé, pas un nombre inventé au hasard qui n'aurait jamais été
  // attribué — la même situation qu'un daemon précédent qui a crashé.
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (child.pid === undefined) throw new Error("échec du spawn de préparation du test");
  deadPid = child.pid;
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

let counter = 0;
function freshPath(): string {
  counter += 1;
  return join(root, `daemon-${counter}.lock`);
}

describe("isProcessAlive", () => {
  test("le process courant est vivant", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  test("un PID de processus déjà sorti est mort", () => {
    assert.equal(isProcessAlive(deadPid), false);
  });
});

describe("InstanceLock — §3.9, verrou d'instance unique", () => {
  test("acquire() réussit sur un chemin neuf et écrit le PID courant", () => {
    const path = freshPath();
    const lock = new InstanceLock(path);
    const result = lock.acquire();
    assert.deepEqual(result, { acquired: true });
    assert.equal(existsSync(path), true);
  });

  test("un second démarrage alors qu'un verrou VIVANT existe : refus", () => {
    const path = freshPath();
    const first = new InstanceLock(path, process.pid);
    assert.deepEqual(first.acquire(), { acquired: true });

    const second = new InstanceLock(path, process.pid + 1);
    const result = second.acquire();
    assert.equal(result.acquired, false);
    if (!result.acquired) assert.equal(result.heldByPid, process.pid);
  });

  test("verrou périmé (PID mort) : démarrage accepté sans nettoyage manuel", () => {
    const path = freshPath();
    writeFileSync(path, String(deadPid), "utf8");

    const lock = new InstanceLock(path, process.pid);
    const result = lock.acquire();
    assert.deepEqual(result, { acquired: true });
  });

  test("fichier de verrou illisible (contenu non numérique) : traité comme périmé", () => {
    const path = freshPath();
    writeFileSync(path, "n'importe quoi", "utf8");

    const lock = new InstanceLock(path, process.pid);
    assert.deepEqual(lock.acquire(), { acquired: true });
  });

  test("release() supprime le verrou qu'on a soi-même posé", () => {
    const path = freshPath();
    const lock = new InstanceLock(path, process.pid);
    lock.acquire();
    lock.release();
    assert.equal(existsSync(path), false);
  });

  test("release() est sans effet si acquire() n'a jamais réussi (verrou tenu par un autre)", () => {
    const path = freshPath();
    const first = new InstanceLock(path, process.pid);
    first.acquire();

    const second = new InstanceLock(path, process.pid + 1);
    second.acquire(); // refusé
    second.release(); // ne doit pas supprimer le verrou du premier

    assert.equal(existsSync(path), true);
  });

  test("après reprise d'un verrou périmé, un nouveau concurrent est bien refusé", () => {
    const path = freshPath();
    writeFileSync(path, String(deadPid), "utf8");

    const reclaimer = new InstanceLock(path, process.pid);
    assert.deepEqual(reclaimer.acquire(), { acquired: true });

    const concurrent = new InstanceLock(path, process.pid + 1);
    const result = concurrent.acquire();
    assert.equal(result.acquired, false);
  });
});
