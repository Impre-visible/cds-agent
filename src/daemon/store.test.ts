import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestStore, canProcess } from "./store.ts";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "cds-agent-store-test-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

let counter = 0;
/** Un fichier d'état frais par test, pour ne pas se marcher dessus. */
function freshPath(): string {
  counter += 1;
  return join(root, `processed-${counter}.jsonl`);
}

describe("canProcess", () => {
  test("jamais vu (undefined) : rejouable", () => {
    assert.equal(canProcess(undefined), true);
  });

  test("claimed : rejouable (rien d'irréversible n'a eu lieu)", () => {
    assert.equal(canProcess("claimed"), true);
  });

  test("acked : rejouable (au pire un accusé de réception posté deux fois)", () => {
    assert.equal(canProcess("acked"), true);
  });

  test("running : PAS rejouable (le worker a pu commencer à pousser du code)", () => {
    assert.equal(canProcess("running"), false);
  });

  test("done : terminal, jamais rejouable", () => {
    assert.equal(canProcess("done"), false);
  });

  test("failed : terminal, jamais rejouable", () => {
    assert.equal(canProcess("failed"), false);
  });
});

describe("RequestStore — scénario motivant le correctif", () => {
  test("l'échec de l'accusé de réception laisse la demande rejouable au tour suivant", () => {
    const store = new RequestStore(freshPath());

    // Reproduit exactement la séquence de handle() jusqu'à l'échec :
    // réservation posée, puis acknowledge() qui jette avant que "acked" ne
    // soit jamais écrit.
    store.record("note:1", 111, "claimed");

    // Au tour suivant, poll() relit le statut avant de décider.
    const status = store.statusOf("note:1");
    assert.equal(status, "claimed");
    assert.equal(
      canProcess(status),
      true,
      "une demande 'claimed' orpheline doit rester rejouable, sinon le " +
        "compteur de tentatives ne réessaie jamais rien",
    );
  });

  test("un second passage peut mener 'claimed' jusqu'à 'acked' puis 'done'", () => {
    const store = new RequestStore(freshPath());
    store.record("note:2", 222, "claimed");
    // Premier passage : acknowledge() échoue, rien de plus n'est écrit.

    // Second passage (rejeu) : cette fois tout va au bout.
    store.record("note:2", 222, "claimed"); // no-op, déjà au même rang
    store.record("note:2", 222, "acked");
    store.record("note:2", 222, "running");
    store.record("note:2", 222, "done");

    assert.equal(store.statusOf("note:2"), "done");
    assert.equal(canProcess(store.statusOf("note:2")), false);
  });
});

describe("RequestStore — états terminaux", () => {
  test("une demande 'done' n'est jamais rejouée", () => {
    const store = new RequestStore(freshPath());
    store.record("note:3", 333, "claimed");
    store.record("note:3", 333, "acked");
    store.record("note:3", 333, "running");
    store.record("note:3", 333, "done");

    assert.equal(canProcess(store.statusOf("note:3")), false);
  });

  test("une demande abandonnée après épuisement des tentatives (statut 'failed') n'est jamais rejouée", () => {
    const store = new RequestStore(freshPath());
    store.record("note:4", 444, "claimed");
    // Plusieurs tentatives échouent (ack en échec répété), puis le plafond
    // MAX_ATTEMPTS est atteint : poll() marque explicitement l'abandon.
    store.record("note:4", 444, "failed", "abandonné après 3 tentatives");

    assert.equal(store.statusOf("note:4"), "failed");
    assert.equal(canProcess(store.statusOf("note:4")), false);

    // Un rejeu tardif du worker (tâche qui finit par aboutir après coup) ne
    // doit pas ressusciter une demande déjà abandonnée.
    store.record("note:4", 444, "done");
    assert.equal(store.statusOf("note:4"), "failed");
  });

  test("'running' orphelin (crash en pleine exécution) n'est pas rejoué, contrairement à 'claimed'/'acked'", () => {
    const store = new RequestStore(freshPath());
    store.record("note:5", 555, "claimed");
    store.record("note:5", 555, "acked");
    store.record("note:5", 555, "running");
    // Le daemon crashe ici, avant "done"/"failed".

    assert.equal(
      canProcess(store.statusOf("note:5")),
      false,
      "une tâche interrompue en plein worker ne doit pas être rejouée : on " +
        "ne sait pas si elle a déjà poussé du code",
    );
  });
});

