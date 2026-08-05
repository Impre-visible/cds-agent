/**
 * Imposer la QUANTIFICATION servie par OpenRouter, par modèle.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LE PROBLÈME QUE ÇA RÈGLE
 * ─────────────────────────────────────────────────────────────────────────
 *
 * OpenRouter route entre fournisseurs, et ils ne servent pas tous la même
 * quantification du même modèle. Relevé sur la liste du banc : kimi-k2.6 est
 * servi en int4 par 7 fournisseurs, fp4 par 5, fp8 par 2, bf16 par 1. Ses
 * trois tirages ont donc pu tourner sur trois quantifications différentes,
 * sans que rien ne l'écrive nulle part. Une part de la variance attribuée aux
 * modèles vient peut-être de là.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LA CHAÎNE, VÉRIFIÉE DE BOUT EN BOUT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `litellm_extra_body` (réglages LLM d'OpenHands, schéma `LLM-Input`)
 *   → `extra_body` de LiteLLM
 *     → corps de la requête OpenRouter
 *
 * Vérifié le 4 août 2026, pas supposé : une contrainte volontairement
 * impossible (`quantizations: ["int4"]` sur nemotron-3-super, qui n'en a pas)
 * a fait échouer l'appel du bac à sable avec le message exact d'OpenRouter —
 * « No endpoints found for the request with quantization: int4 ». Le champ
 * traverse. Aucun proxy local n'est nécessaire.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POURQUOI `allow_fallbacks: false` REND LA MESURE FIABLE
 * ─────────────────────────────────────────────────────────────────────────
 *
 * La documentation d'OpenRouter décrit `quantizations` comme un filtre qui
 * « déprioritise » les fournisseurs non conformes. Avec `allow_fallbacks:
 * false`, c'est un filtre DUR : mesuré, une quantification indisponible rend
 * un 404, pas un repli silencieux.
 *
 * Conséquence, et c'est le point important : **un tirage qui aboutit a
 * forcément tourné sur la quantification demandée.** L'enforcement est garanti
 * par construction, pas par observation — contrairement à la colonne
 * `competences` de la manche 4, qui lisait quelque chose et affichait
 * « aucune » sans que personne ne s'en aperçoive.
 *
 * C'est heureux, car la LIRE après coup n'est pas possible ici : le fournisseur
 * retenu figure dans la réponse de complétion, or ces appels ont lieu dans le
 * bac à sable ; et `GET /api/v1/activity` d'OpenRouter exige une « management
 * key » (403 avec la clé d'inférence — vérifié).
 */

import { readFileSync } from "node:fs";

/**
 * Les valeurs acceptées par OpenRouter, relevées dans sa documentation de
 * routage (« Accepted Quantization Values »). Validées au chargement : une
 * valeur inventée ferait échouer TOUS les appels du modèle concerné par un
 * 404, et ce chantier existe précisément pour ne plus découvrir ce genre de
 * chose au dépouillement.
 */
export const OPENROUTER_QUANTIZATIONS = [
  "int4",
  "int8",
  "fp4",
  "mxfp4",
  "nvfp4",
  "fp6",
  "fp8",
  "mxfp8",
  "fp16",
  "bf16",
  "fp32",
  "unknown",
] as const;

export type Quantization = (typeof OPENROUTER_QUANTIZATIONS)[number];

/**
 * Clé réservée : ce qui s'applique à TOUS les modèles.
 *
 * Un "/" figure dans tout identifiant OpenRouter (`éditeur/modèle`), donc
 * `"*"` ne peut jamais entrer en collision avec un modèle réel.
 *
 * Existe pour `ignore` : un fournisseur cassé l'est pour tous les modèles
 * qu'il sert, pas pour un seul. Le 4 août 2026, Inceptron a rendu 422
 * (« missing field `content` ») sur minimax et kimi — il refuse un message
 * d'assistant qui ne porte que des appels d'outils. Il sert aussi glm-5.2.
 * Le lister par modèle demanderait de le répéter trois fois, et de le
 * rajouter le jour où il commence à servir un quatrième.
 */
