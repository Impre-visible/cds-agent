import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyModel, reconcile } from "../../src/openhands/model.ts";
import type { DesiredLlm, LlmSettings } from "../../src/openhands/client.ts";

const INTENT = {
  model: "openrouter/xiaomi/mimo-v2.5",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "sk-or-xxx",
};

function current(overrides: Partial<LlmSettings> = {}): LlmSettings {
  return {
    model: "openrouter/xiaomi/mimo-v2.5",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeySet: true,
    ...overrides,
  };
}

describe("reconcile — faut-il écrire, et le modèle bouge-t-il vraiment", () => {
  test("tout est déjà aligné : on n'écrit pas", () => {
    // Réécrire à chaque démarrage effacerait sans prévenir un réglage fait à
    // la main dans l'interface.
    const decision = reconcile(INTENT, current());
    assert.equal(decision.apply, false);
    assert.equal(decision.modelChanged, false);
    assert.match(decision.reason, /déjà aligné/);
  });

  test("modèle différent : on écrit ET on signale le changement", () => {
    const decision = reconcile(INTENT, current({ model: "openai/gpt-4o" }));
    assert.equal(decision.apply, true);
    assert.equal(decision.modelChanged, true);
    assert.match(decision.reason, /openai\/gpt-4o/);
    assert.match(decision.reason, /mimo-v2\.5/);
  });

  test("instance vierge (aucun modèle) : traité comme un changement", () => {
    const decision = reconcile(INTENT, current({ model: null }));
    assert.equal(decision.modelChanged, true);
    assert.match(decision.reason, /\(aucun\)/);
  });

  test("point d'accès changé, même modèle : on écrit SANS jeter les conversations", () => {
    // Distinction qui compte : les conversations en cours tournent déjà sur
    // le bon modèle, les jeter ferait perdre du contexte pour rien.
    const decision = reconcile(INTENT, current({ baseUrl: "http://autre:1234/v1" }));
    assert.equal(decision.apply, true);
    assert.equal(decision.modelChanged, false);
    assert.match(decision.reason, /point d'accès/);
  });

  test("clé absente côté instance : on l'y pose, sans toucher aux conversations", () => {
    const decision = reconcile(INTENT, current({ apiKeySet: false }));
    assert.equal(decision.apply, true);
    assert.equal(decision.modelChanged, false);
    assert.match(decision.reason, /clé d'API absente/);
  });

  test("aucune clé voulue : l'absence côté instance n'est pas un motif d'écriture", () => {
    const decision = reconcile(
      { ...INTENT, apiKey: undefined },
      current({ apiKeySet: false }),
    );
    assert.equal(decision.apply, false);
  });

  test("aucune base_url voulue : celle de l'instance n'est jamais écrasée", () => {
    // Une base_url vide n'est pas la même chose qu'absente : l'envoyer
    // casserait un fournisseur qui n'en a pas besoin.
    const decision = reconcile(
      { ...INTENT, baseUrl: undefined },
      current({ baseUrl: "https://deja-la/v1" }),
    );
    assert.equal(decision.apply, false);
  });
});

/** Enregistre ce que applyModel a fait, sans réseau ni disque. */
function spy(
  currentSettings: LlmSettings | Error,
  options: { setFails?: boolean; entries?: number } = {},
) {
  const written: DesiredLlm[] = [];
  const logs: string[] = [];
  let cleared = 0;

  return {
    written,
    logs,
    cleared: () => cleared,
    deps: {
      getLlmSettings: async () => {
        if (currentSettings instanceof Error) throw currentSettings;
        return currentSettings;
      },
      setLlmSettings: async (desired: DesiredLlm) => {
        if (options.setFails) throw new Error("503 refusé");
        written.push(desired);
      },
      forgetConversations: () => {
        cleared = options.entries ?? 0;
        return cleared;
      },
      log: (level: "info" | "warn", message: string) => logs.push(`${level}: ${message}`),
    },
  };
}

describe("applyModel — alignement au démarrage", () => {
  test("déjà aligné : aucune écriture, aucune conversation jetée", async () => {
    const s = spy(current());
    await applyModel(INTENT, s.deps);
    assert.equal(s.written.length, 0);
    assert.equal(s.cleared(), 0);
    assert.match(s.logs.join("\n"), /info: Modèle OpenHands : déjà aligné/);
  });

  test("changement de modèle : écriture, puis purge du registre", async () => {
    // Le piège que ça ferme : une conversation garde le modèle avec lequel
    // elle a démarré. Sans la purge, remesurer la même MR mesurerait l'ancien.
    const s = spy(current({ model: "openai/gpt-4o" }), { entries: 3 });
    await applyModel(INTENT, s.deps);

    assert.deepEqual(s.written, [INTENT]);
    assert.equal(s.cleared(), 3);
    const line = s.logs.join("\n");
    assert.match(line, /warn: Modèle OpenHands changé/);
    assert.match(line, /3 conversation\(s\) oubliée\(s\)/);
  });

  test("changement de modèle avec un registre vide : pas de phrase sur les conversations", async () => {
    const s = spy(current({ model: "openai/gpt-4o" }), { entries: 0 });
    await applyModel(INTENT, s.deps);
    assert.doesNotMatch(s.logs.join("\n"), /oubliée/);
  });

  test("clé seule à poser : on écrit, on ne jette RIEN", async () => {
    const s = spy(current({ apiKeySet: false }), { entries: 5 });
    await applyModel(INTENT, s.deps);
    assert.equal(s.written.length, 1);
    assert.equal(s.cleared(), 0, "les conversations tournent déjà sur le bon modèle");
  });

  test("réglages illisibles : le daemon continue, sans rien casser", async () => {
    // Best-effort et jamais fatal : le daemon reste capable de dispatcher sur
    // le modèle déjà en place.
    const s = spy(new Error("connexion refusée"));
    await applyModel(INTENT, s.deps);
    assert.equal(s.written.length, 0);
    assert.equal(s.cleared(), 0);
    assert.match(s.logs.join("\n"), /warn: ⚠ modèle de l'instance illisible/);
  });

  test("écriture refusée : on le dit, on ne purge PAS le registre", async () => {
    // La purge serait une perte sèche : l'instance tourne toujours sur
    // l'ancien modèle, les conversations existantes sont donc cohérentes.
    const s = spy(current({ model: "openai/gpt-4o" }), { setFails: true, entries: 4 });
    await applyModel(INTENT, s.deps);
    assert.equal(s.cleared(), 0);
    const line = s.logs.join("\n");
    assert.match(line, /warn: ⚠ modèle non appliqué/);
    assert.match(line, /openai\/gpt-4o/);
  });
});
