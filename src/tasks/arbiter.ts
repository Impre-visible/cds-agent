import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { runAgent, type AgentResult } from "../agent/runner.ts";
import { runAgentInSandbox } from "../agent/sandbox.ts";
import {
  escapeDelimiters,
  extractJson,
  normalizeSeverity,
  type AggregatedRemark,
} from "./review.ts";
import { log } from "../log.ts";

// ---------------------------------------------------------------------------
// Chantier "arbitre de fin de revue"
// ---------------------------------------------------------------------------
//
// Le tri par sévérité classe des remarques prises ISOLÉMENT. Il ne peut pas
// voir qu'une remarque est fausse, parce qu'il faudrait relire le code pour le
// savoir.
//
// Cas mesuré le 1er août 2026, publié en tête de classement :
//
//   src/todoStore.js:28 [info] La variable needle est assignée mais jamais
//   utilisée : le filtre référence q directement au lieu de needle. Code mort.
//
// C'est faux — `needle` EST utilisé, et cette ligne est même le siège d'un
// vrai défaut (il n'est pas passé en minuscules). Deux lignes de source
// suffisent à le constater, et les trois faux positifs identifiés sur cette
// campagne étaient tous vérifiables en ouvrant le fichier cité. Aucun tri ne
// peut faire ça ; un passage de modèle avec le dépôt sous la main, si.
//
// Trois choix de conception à connaître :
//
// 1. L'arbitre SÉLECTIONNE et ORDONNE, il ne REFORMULE JAMAIS. Son verdict ne
//    porte que sur des identifiants — le texte publié reste, mot pour mot,
//    celui de la passe qui a trouvé la remarque. Les meilleures explications
//    de la campagne sont les plus longues et les plus précises : un arbitre
//    qui réécrit les perdrait. Il peut en revanche corriger la SÉVÉRITÉ, une
//    remarque juste mais mal classée par le modèle qui l'a trouvée méritant
//    parfois mieux (et l'inverse aussi).
//
// 2. Le silence vaut CONSERVATION. Une remarque qu'aucune décision ne nomme
//    est gardée. Un verdict partiel — le cas le plus probable quand un modèle
//    fatigue — ne doit jamais supprimer ce qu'il n'a pas examiné.
//
// 3. Rien n'est jamais bloquant. `undefined` signifie « pas d'arbitrage » :
//    option coupée, une seule passe, ou échec du passage. La revue publie
//    alors exactement ce qu'elle aurait publié sans arbitre. Le taux de
//    passes perdues mesuré va de 22 % à 67 % selon les runs — un quatrième
//    appel est un quatrième point de perte, et c'est la règle qui a déjà
//    guidé trois correctifs de ce projet (tests-failing, relecture croisée,
//    extracteur de secours).
//
// Note sur le cycle d'import review.ts ↔ arbiter.ts : il est sans effet ici,
// aucun des deux modules ne LIT une liaison de l'autre pendant son évaluation
// (que des définitions de fonctions et de constantes, consommées à l'appel).
// C'est la même dépendance que chained-review.ts a déjà sur review.ts, dans
// l'autre sens.

/** Décision de l'arbitre sur UNE remarque, désignée par son numéro. */
export interface ArbiterDecision {
  /** Numéro affiché dans le prompt, 1-indexé. */
  id: number;
  keep: boolean;
  /** Reclassement optionnel — ignoré s'il ne tombe pas dans le barème. */
  severity?: string;
}

export interface ArbiterOutcome {
  /** Remarques conservées, dans l'ordre décidé par l'arbitre. */
  kept: AggregatedRemark[];
  /** Remarques écartées — jamais perdues, voir ReviewResult.arbiterDropped. */
  dropped: AggregatedRemark[];
  /** Nombre de remarques dont la sévérité a effectivement changé. */
  reclassified: number;
}

/**
 * L'arbitrage n'a de sens qu'à plusieurs passes : sur une passe unique il n'y
 * a rien à arbitrer entre des tirages, et ce serait un appel de modèle de plus
 * pour rien. Le drapeau ne peut donc que DÉSACTIVER, jamais forcer.
 *
 * Exportée pour être testée unitairement (voir arbiter.test.ts).
 */
