import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConversationStore,
  conversationKey,
} from "../../src/openhands/conversations.ts";

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cds-conversations-"));
  path = join(directory, "conversations.json");
});

after(() => {
  // Chaque beforeEach crée son propre répertoire ; celui du dernier test
  // reste à nettoyer.
  if (directory && existsSync(directory)) rmSync(directory, { recursive: true, force: true });
});

describe("conversationKey", () => {
  test("insensible à la casse du chemin de dépôt", () => {
    // GitLab l'est aussi (voir authorize.ts) : deux clés pour la même MR
    // rouvriraient une conversation, donc un conteneur, de trop.
    assert.equal(
      conversationKey("Groupe/Depot", 5),
      conversationKey("groupe/depot", 5),
    );
  });

  test("deux MR du même dépôt ne partagent pas de clé", () => {
    assert.notEqual(conversationKey("g/p", 5), conversationKey("g/p", 6));
  });
});

describe("ConversationStore", () => {
  test("un registre neuf ne connaît rien", () => {
    assert.equal(new ConversationStore(path).get("g/p!5"), null);
  });

  test("ce qui est enregistré est relu à l'identique par une nouvelle instance", () => {
    // C'est tout l'intérêt du fichier : survivre au redémarrage du daemon.
    // Sans ça, chaque redémarrage rouvrirait une conversation par MR active.
    new ConversationStore(path).set("g/p!5", { conversationId: "c1", sandboxId: "s1" });

    const relu = new ConversationStore(path).get("g/p!5");
    assert.deepEqual(relu, { conversationId: "c1", sandboxId: "s1" });
  });

  test("un second enregistrement sur la même clé remplace le premier", () => {
    const store = new ConversationStore(path);
    store.set("g/p!5", { conversationId: "c1", sandboxId: "s1" });
    store.set("g/p!5", { conversationId: "c2", sandboxId: "s2" });
    assert.equal(store.get("g/p!5")?.conversationId, "c2");
    assert.equal(new ConversationStore(path).get("g/p!5")?.conversationId, "c2");
  });

  test("forget efface l'entrée, sur disque aussi", () => {
    const store = new ConversationStore(path);
    store.set("g/p!5", { conversationId: "c1", sandboxId: "s1" });
    store.forget("g/p!5");
    assert.equal(store.get("g/p!5"), null);
    assert.equal(new ConversationStore(path).get("g/p!5"), null);
  });

  test("forget sur une clé inconnue ne fait rien et ne jette pas", () => {
    const store = new ConversationStore(path);
    store.forget("jamais/vu!1");
    assert.equal(store.get("jamais/vu!1"), null);
  });

  test("plusieurs merge requests cohabitent", () => {
    const store = new ConversationStore(path);
    store.set("g/p!5", { conversationId: "c5", sandboxId: "s5" });
    store.set("g/p!6", { conversationId: "c6", sandboxId: "s6" });
    store.set("autre/depot!1", { conversationId: "c1", sandboxId: null });

    const relu = new ConversationStore(path);
    assert.equal(relu.get("g/p!5")?.conversationId, "c5");
    assert.equal(relu.get("g/p!6")?.conversationId, "c6");
    assert.equal(relu.get("autre/depot!1")?.sandboxId, null);
  });

  test("un fichier corrompu n'empêche PAS le daemon de démarrer", () => {
    // Perte bénigne (au pire une conversation de trop par MR) contre un
    // démarrage refusé qui bloquerait tout le service : le choix est vite
    // fait. Le registre repart vide, et se reremplit tout seul.
    writeFileSync(path, "{ ceci n'est pas du JSON");
    const store = new ConversationStore(path);
    assert.equal(store.get("g/p!5"), null);

    // Et il reste utilisable : la première écriture réécrit le fichier.
    store.set("g/p!5", { conversationId: "c1", sandboxId: null });
    assert.equal(new ConversationStore(path).get("g/p!5")?.conversationId, "c1");
  });

  test("une entrée mal formée est ignorée sans emporter les autres", () => {
    writeFileSync(
      path,
      JSON.stringify({
        "g/p!5": { conversationId: "c5", sandboxId: "s5" },
        "g/p!6": { sandboxId: "s6" }, // pas de conversationId : inexploitable
        "g/p!7": null,
        "g/p!8": { conversationId: "c8", sandboxId: 42 }, // type inattendu
      }),
    );
    const store = new ConversationStore(path);
    assert.equal(store.get("g/p!5")?.conversationId, "c5");
    assert.equal(store.get("g/p!6"), null);
    assert.equal(store.get("g/p!7"), null);
    // conversationId exploitable, sandboxId ramené à null : on garde ce qui
    // est utilisable plutôt que de jeter l'entrée entière — une reprise sans
    // sandboxId reste possible tant que le bac à sable tourne.
    assert.deepEqual(store.get("g/p!8"), { conversationId: "c8", sandboxId: null });
  });

  test("un JSON valide mais du mauvais type (tableau) repart d'un registre vide", () => {
    writeFileSync(path, JSON.stringify(["pas", "un", "objet"]));
    assert.equal(new ConversationStore(path).get("g/p!5"), null);
  });

  test("le fichier temporaire d'écriture atomique ne subsiste pas", () => {
    // renameSync plutôt qu'une écriture directe : un arrêt en plein milieu
    // laisserait sinon un JSON tronqué, donc un registre vide au redémarrage.
    new ConversationStore(path).set("g/p!5", { conversationId: "c1", sandboxId: null });
    assert.equal(existsSync(`${path}.tmp`), false);
    assert.doesNotThrow(() => JSON.parse(readFileSync(path, "utf8")));
  });

  test("le répertoire est créé s'il n'existe pas encore", () => {
    const nested = join(directory, "state", "conversations.json");
    new ConversationStore(nested).set("g/p!5", { conversationId: "c1", sandboxId: null });
    assert.equal(existsSync(nested), true);
  });
});

describe("ConversationStore.clear — changement de modèle", () => {
  test("vide tout et rend le compte, sur disque aussi", () => {
    // Appelé quand AGENT_MODEL change : une conversation garde le modèle avec
    // lequel elle a démarré, la réutiliser remesurerait l'ancien.
    const store = new ConversationStore(path);
    store.set("g/p!5", { conversationId: "c5", sandboxId: null });
    store.set("g/p!6", { conversationId: "c6", sandboxId: null });

    assert.equal(store.clear(), 2);
    assert.equal(store.get("g/p!5"), null);
    assert.equal(new ConversationStore(path).get("g/p!6"), null);
  });

  test("sur un registre déjà vide : rend 0 et n'écrit rien", () => {
    assert.equal(new ConversationStore(path).clear(), 0);
    assert.equal(existsSync(path), false);
  });
});