describe("RequestStore — garde-fou de régression (record monotone)", () => {
  test("une écriture tardive et périmée ne fait pas reculer le statut connu", () => {
    const store = new RequestStore(freshPath());
    store.record("note:6", 666, "claimed");
    store.record("note:6", 666, "running");
    // handle() écrit "acked" après avoir attendu acknowledge() ; si le
    // worker est allé plus vite et a déjà atteint "running", cette écriture
    // arrive après coup et ne doit pas régresser l'état connu.
    store.record("note:6", 666, "acked");

    assert.equal(store.statusOf("note:6"), "running");
  });
});

describe("RequestStore — interrupted()", () => {
  test("distingue les orphelins rejouables (claimed/acked) de ceux bloqués (running)", () => {
    const store = new RequestStore(freshPath());
    store.record("a", 1, "claimed");
    store.record("b", 2, "acked");
    store.record("c", 3, "running");
    store.record("d", 4, "done");
    store.record("e", 5, "failed");

    const interrupted = store.interrupted();
    const byKey = new Map(interrupted.map((entry) => [entry.key, entry.status]));

    assert.equal(byKey.get("a"), "claimed");
    assert.equal(byKey.get("b"), "acked");
    assert.equal(byKey.get("c"), "running");
    assert.equal(byKey.has("d"), false);
    assert.equal(byKey.has("e"), false);
  });
});

describe("RequestStore — rétrocompatibilité du fichier d'état", () => {
  test("relit sans planter un fichier écrit par l'ancienne version (claimed/acked uniquement)", () => {
    const path = freshPath();
    writeFileSync(
      path,
      [
        JSON.stringify({
          key: "note:100",
          todoId: 1,
          status: "claimed",
          at: "2026-01-01T00:00:00.000Z",
        }),
        JSON.stringify({
          key: "note:100",
          todoId: 1,
          status: "acked",
          at: "2026-01-01T00:00:01.000Z",
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const store = new RequestStore(path);
    assert.equal(store.statusOf("note:100"), "acked");
    // Une ancienne demande "acked" n'est pas terminale : elle reste
    // rejouable si son to-do est toujours ouvert côté GitLab, exactement
    // comme au moment où le fichier a été écrit — pas de reclassement à
    // tort vers un statut terminal qui n'existait pas encore à l'époque.
    assert.equal(canProcess(store.statusOf("note:100")), true);
  });

  test("charge le vrai fichier state/processed.jsonl du dépôt (uniquement claimed/acked)", () => {
    const source = join(
      import.meta.dirname,
      "..",
      "..",
      "state",
      "processed.jsonl",
    );
    const path = freshPath();
    copyFileSync(source, path);

    const store = new RequestStore(path);
    const lines = readFileSync(source, "utf8").split("\n").filter(Boolean);
    const lastKey = JSON.parse(lines.at(-1) as string).key as string;

    // Le fichier réel ne contient que des paires claimed/acked : la
    // dernière entrée de chaque clé doit rester "acked", rejouable.
    assert.equal(store.statusOf(lastKey), "acked");
    assert.equal(canProcess(store.statusOf(lastKey)), true);
  });

  test("ignore une ligne corrompue sans faire planter le démarrage", () => {
    const path = freshPath();
    writeFileSync(
      path,
      [
        JSON.stringify({
          key: "note:200",
          todoId: 2,
          status: "claimed",
          at: "2026-01-01T00:00:00.000Z",
        }),
        "{ceci n'est pas du JSON valide",
        JSON.stringify({
          key: "note:201",
          todoId: 3,
          status: "done",
          at: "2026-01-01T00:00:02.000Z",
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    assert.doesNotThrow(() => new RequestStore(path));
    const store = new RequestStore(path);
    assert.equal(store.statusOf("note:200"), "claimed");
    assert.equal(store.statusOf("note:201"), "done");
  });
});