export function arbiterEnabled(reviewPasses: number, flag: boolean): boolean {
  return reviewPasses > 1 && flag;
}

/**
 * Prompt de l'arbitre. Le texte des remarques vient du modèle, qui a lui-même
 * lu un diff non fiable : il passe par escapeDelimiters, comme partout
 * ailleurs. Il n'est pas enveloppé dans un bloc « DONNEES NON FIABLES » — ce
 * bloc dit au modèle de n'y obéir en rien, alors que tout l'objet de ce
 * passage est justement de les juger.
 *
 * Exportée pour être testée unitairement (voir arbiter.test.ts).
 */
export function buildArbiterPrompt(remarks: AggregatedRemark[]): string {
  const listed = remarks.map((remark, index) => {
    const where =
      remark.position === null
        ? `${remark.file.new_path} (fichier entier)`
        : `${remark.file.new_path}:${remark.position.newLine}`;
    return `${index + 1}. [${remark.severity}] ${where}\n   ${escapeDelimiters(remark.message)}`;
  });

  return [
    `Plusieurs relectures de la même merge request ont produit les remarques ci-dessous.`,
    `Le dépôt complet est cloné dans le répertoire de travail. Ta tâche : dire lesquelles méritent d'être publiées.`,
    `## Remarques à arbitrer\n${listed.join("\n\n")}`,
    `## Méthode`,
    `Pour CHAQUE remarque, ouvre le fichier cité et va lire la ligne indiquée et ce qui l'entoure. Ne juge jamais sur le seul énoncé de la remarque : plusieurs d'entre elles décrivent un code qui ne se comporte pas comme elles l'affirment.`,
    `Écarte une remarque quand le code contredit ce qu'elle affirme, ou quand elle décrit un comportement qui n'existe pas. Garde-la quand elle décrit un défaut réel, même mineur, et garde-la aussi en cas de doute : écarter à tort coûte plus cher que publier une remarque discutable.`,
    `Tu ne réécris AUCUN message : ton verdict ne porte que sur les numéros ci-dessus. Tu peux en revanche corriger la sévérité d'une remarque que tu gardes ("error" = comportement faux, "warning" = risque réel mais conditionnel, "info" = remarque mineure).`,
    `L'ordre dans lequel tu listes les remarques gardées est l'ordre dans lequel elles seront publiées : mets en premier ce qu'un relecteur doit voir en premier.`,
    `Quand ton analyse est terminée, termine ta réponse par ce JSON et rien après :`,
    `{"verdict":[{"id":1,"keep":true,"severity":"error"},{"id":2,"keep":false}]}`,
    `Le champ severity est facultatif : ne le mets que si tu changes le classement. Chaque numéro de 1 à ${remarks.length} doit apparaître exactement une fois.`,
  ].join("\n\n");
}

/**
 * Frontière de confiance, même exigence que parseRemark (review.ts) : le JSON
 * de l'arbitre est vérifié champ par champ. Une entrée illisible est ignorée
 * plutôt que de faire échouer le verdict entier — sinon un seul élément mal
 * formé renverrait toute la revue au repli.
 *
 * Exportée pour être testée unitairement (voir arbiter.test.ts).
 */
export function parseArbiterVerdict(
  raw: unknown,
): { decisions: ArbiterDecision[] } | { rejected: string } {
  if (typeof raw !== "object" || raw === null)
    return { rejected: "verdict absent ou non-objet" };

  const verdict = (raw as { verdict?: unknown }).verdict;
  if (!Array.isArray(verdict))
    return { rejected: 'JSON sans tableau "verdict"' };

  const decisions: ArbiterDecision[] = [];
  for (const entry of verdict) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as Record<string, unknown>;

    const rawId = value.id;
    const id = typeof rawId === "string" ? Number(rawId) : rawId;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) continue;

    // `keep` absent vaut CONSERVATION : un arbitre qui liste une remarque sans
    // se prononcer ne l'écarte pas.
    const keep = value.keep === false ? false : true;

    const severity =
      typeof value.severity === "string" ? value.severity : undefined;

    decisions.push({ id, keep, ...(severity === undefined ? {} : { severity }) });
  }

  return { decisions };
}

