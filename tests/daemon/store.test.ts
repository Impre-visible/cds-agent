import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestStore, canProcess } from "../../src/daemon/store.ts";

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

describe("RequestStore — isEmpty() (proxy de 'premier démarrage', voir bootstrap.ts)", () => {
  test("un store neuf (fichier absent) est vide", () => {
    const store = new RequestStore(freshPath());
    assert.equal(store.isEmpty(), true);
  });

  test("dès la première écriture, le store n'est plus vide", () => {
    const store = new RequestStore(freshPath());
    store.record("note:900", 900, "claimed");
    assert.equal(store.isEmpty(), false);
  });

  test("un store relu depuis un fichier déjà peuplé n'est pas vide", () => {
    const path = freshPath();
    writeFileSync(
      path,
      `${JSON.stringify({ key: "note:901", todoId: 901, status: "acked", at: "2026-01-01T00:00:00.000Z" })}\n`,
      "utf8",
    );
    const store = new RequestStore(path);
    assert.equal(store.isEmpty(), false);
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
    const byKey = new Map(
      interrupted.map((entry) => [entry.key, entry.status]),
    );

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

  test("charge une fixture au format historique (plusieurs clés, paires claimed/acked, une ligne illisible)", () => {
    // state/processed.jsonl (le vrai fichier d'état) est gitignoré : absent
    // en CI, et potentiellement vide même en local (voir le test
    // opportuniste ci-dessous). Ce test-ci ne dépend d'aucun fichier
    // ambiant : une fixture versionnée, au format historique (uniquement des
    // paires claimed/acked, écrites avant l'introduction du cycle de vie
    // complet running/done/failed), avec des identifiants anonymisés — le
    // vrai fichier contient de vrais identifiants de notes/to-dos GitLab, ne
    // jamais les recopier ici.
    const source = join(
      import.meta.dirname,
      "..",
      "fixtures",
      "legacy-processed.jsonl",
    );
    const path = freshPath();
    copyFileSync(source, path);
    const store = new RequestStore(path);

    // Plusieurs clés (voir tests/fixtures/legacy-processed.jsonl), chacune
    // avec une paire claimed puis acked : la dernière entrée de chaque clé
    // doit rester "acked", rejouable — exactement le format que l'ancienne
    // version du daemon écrivait, avant que "running"/"done"/"failed"
    // n'existent.
    for (const key of ["note:100001", "desc:42:issues:7", "note:100002"]) {
      assert.equal(store.statusOf(key), "acked");
      assert.equal(canProcess(store.statusOf(key)), true);
    }

    // La ligne illisible glissée entre les deux dernières paires (voir la
    // fixture) n'a produit ni clé ni plantage : exactement 3 clés connues,
    // pas une quatrième fabriquée à partir de la ligne corrompue.
    assert.equal(store.interrupted().length, 3);
  });

  test("vérification opportuniste supplémentaire : si state/processed.jsonl existe réellement et n'est pas vide, mêmes garanties", () => {
    // Complément du test ci-dessus, jamais un remplacement : celui-ci reste
    // muet (ni assertion ni t.skip()) quand le fichier réel est absent ou
    // vide, précisément pour que le NOMBRE de tests exécutés ne varie
    // jamais d'une machine à l'autre (le point qui faisait qu'une machine
    // sans state/processed.jsonl tombait sur "1 test sauté" et une autre
    // non). Un t.skip() aurait réintroduit exactement ce défaut.
    const source = join(
      import.meta.dirname,
      "..",
      "..",
      "state",
      "processed.jsonl",
    );

    if (!existsSync(source)) return;

    const keys = new Set(
      readFileSync(source, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l).key as string),
    );

    if (keys.size === 0) return;

    const path = freshPath();
    copyFileSync(source, path);
    const store = new RequestStore(path);

    // Ce que ce test vérifie sur le fichier RÉEL : que le lecteur encaisse
    // des données de production sans jeter et sans perdre de clé. Rien de
    // plus.
    //
    // Il affirmait auparavant que chaque clé finissait en "acked", donc
    // rejouable. C'était vrai le jour où il a été écrit et faux dès qu'un
    // daemon a réellement tourné : un arrêt en pleine exécution laisse des
    // entrées "running", une tâche terminée laisse "done" — mesuré le
    // 1er août 2026 sur un fichier à 5 claimed, 5 running et 3 done. Un test
    // qui affirme une propriété de DONNÉES VIVANTES que le daemon a le droit
    // de changer ne teste plus le code, il teste l'humeur de la machine. Le
    // contrat de rétrocompatibilité du format hérité, lui, reste couvert par
    // le test ci-dessus, sur une fixture figée.
    for (const key of keys) {
      const status = store.statusOf(key);
      assert.ok(
        status !== undefined,
        `clé "${key}" présente dans le fichier réel mais inconnue du store`,
      );
      assert.equal(
        typeof canProcess(status),
        "boolean",
        `statut "${status}" non classé par canProcess`,
      );
    }
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

describe("RequestStore — compactage (§6.6)", () => {
  /** Écrit le cycle de vie complet (jusqu'à 4 lignes) d'une demande. */
  function lifecycle(
    key: string,
    todoId: number,
    finalStatus: "done" | "failed",
  ): string[] {
    return [
      JSON.stringify({
        key,
        todoId,
        status: "claimed",
        at: "2026-01-01T00:00:00.000Z",
      }),
      JSON.stringify({
        key,
        todoId,
        status: "acked",
        at: "2026-01-01T00:00:01.000Z",
      }),
      JSON.stringify({
        key,
        todoId,
        status: "running",
        at: "2026-01-01T00:00:02.000Z",
      }),
      JSON.stringify({
        key,
        todoId,
        status: finalStatus,
        at: "2026-01-01T00:00:03.000Z",
      }),
    ];
  }

  test("un fichier de plusieurs milliers de lignes est compacté au démarrage, sans perte d'information", () => {
    const path = freshPath();
    const lines: string[] = [];
    const expected = new Map<string, "done" | "failed">();

    for (let i = 0; i < 400; i++) {
      const key = `req:${i}`;
      const finalStatus = i % 2 === 0 ? "done" : "failed";
      lines.push(...lifecycle(key, i, finalStatus));
      expected.set(key, finalStatus);
    }
    // 400 demandes × 4 lignes = 1600 lignes, bien au-delà du seuil.
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    const store = new RequestStore(path);

    // Rien n'est perdu : chaque demande garde son statut final exact.
    for (const [key, status] of expected) {
      assert.equal(store.statusOf(key), status);
    }

    // Le fichier sur disque a bien été réécrit : une ligne par demande
    // (400), pas 1600.
    const compacted = readFileSync(path, "utf8").split("\n").filter(Boolean);
    assert.equal(compacted.length, 400);

    // Un rechargement à partir du fichier compacté ne perd rien non plus.
    const reloaded = new RequestStore(path);
    for (const [key, status] of expected) {
      assert.equal(reloaded.statusOf(key), status);
    }
  });

  test("un fichier sous le seuil n'est pas réécrit", () => {
    const path = freshPath();
    const store = new RequestStore(path);
    store.record("small:1", 1, "claimed");
    store.record("small:1", 1, "acked");
    const before = readFileSync(path, "utf8");

    new RequestStore(path); // relecture : sous le seuil, pas de compactage
    const after = readFileSync(path, "utf8");
    assert.equal(after, before, "un petit fichier ne doit pas être touché");
  });

  test("une demande interrompue (statut non terminal) reste correctement rejouable après compactage", () => {
    const path = freshPath();
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(...lifecycle(`req:${i}`, i, i % 2 === 0 ? "done" : "failed"));
    }
    // Une demande en plein cycle, jamais terminée.
    lines.push(
      JSON.stringify({
        key: "orphan",
        todoId: 999,
        status: "claimed",
        at: "2026-01-01T00:00:00.000Z",
      }),
    );
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    const store = new RequestStore(path);
    assert.equal(store.statusOf("orphan"), "claimed");
    assert.equal(canProcess(store.statusOf("orphan")), true);

    // Le fichier compacté conserve cette information au rechargement.
    const reloaded = new RequestStore(path);
    assert.equal(reloaded.statusOf("orphan"), "claimed");
  });

  test("un fichier .tmp orphelin laissé par une précédente tentative de compactage avortée n'empêche ni la relecture ni un nouveau compactage", () => {
    const path = freshPath();
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push(
        JSON.stringify({
          key: `k:${i}`,
          todoId: i,
          status: "claimed",
          at: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    // Simule une tentative de compactage passée, interrompue juste après
    // l'écriture du fichier temporaire mais avant le renommage : un .tmp
    // orphelin (contenu quelconque, potentiellement à moitié écrit), à côté
    // du fichier réel resté, lui, parfaitement intact.
    writeFileSync(
      `${path}.compact.tmp`,
      "{ceci n'est pas une ligne JSON valide",
      "utf8",
    );

    const store = new RequestStore(path);
    for (let i = 0; i < 600; i++) {
      assert.equal(store.statusOf(`k:${i}`), "claimed");
    }

    // Ce démarrage-ci dépasse aussi le seuil : le compactage a dû réussir
    // malgré le .tmp orphelin (simplement écrasé, jamais lu).
    const compacted = readFileSync(path, "utf8").split("\n").filter(Boolean);
    assert.equal(compacted.length, 600);
  });

  test("un renommage qui échoue réellement (répertoire en lecture seule) laisse le fichier original intact, sans faire planter le démarrage", () => {
    // Mocker node:fs échoue ici : les imports nommés ESM d'un module natif
    // (import { renameSync } from "node:fs", utilisé par store.ts) sont des
    // liaisons figées à la valeur d'origine, pas des accesseurs relisant une
    // propriété mutable — remplacer fs.renameSync (ou fs.default.renameSync)
    // après coup n'a aucun effet sur ce que store.ts appelle réellement.
    // On simule donc un *vrai* échec de renameSync plutôt qu'un mock : un
    // répertoire en lecture seule, sur lequel renameSync échoue réellement
    // avec EACCES/EPERM (rename modifie l'entrée du répertoire, pas
    // seulement le fichier).
    const dir = mkdtempSync(join(root, "readonly-"));
    const path = join(dir, "processed.jsonl");

    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push(
        JSON.stringify({
          key: `k:${i}`,
          todoId: i,
          status: "claimed",
          at: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    const original = `${lines.join("\n")}\n`;
    writeFileSync(path, original, "utf8");

    chmodSync(dir, 0o555);
    try {
      // Le compactage échoue (renameSync refusé par le système de
      // fichiers), mais ce n'est qu'une optimisation ratée : le démarrage ne
      // doit pas planter pour autant, et le fichier original — jamais
      // réécrit en place — reste tel quel.
      assert.doesNotThrow(() => new RequestStore(path));
      assert.equal(readFileSync(path, "utf8"), original);
    } finally {
      chmodSync(dir, 0o755); // pour que `after()` puisse nettoyer `root`
    }
  });
});
