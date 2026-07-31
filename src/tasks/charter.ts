import {
  repoCapabilitiesFor,
  type IssueCapabilities,
  type MergeRequestCapabilities,
  type ResolvedCapabilities,
} from "../projects.ts";
import type { ResourceKind } from "../types.ts";

// ---------------------------------------------------------------------------
// Chantier "planificateur" — la charte
// ---------------------------------------------------------------------------
//
// Un méta-prompt décrivant, en langage naturel, ce que le bot a le droit de
// PROPOSER sur ce dépôt : c'est ce que tasks/planner.ts remet au modèle
// planificateur avant de lui demander de rédiger un plan (intent + prompt
// destiné à l'agent exécutant). Trois propriétés non négociables :
//
// 1. GÉNÉRÉE, jamais écrite à la main en parallèle : chaque phrase de la
//    charte est dérivée d'un champ de `ResolvedCapabilities` (voir
//    src/projects.ts), lui-même résolu depuis projects.json. Aucune capacité
//    n'est mentionnée ici qu'un humain aurait pu oublier de refléter — ce qui
//    empêche structurellement la charte et projects.json de diverger, à la
//    différence d'un texte figé qu'on aurait à retenir de mettre à jour à
//    chaque changement de capacité.
// 2. Un TEXTE, jamais une PERMISSION : cette charte est lue par le modèle
//    planificateur, un texte non fiable comme n'importe quel prompt (voir le
//    principe directeur du chantier, rapport de la tâche). Le plan qu'elle
//    aide à produire est revalidé indépendamment côté daemon
//    (tasks/router.ts::refuseRequestedCapabilities, intentRefusalReason) en
//    relisant directement les mêmes `ResolvedCapabilities` — jamais en
//    reparcourant le texte de cette charte. Un modèle qui ignorerait cette
//    charte (ou serait convaincu par une injection de l'ignorer) ne gagne
//    donc rien : la validation ne lui fait de toute façon aucune confiance.
// 3. Des règles UNIVERSELLES, qui ne dépendent d'aucune capacité déclarée
//    dans projects.json car aucune capacité n'accorde jamais ces
//    comportements (voir UNIVERSAL_RULES) : fusionner soi-même la merge
//    request, forcer un push, réécrire l'historique. Rappelées à chaque
//    charte plutôt que conditionnées à une entrée du fichier — il n'existe
//    tout simplement pas de "canMerge" dans projects.json.
// ---------------------------------------------------------------------------

const UNIVERSAL_RULES: readonly string[] = [
  "Tu ne dois JAMAIS fusionner (merger) la merge request toi-même, quelle que soit la demande — cette décision revient toujours à un humain.",
  "Tu ne dois jamais forcer un push, réécrire l'historique existant (amend, rebase, reset), ni modifier la configuration git ou les hooks.",
  "Cette charte décrit ce que tu as le droit de PROPOSER : elle n'accorde rien par elle-même, le daemon vérifie indépendamment ce que tu produis avant de l'exécuter et après coup.",
];

function describeGrant(granted: boolean, capability: string, allowed: string, forbidden: string): string {
  return granted
    ? `${allowed} (capacité "${capability}" accordée).`
    : `${forbidden} (capacité "${capability}" non accordée).`;
}

/**
 * Charte pour une demande portant sur une MERGE REQUEST — le seul flux
 * réellement câblé aujourd'hui (voir tasks/router.ts, qui refuse toute cible
 * qui n'est pas une merge request avant même d'appeler le planificateur).
 */
function buildMergeRequestCharter(mr: MergeRequestCapabilities): string {
  const repo = repoCapabilitiesFor(mr);
  const lines: string[] = [...UNIVERSAL_RULES];

  lines.push(
    describeGrant(
      mr.review,
      "review",
      "Tu peux relire le code de cette merge request et proposer des remarques de revue (aucune écriture)",
      "Tu n'as PAS le droit de faire une revue de code sur ce dépôt",
    ),
  );
  lines.push(
    describeGrant(
      mr.writeTests,
      "writeTests",
      "Tu peux écrire ou modifier des tests automatisés",
      "Tu n'as PAS le droit d'écrire ni de modifier le moindre test",
    ),
  );
  lines.push(
    describeGrant(
      mr.writeBusinessCode,
      "writeBusinessCode",
      "Tu peux modifier le code source de l'application, pas seulement les tests",
      "Tu n'as PAS le droit de modifier le code source de l'application — seuls des tests peuvent l'être, si cette capacité est accordée par ailleurs",
    ),
  );

  // writablePaths ("all"/"tests-only"/"none" ne rajoutent rien à ce que les
  // trois phrases ci-dessus disent déjà — seul l'entre-deux "motifs" apporte
  // une information supplémentaire).
  if (Array.isArray(repo.writablePaths)) {
    lines.push(
      `Tu peux aussi modifier les chemins suivants, en plus des tests : ${repo.writablePaths.join(", ")}.`,
    );
  }

  lines.push(
    mr.pushToSourceBranch
      ? "Une fois les tests validés, le résultat peut être poussé directement sur la branche source de la merge request."
      : "Le résultat ne sera jamais poussé directement sur la branche source : il sera proposé via une merge request dédiée, à faire relire par un humain avant fusion.",
  );

  return lines.map((line) => `- ${line}`).join("\n");
}

/**
 * Charte pour une demande portant sur une ISSUE. Non câblée à aucun
 * comportement aujourd'hui (voir src/projects.ts::IssueCapabilities et
 * tasks/router.ts, qui refuse toute cible qui n'est pas une merge request
 * avant même d'appeler le planificateur) — conservée pour que
 * buildCharter() reste une fonction totale sur ResourceKind, testable
 * indépendamment de ce qui est câblé, et prête sans changement de schéma le
 * jour où les issues seront prises en charge.
 */
function buildIssueCharter(issue: IssueCapabilities): string {
  const lines: string[] = [...UNIVERSAL_RULES];

  lines.push(
    describeGrant(
      issue.review,
      "review",
      "Tu peux analyser ce ticket et proposer une revue (aucune écriture)",
      "Tu n'as PAS le droit de faire une revue sur ce dépôt",
    ),
  );
  lines.push(
    describeGrant(
      issue.createMergeRequest,
      "createMergeRequest",
      "Tu peux proposer l'ouverture d'une merge request à partir de ce ticket",
      "Tu n'as PAS le droit de proposer l'ouverture d'une merge request",
    ),
  );
  lines.push(
    describeGrant(
      issue.writeTests,
      "writeTests",
      "Tu peux écrire ou modifier des tests automatisés",
      "Tu n'as PAS le droit d'écrire ni de modifier le moindre test",
    ),
  );
  lines.push(
    describeGrant(
      issue.writeBusinessCode,
      "writeBusinessCode",
      "Tu peux modifier le code source de l'application, pas seulement les tests",
      "Tu n'as PAS le droit de modifier le code source de l'application",
    ),
  );

  return lines.map((line) => `- ${line}`).join("\n");
}

/**
 * Génère la charte remise au planificateur (tasks/planner.ts) pour un type
 * de cible donné — voir l'en-tête de ce fichier pour les trois propriétés
 * non négociables (générée, texte non contraignant, règles universelles).
 * Exportée séparément de planner.ts pour être testée sans dépendre de
 * l'exécution d'un agent (voir charter.test.ts).
 */
export function buildCharter(kind: ResourceKind, capabilities: ResolvedCapabilities): string {
  return kind === "merge_requests"
    ? buildMergeRequestCharter(capabilities.mergeRequest)
    : buildIssueCharter(capabilities.issue);
}