export const GLOBAL_KEY = "*";

export interface QuantizationEntry {
  /** Quantifications acceptables, par ordre de préférence. Jamais vide. */
  quantizations: Quantization[];
  /**
   * Le modèle est-il mesuré dans sa configuration de DÉPLOIEMENT réelle ?
   *
   * `false` = borne haute : OpenRouter ne descend pas assez bas (pas d'IQ2
   * pour glm-5.2, pas de Q2 pour kimi-k2.6). Le score reste utile — « voici ce
   * que produirait ce modèle en pleine qualité » — mais il ne prédit rien sur
   * la machine cible, et ça doit se lire À CÔTÉ du chiffre, pas en note de bas
   * de page.
   */
  deployable: boolean;
  /**
   * Fournisseurs à écarter (slugs OpenRouter, pas noms affichés — relevés dans
   * `GET /api/v1/providers`). S'ajoute à la liste globale, ne la remplace pas.
   */
  ignore?: string[];
}

/** L'entrée `"*"` : uniquement des réglages transverses, aucune quantification. */
export interface GlobalEntry {
  ignore: string[];
}

export type QuantizationTable = Record<string, QuantizationEntry> & {
  [GLOBAL_KEY]?: never;
};

/** Table complète : les modèles, plus l'entrée globale éventuelle. */
export interface Quantizations {
  models: QuantizationTable;
  global: GlobalEntry;
}

function isQuantization(value: unknown): value is Quantization {
  return (
    typeof value === "string" &&
    (OPENROUTER_QUANTIZATIONS as readonly string[]).includes(value)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIgnore(raw: unknown, where: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((slug) => typeof slug !== "string" || !slug)) {
    throw new Error(
      `${where}.ignore doit être un tableau de slugs de fournisseurs non vides ` +
        `(ex. ["inceptron"] — le SLUG, relevé dans GET /api/v1/providers, ` +
        `pas le nom affiché "Inceptron")`,
    );
  }
  return raw as string[];
}

/**
 * Valide la table. Fail-closed comme projects.json : une clé inconnue, une
 * quantification inventée ou un `deployable` non booléen fait échouer le
 * chargement plutôt que d'être ignoré.
 *
 * Un réglage muet ici serait le pire des cas : on croirait mesurer du fp8 sans
 * en mesurer.
 */
export function parseQuantizationTable(
  raw: unknown,
  path: string,
): Quantizations {
  const empty: Quantizations = { models: {}, global: { ignore: [] } };
  if (raw === undefined || raw === null) return empty;
  if (!isPlainObject(raw)) {
    throw new Error(`${path} invalide : la racine doit être un objet`);
  }

  const models: Record<string, QuantizationEntry> = {};
  let global: GlobalEntry = { ignore: [] };

  for (const [model, entryRaw] of Object.entries(raw)) {
    const where = `${path} → "${model}"`;
    if (!isPlainObject(entryRaw)) {
      throw new Error(`${where} doit être un objet`);
    }

    // L'entrée globale ne porte QUE des réglages transverses : y accepter une
    // quantification laisserait croire qu'on peut en imposer une à tous les
    // modèles, ce qui n'a pas de sens (chacun a la sienne).
    if (model === GLOBAL_KEY) {
      for (const key of Object.keys(entryRaw)) {
        if (key !== "ignore") {
          throw new Error(
            `${where} : clé inconnue "${key}" — l'entrée "${GLOBAL_KEY}" n'accepte que "ignore"`,
          );
        }
      }
      global = { ignore: parseIgnore(entryRaw.ignore, where) };
      continue;
    }

    for (const key of Object.keys(entryRaw)) {
      if (key !== "quantizations" && key !== "deployable" && key !== "ignore") {
        throw new Error(
          `${where} : clé inconnue "${key}" (attendu "quantizations", "deployable", "ignore")`,
        );
      }
    }

    const list = entryRaw.quantizations;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`${where}.quantizations doit être un tableau non vide`);
    }
    for (const value of list) {
      if (!isQuantization(value)) {
        throw new Error(
          `${where}.quantizations : ${JSON.stringify(value)} n'est pas une ` +
            `quantification OpenRouter (${OPENROUTER_QUANTIZATIONS.join(", ")})`,
        );
      }
    }

    const deployable = entryRaw.deployable;
    if (typeof deployable !== "boolean") {
      throw new Error(
        `${where}.deployable doit être un booléen (reçu ${JSON.stringify(deployable)})`,
      );
    }

    models[model] = {
      quantizations: list as Quantization[],
      deployable,
      ignore: parseIgnore(entryRaw.ignore, where),
    };
  }

  return { models: models as QuantizationTable, global };
}

