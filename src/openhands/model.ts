/**
 * Aligner le modèle de l'instance OpenHands sur `.env`, au démarrage du
 * daemon.
 *
 * POURQUOI CE FICHIER EXISTE. Le modèle ne vit pas dans l'environnement du
 * conteneur OpenHands : il vit dans ses réglages persistés
 * (`agent_settings.llm.*`), et les variables `LLM_*` ne l'y remplacent pas —
 * vérifié en relançant l'instance avec un `LLM_MODEL` bidon, que
 * `GET /api/v1/settings` a superbement ignoré. Sans ce module, changer de
 * modèle demanderait de cliquer dans l'interface à chaque fois : ingérable
 * pour comparer une dizaine de modèles, et surtout asymétrique avec
 * `hardening`, où `AGENT_MODEL` dans `.env` EST le modèle. Une campagne où
 * une branche lit `.env` et l'autre un réglage d'interface est une campagne
 * où l'on finit par mesurer deux modèles différents sans s'en apercevoir.
 *
 * LE PIÈGE QUE ÇA OUVRE, ET QUE reconcile FERME. Sur cette branche, une merge
 * request réutilise sa conversation (voir conversations.ts) — et une
 * conversation déjà ouverte garde le modèle avec lequel elle a démarré.
 * Changer de modèle sans rien d'autre ferait donc remesurer l'ANCIEN modèle
 * sur toute merge request déjà touchée. Le registre est donc vidé dès que le
 * modèle change : la prochaine mention rouvre une conversation propre.
 */

import type { DesiredLlm, LlmSettings } from "./client.ts";

/** Ce qu'on veut imposer, tel que `.env` le décrit. */
export interface ModelIntent {
  model: string;
  baseUrl: string | undefined;
  apiKey: string | undefined;
}

export interface ReconcileDecision {
  /** Faut-il écrire dans les réglages de l'instance ? */
  apply: boolean;
  /**
   * Le modèle change-t-il vraiment de valeur ? Distinct d'`apply` : poser une
   * clé d'API manquante sans toucher au modèle demande une écriture, mais ne
   * justifie PAS de jeter les conversations en cours — elles tournent déjà
   * sur le bon modèle.
   */
  modelChanged: boolean;
  /** Ce qu'on en dira dans le journal. Toujours renseigné. */
  reason: string;
}

/**
 * Décide s'il faut écrire dans les réglages, et si le modèle change vraiment.
 * Fonction pure — c'est elle qui porte toutes les subtilités, et elle est
 * testée seule (voir tests/openhands/model.test.ts).
 *
 * `apiKey` ne peut PAS être comparée : le serveur ne rend jamais la clé, juste
 * un booléen `llm_api_key_set`. On écrit donc quand la clé est absente côté
 * serveur alors qu'on en a une — mais une clé CHANGÉE à valeur égale de
 * modèle passe inaperçue. C'est une limite assumée, pas un oubli : la seule
 * alternative serait de réécrire les réglages à chaque démarrage, ce qui
 * effacerait sans prévenir tout réglage fait à la main dans l'interface.
 */
export function reconcile(
  intent: ModelIntent,
  current: LlmSettings,
): ReconcileDecision {
  const modelChanged = current.model !== intent.model;
  const baseUrlChanged =
    intent.baseUrl !== undefined && current.baseUrl !== intent.baseUrl;
  const keyMissing = intent.apiKey !== undefined && !current.apiKeySet;

  if (modelChanged) {
    return {
      apply: true,
      modelChanged: true,
      reason: `modèle : ${current.model ?? "(aucun)"} → ${intent.model}`,
    };
  }
  if (baseUrlChanged) {
    return {
      apply: true,
      modelChanged: false,
      reason: `point d'accès : ${current.baseUrl ?? "(aucun)"} → ${intent.baseUrl}`,
    };
  }
  if (keyMissing) {
    return {
      apply: true,
      modelChanged: false,
      reason: "clé d'API absente côté instance",
    };
  }
  return {
    apply: false,
    modelChanged: false,
    reason: `déjà aligné sur ${intent.model}`,
  };
}

/** Ce que applyModel a besoin de savoir faire — injecté pour être testable sans réseau. */
export interface ModelDeps {
  getLlmSettings: () => Promise<LlmSettings>;
  setLlmSettings: (desired: DesiredLlm) => Promise<void>;
  /** Vide le registre des conversations et rend le nombre d'entrées oubliées. */
  forgetConversations: () => number;
  log: (level: "info" | "warn", message: string) => void;
}

/**
 * Applique l'intention au démarrage. Best-effort et jamais fatal : une
 * instance qui refuse ses réglages ne doit pas empêcher le daemon de tourner —
 * il reste capable de dispatcher, simplement sur le modèle déjà en place. Le
 * dire fort suffit, puisque quelqu'un lit ces lignes au démarrage.
 */
export async function applyModel(
  intent: ModelIntent,
  deps: ModelDeps,
): Promise<void> {
  let current: LlmSettings;
  try {
    current = await deps.getLlmSettings();
  } catch (error) {
    deps.log(
      "warn",
      `⚠ modèle de l'instance illisible (${(error as Error).message}) — laissé tel quel`,
    );
    return;
  }

  const decision = reconcile(intent, current);
  if (!decision.apply) {
    deps.log("info", `Modèle OpenHands : ${decision.reason}.`);
    return;
  }

  try {
    await deps.setLlmSettings(intent);
  } catch (error) {
    deps.log(
      "warn",
      `⚠ modèle non appliqué (${(error as Error).message}) — l'instance garde ${current.model ?? "son réglage actuel"}`,
    );
    return;
  }

  if (!decision.modelChanged) {
    deps.log("info", `Réglages OpenHands mis à jour — ${decision.reason}.`);
    return;
  }

  // Le modèle a bougé : les conversations existantes tournent encore sur
  // l'ancien. Les oublier force une conversation neuve à la prochaine
  // mention, donc une mesure faite sur le modèle qu'on croit mesurer.
  const forgotten = deps.forgetConversations();
  deps.log(
    "warn",
    `Modèle OpenHands changé — ${decision.reason}.` +
      (forgotten > 0
        ? ` ${forgotten} conversation(s) oubliée(s) : les merge requests déjà touchées repartiront sur une conversation neuve, sans quoi elles auraient continué avec l'ancien modèle.`
        : ""),
  );
}