/**
 * Applique un verdict à la liste arbitrée. Fonction PURE, et c'est le cœur de
 * la sûreté de ce chantier : toutes les règles de non-perte sont ici, donc
 * testables sans modèle.
 *
 * - une remarque qu'AUCUNE décision ne nomme est gardée ;
 * - un identifiant hors bornes est ignoré ;
 * - une décision répétée sur le même identifiant : la PREMIÈRE fait foi ;
 * - une sévérité hors barème est ignorée, la remarque garde la sienne (on
 *   passe par normalizeSeverity, donc "bug" est traduit en "error", mais une
 *   valeur inventée ne dégrade jamais un classement existant) ;
 * - l'ordre des gardées suit celui du verdict ; les remarques non nommées
 *   suivent, dans leur ordre d'origine.
 *
 * Exportée pour être testée unitairement (voir arbiter.test.ts).
 */
export function applyArbiterVerdict(
  remarks: AggregatedRemark[],
  decisions: ArbiterDecision[],
): ArbiterOutcome {
  const byId = new Map<number, ArbiterDecision>();
  for (const decision of decisions) {
    if (decision.id > remarks.length) continue;
    if (!byId.has(decision.id)) byId.set(decision.id, decision);
  }

  const kept: AggregatedRemark[] = [];
  const dropped: AggregatedRemark[] = [];
  const decided = new Set<number>();
  let reclassified = 0;

  // 1. Ce que l'arbitre a nommé, dans SON ordre.
  for (const decision of decisions) {
    if (byId.get(decision.id) !== decision) continue;
    const remark = remarks[decision.id - 1];
    if (!remark) continue;
    decided.add(decision.id);

    if (!decision.keep) {
      dropped.push(remark);
      continue;
    }

    const { severity, unknown } = normalizeSeverity(decision.severity);
    const changed =
      decision.severity !== undefined &&
      unknown === undefined &&
      severity !== remark.severity;
    if (changed) reclassified++;
    kept.push(changed ? { ...remark, severity } : remark);
  }

  // 2. Ce qu'il n'a pas nommé : conservé, dans l'ordre d'origine.
  remarks.forEach((remark, index) => {
    if (!decided.has(index + 1)) kept.push(remark);
  });

  return { kept, dropped, reclassified };
}

/**
 * Exécute l'arbitrage. Ne jette JAMAIS : `undefined` signifie « pas
 * d'arbitrage » (option coupée, une seule passe, liste vide, ou échec du
 * passage — journalisé), auquel cas l'appelant publie exactement ce qu'il
 * aurait publié sans arbitre.
 */
export async function runArbiter(
  repo: string,
  meta: string,
  projectPath: string,
  remarks: AggregatedRemark[],
): Promise<ArbiterOutcome | undefined> {
  if (!arbiterEnabled(config.reviewPasses, config.reviewArbiter))
    return undefined;
  // Rien à arbitrer : on s'épargne un appel de modèle plutôt que de demander
  // un verdict sur une liste vide.
  if (remarks.length === 0) return undefined;

  try {
    const prompt = buildArbiterPrompt(remarks);

    let result: AgentResult;
    if (config.useDocker) {
      writeFileSync(join(meta, "prompt.txt"), prompt, "utf8");
      // Lecture seule : l'arbitre juge des remarques sur le code, il n'a
      // aucune raison de pouvoir le modifier (voir permissionsFor).
      result = await runAgentInSandbox(repo, meta, projectPath, {
        mode: "review",
      });
    } else {
      result = await runAgent(repo, prompt);
    }

    if (result.timedOut)
      throw new Error(`interrompu après ${config.agentTimeoutMs / 60_000} min`);

    const raw = extractJson(result.stdout, "verdict");
    if (!raw) throw new Error(`aucun JSON exploitable (code ${result.code})`);

    const parsed = parseArbiterVerdict(JSON.parse(raw));
    if ("rejected" in parsed) throw new Error(parsed.rejected);

    return applyArbiterVerdict(remarks, parsed.decisions);
  } catch (error) {
    log.warn(
      `[revue] arbitre en échec (${(error as Error).message}) — ` +
        `repli sur le tri par sévérité, rien n'est perdu`,
    );
    return undefined;
  }
}