/**
 * Charge la table. Fichier ABSENT ⇒ table vide, comportement inchangé : on
 * laisse OpenRouter router librement. Fichier PRÉSENT mais illisible ou
 * invalide ⇒ échec — quelqu'un a voulu contraindre le routage, le faire à
 * moitié serait pire que pas du tout.
 */
export function loadQuantizationTable(path: string): Quantizations {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { models: {}, global: { ignore: [] } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} : JSON invalide — ${(error as Error).message}`);
  }
  return parseQuantizationTable(raw, path);
}

/**
 * Le `extra_body` à poser sur l'instance pour ce modèle.
 *
 * Rend `{}` quand rien ne s'applique — et c'est un `{}` qu'il FAUT envoyer,
 * pas une absence : le banc change de modèle entre deux tirages sur la même
 * instance, et une contrainte laissée en place par le modèle précédent
 * s'appliquerait au suivant. Un fp8 oublié sur un modèle qui n'en a pas, c'est
 * un 404 sur les trois tirages suivants.
 *
 * `ignore` s'applique MÊME à un modèle absent de la table : un fournisseur
 * cassé l'est indépendamment de la quantification qu'on demande.
 */
export function extraBodyFor(
  model: string,
  table: Quantizations,
): Record<string, unknown> {
  const entry = table.models[model];
  const ignore = [...new Set([...table.global.ignore, ...(entry?.ignore ?? [])])];

  if (!entry && ignore.length === 0) return {};

  const provider: Record<string, unknown> = {};
  if (entry) {
    provider.quantizations = entry.quantizations;
    // Sans lui, OpenRouter reprend la main dès qu'aucun fournisseur de la
    // quantification demandée n'est disponible, SILENCIEUSEMENT. C'est
    // exactement ce qu'on cherche à empêcher.
    provider.allow_fallbacks = false;
  }
  if (ignore.length > 0) provider.ignore = ignore;
  return { provider };
}

/** Ce qu'on écrit dans le CSV et le journal : "fp8", "int4+fp4", ou "libre". */
export function describeQuantization(
  model: string,
  table: Quantizations,
): string {
  const entry = table.models[model];
  return entry ? entry.quantizations.join("+") : "libre";
}

/**
 * "oui" / "non" / "?" pour le CSV.
 *
 * "?" — modèle absent de la table — n'est PAS "non" : on ne sait pas, et
 * écrire "non" laisserait croire qu'une borne haute a été identifiée comme
 * telle alors que personne ne s'est prononcé.
 */
export function describeDeployable(
  model: string,
  table: Quantizations,
): string {
  const entry = table.models[model];
  if (!entry) return "?";
  return entry.deployable ? "oui" : "non";
}

/** Les fournisseurs écartés pour ce modèle, globaux et propres réunis. */
export function ignoredProvidersFor(
  model: string,
  table: Quantizations,
): string[] {
  return [
    ...new Set([...table.global.ignore, ...(table.models[model]?.ignore ?? [])]),
  ];
}
