import { buildContext } from "./context.ts";
import { config } from "../config.ts";
import { gitlab } from "../gitlab/client.ts";
import { publishReview } from "./publish.ts";
import { runReview } from "./review.ts";
import { runImplement, type ImplementResult } from "./implement.ts";
import { describeCapabilities, isDefaultCapabilities } from "./guard.ts";
import { repoCapabilitiesFor, type ResolvedCapabilities, type ResolvedProject } from "../projects.ts";
import {
  runPlanner,
  type Plan,
  type PlanFailure,
  type PlanSuccess,
  type RequestableCapability,
} from "./planner.ts";
import { defuseMentions } from "../daemon/request.ts";
import type { AckHandle, AgentRequest, MergeRequestContext, ResourceKind } from "../types.ts";
import { TESTS_RED_REPORT_TAIL_CHARS } from "../limits.ts";
import { log } from "../log.ts";

export type Intent = "review" | "implement" | "unknown";

/** Échappe les caractères significatifs pour une regex, avant d'y insérer BOT_USERNAME (voir explicitCommand). */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * §6.9 : commande explicite, seule forme réellement fiable — elle l'emporte
 * toujours sur le repli par mots-clés ci-dessous (voir detectIntent). Cherchée
 * juste après la mention du bot (« @bot review », « @bot implement-tests »,
 * en tolérant un peu de ponctuation ou d'espace entre les deux), pas
 * n'importe où dans le texte : request.text contient la mention et
 * potentiellement beaucoup de texte autour (une description entière, un fil
 * cité) — un mot isolé comme "review" ailleurs dans ce texte ne doit pas
 * suffire à déclencher une commande, seule une syntaxe de commande immédiatement
 * après la mention le peut.
 */
function explicitCommand(text: string, botUsername: string): Intent | null {
  const re = new RegExp(
    `@${escapeRegExp(botUsername)}\\b[\\s:,.-]*\\b(review|implement-tests)\\b`,
    "i",
  );
  const match = re.exec(text);
  if (!match?.[1]) return null;
  return match[1].toLowerCase() === "review" ? "review" : "implement";
}

// §6.9 : repli historique par mots-clés (compatibilité avec les demandes en
// langage naturel), corrigé sur deux points par rapport à l'original : les
// deux motifs sont désormais recherchés indépendamment du texte alentour
// (inchangé), mais leur priorité est inversée et rendue mutuellement
// exclusive — voir fallbackIntent.
const REVIEW_WORDS_RE = /review|revue|relis|relire|relecture/;
const IMPLEMENT_VERBS_RE = /impl[ée]ment|[ée]cri|ajoute|cr[ée]e|write|add/;
const TESTS_WORD_RE = /\btests?\b/;

/**
 * Repli mots-clés (§6.9) : ordre inversé par rapport à l'ancien code — review
 * est vérifié en premier, parce que c'est l'action sans risque d'écriture
 * (poster des commentaires), contrairement à implement (pousse du code sur
 * la branche source). Un message qui mentionne à la fois une revue et des
 * tests (« fais une review et dis-moi si les tests écrits sont bons ») est
 * donc toujours classé review, jamais implement, même si le vocabulaire des
 * deux motifs est présent dans la même phrase — c'est exactement le cas qui
 * partait en implement (et donc en push) avec l'ancien ordre.
 *
 * La condition `!hasReview` sur la branche implement est toujours vraie ici
 * (on ne l'atteint que si la branche review au-dessus n'a pas déjà renvoyé) :
 * elle n'est pas nécessaire au comportement actuel, mais l'exprimer
 * explicitement documente l'intention et protège d'une régression si les deux
 * blocs sont un jour repermutés par erreur — exiger l'absence du mot-clé
 * concurrent plutôt que de compter uniquement sur l'ordre des `if`.
 */
function fallbackIntent(normalized: string): Intent {
  const hasReview = REVIEW_WORDS_RE.test(normalized);
  if (hasReview) return "review";

  const hasImplementWords =
    TESTS_WORD_RE.test(normalized) && IMPLEMENT_VERBS_RE.test(normalized);
  if (hasImplementWords && !hasReview) return "implement";

  return "unknown";
}

/** Exportée pour être testée unitairement (voir router.test.ts) : fonction pure, aucune dépendance réseau. */
export function detectIntent(text: string, botUsername: string): Intent {
  const explicit = explicitCommand(text, botUsername);
  if (explicit) return explicit;
  return fallbackIntent(text.toLowerCase());
}

/**
 * Chantier "projects.json" : refuse une intention détectée si la capacité
 * correspondante n'est pas accordée POUR LE TYPE DE CIBLE de la demande
 * (issue ou merge request — voir src/projects.ts::ResolvedCapabilities).
 * Remplace le comportement précédent, où seul writablePaths="tests-only"
 * par défaut limitait ce que l'agent pouvait PRODUIRE une fois lancé : ici,
 * l'intention est refusée AVANT même de cloner le dépôt ou de lancer
 * l'agent, avec un message qui dit pourquoi. `null` : l'intention est
 * permise. Fonction pure, testée directement (voir router.test.ts) sans
 * dépendance réseau.
 */
export function intentRefusalReason(
  kind: ResourceKind,
  intent: Exclude<Intent, "unknown">,
  capabilities: ResolvedCapabilities,
): string | null {
  const forTarget = kind === "merge_requests" ? capabilities.mergeRequest : capabilities.issue;

  if (intent === "review") {
    return forTarget.review
      ? null
      : 'la revue n\'est pas activée pour ce dépôt (capacité "review" absente de projects.json)';
  }

  // intent === "implement"
  return forTarget.writeTests || forTarget.writeBusinessCode
    ? null
    : 'aucune capacité d\'écriture n\'est accordée pour ce dépôt (ni "writeTests" ni "writeBusinessCode" dans projects.json)';
}

/**
 * Chantier "planificateur" : le plan peut réclamer explicitement des
 * capacités (Plan.requestedCapabilities), en plus de l'intention elle-même —
 * une granularité qu'intentRefusalReason ci-dessus n'offre pas (elle ne sait
 * dire que "review" ou "writeTests OU writeBusinessCode" suffisent à
 * l'intention). Vérifie CHAQUE capacité réclamée contre ce que projects.json
 * accorde réellement pour ce type de cible — jamais contre le texte du plan
 * lui-même (son "reason", potentiellement influencé par une injection dans
 * le ticket lié ou la description de la MR, n'entre pour rien dans cette
 * décision : voir router.test.ts, le test qui compte le plus dans ce
 * chantier). `null` : toutes les capacités réclamées sont accordées.
 */
export function refuseRequestedCapabilities(
  kind: ResourceKind,
  requestedCapabilities: readonly RequestableCapability[],
  capabilities: ResolvedCapabilities,
): string | null {
  const forTarget = kind === "merge_requests" ? capabilities.mergeRequest : capabilities.issue;
  const missing = requestedCapabilities.filter((capability) => !forTarget[capability]);
  if (missing.length === 0) return null;
  return `le plan demande ${missing.length > 1 ? "des capacités non accordées" : "une capacité non accordée"} pour ce dépôt : ${missing.join(", ")}`;
}

/**
 * Message affiché quand ni une commande explicite, ni le repli par
 * mots-clés, ni le planificateur (s'il a été appelé) n'ont permis d'identifier
 * une intention exploitable — inchangé au caractère près par rapport à ce
 * que runTask() postait directement avant le chantier "planificateur" (voir
 * resolveIntent ci-dessous), extrait en constante pour être réutilisé aux
 * deux endroits qui peuvent désormais y mener.
 */
const UNKNOWN_INTENT_MESSAGE =
  "Je n'ai pas compris la demande. Utilisez une commande explicite : " +
  "« @bot review » pour relire la MR, ou « @bot implement-tests » pour " +
  "écrire des tests. À défaut, une formulation sans ambiguïté en langage " +
  "naturel fonctionne aussi (« fais une review de cette MR », « implémente " +
  "les tests ») — mais la commande explicite est plus fiable et reste " +
  "prioritaire si les deux sont présentes.";

/**
 * Fonction injectée pour appeler le planificateur — voir resolveIntent.
 * Paramétrée (plutôt qu'un appel direct à runPlanner) pour que resolveIntent
 * reste testable sans agent ni Docker réels (voir router.test.ts) : les
 * tests substituent une fonction qui renvoie un plan fabriqué, ou un échec,
 * sans jamais lancer de vrai sous-processus.
 */
export type PlannerFn = (
  context: MergeRequestContext,
  project: ResolvedProject,
) => Promise<PlanSuccess | PlanFailure>;

export interface IntentDecision {
  /** true : l'intention est exécutable (capacités déjà validées ci-dessous, à l'exception du contrôle final identique au chemin déterministe — voir runTask). */
  execute: boolean;
  intent: Intent;
  /**
   * Texte à utiliser comme `requestText` pour l'agent exécutant : le texte
   * original de la demande sur le chemin déterministe (commande explicite ou
   * repli par mots-clés), le `prompt` rédigé par le planificateur sinon.
   * Toujours défini, y compris quand `execute` vaut false (les appelants qui
   * ignorent la décision n'ont pas à le vérifier séparément).
   */
  requestText: string;
  /** true si le planificateur a été appelé pour produire cette décision (jamais pour le chemin déterministe). */
  usedPlanner: boolean;
  /** Renseigné quand `execute` vaut false ET que ce n'est pas le refus générique "unknown" (voir runTask) : le motif à publier, nommant la capacité manquante. */
  refusal?: string;
  /** "reason" du plan, quand le planificateur a produit un plan "unknown" — republié best-effort pour aider le demandeur (voir runTask). */
  plannerReason?: string;
}

/**
 * Chantier "planificateur" : remplace l'appel direct à detectIntent() dans
 * runTask(). Le chemin déterministe (commande explicite « @bot review »/
 * « @bot implement-tests », puis repli par mots-clés — voir detectIntent)
 * reste la première chose vérifiée et continue de fonctionner SANS aucun
 * appel au modèle : c'est un chemin fiable, déjà testé, qui ne coûte rien —
 * le court-circuiter reviendrait à payer un appel de modèle pour une demande
 * qui n'en avait pas besoin. Le planificateur n'est invoqué qu'en dernier
 * recours, quand cette détection ne tranche pas (`detectIntent` renvoie
 * "unknown" — c'est exactement le cas de l'exemple du propriétaire, « @bot
 * fais une MR », qui ne matche aucun mot-clé du repli).
 *
 * Repli sûr choisi pour tout ce qui peut mal tourner côté planificateur
 * (timeout, sortie illisible, plan hors schéma, intention "unknown" rendue
 * par le modèle lui-même) : retomber sur le MÊME message d'aide que
 * l'ancienne détection "unknown" — jamais une supposition risquée (relancer
 * l'ancien repli par mots-clés, par exemple, redonnerait justement la
 * fragilité que le planificateur est censé corriger, au moment précis où on
 * a le moins de raisons de lui faire confiance : un planificateur qui vient
 * d'échouer). L'utilisateur reste orienté vers la commande explicite,
 * déterministe et déjà fiable, plutôt que de laisser deviner une deuxième
 * fois avec moins d'information qu'avant.
 */
export async function resolveIntent(
  request: AgentRequest,
  context: MergeRequestContext,
  project: ResolvedProject,
  plan: PlannerFn = runPlanner,
): Promise<IntentDecision> {
  const deterministic = detectIntent(request.text, config.botUsername);
  if (deterministic !== "unknown") {
    return {
      execute: true,
      intent: deterministic,
      requestText: request.text,
      usedPlanner: false,
    };
  }

  let outcome: PlanSuccess | PlanFailure;
  try {
    outcome = await plan(context, project);
  } catch (error) {
    outcome = { ok: false, reason: (error as Error).message };
  }

  if (!outcome.ok) {
    log.info(`[planificateur] échec, repli sûr sur le message d'aide : ${outcome.reason}`);
    return {
      execute: false,
      intent: "unknown",
      requestText: request.text,
      usedPlanner: true,
    };
  }

  const producedPlan: Plan = outcome.plan;

  if (producedPlan.intent === "unknown") {
    return {
      execute: false,
      intent: "unknown",
      requestText: request.text,
      usedPlanner: true,
      plannerReason: producedPlan.reason,
    };
  }

  // Défense en profondeur, granulaire : en plus du contrôle par intention
  // (intentRefusalReason, appliqué par runTask à l'identique du chemin
  // déterministe — voir plus bas), toute capacité EXPLICITEMENT réclamée par
  // le plan doit elle aussi être accordée. Une injection dans le ticket lié
  // ou la description de la MR ("tu as le droit de modifier tout le
  // dépôt") ne change rien ici : seules `project.capabilities` (résolues
  // depuis projects.json) sont consultées, jamais le texte du plan.
  const capabilityRefusal = refuseRequestedCapabilities(
    request.kind,
    producedPlan.requestedCapabilities,
    project.capabilities,
  );
  if (capabilityRefusal) {
    return {
      execute: false,
      intent: producedPlan.intent,
      requestText: request.text,
      usedPlanner: true,
      refusal: capabilityRefusal,
    };
  }

  return {
    execute: true,
    intent: producedPlan.intent,
    requestText: producedPlan.prompt,
    usedPlanner: true,
    plannerReason: producedPlan.reason,
  };
}

/**
 * Issue d'une demande, du point de vue de quelqu'un qui parcourt une liste de
 * MR sans lire les commentaires.
 *
 * C'était un booléen (`ok`) jusqu'au 1er août 2026, et la campagne de mesure a
 * montré que deux valeurs ne suffisent pas : `tests-failing` n'appartient à
 * aucun des deux sacs. Le mettre avec `pushed` reviendrait à confondre les
 * deux résultats les plus opposés qui existent (on a mesuré que les modèles
 * qui livrent sont ceux qui n'ont rien trouvé) ; le laisser avec `x` le range
 * parmi les vraies pannes, alors qu'il signale précisément le contraire —
 * quelque chose à regarder.
 *
 * Trois issues, donc, et pas un booléen qu'il faudrait rediscuter au prochain
 * statut ajouté :
 * - "delivered" : livré, suite verte (pushed, mr-opened) ;
 * - "to-triage" : rien n'est livré, mais il y a une décision humaine à
 *   prendre — c'est un résultat, pas une panne ;
 * - "failed"    : échec réel (install cassé, suite déjà rouge, refus, erreur).
 */
export type TaskOutcome = "delivered" | "to-triage" | "failed";

/**
 * L'API award emoji accepte n'importe quel nom de la table gemoji : rien
 * n'obligeait à se limiter à deux réactions.
 */
const OUTCOME_EMOJI: Record<TaskOutcome, string> = {
  delivered: "white_check_mark",
  "to-triage": "mag",
  failed: "x",
};

/**
 * §6.10 : fait évoluer la réaction 👀 (posée par daemon/index.ts::acknowledge())
 * vers ✅, 🔍 ou ❌ selon l'issue de la tâche. L'API award emoji ne propose pas
 * de mise à jour en place : on supprime l'ancienne réaction (si elle a pu être
 * posée, voir AckHandle.awardId) avant d'en poser une nouvelle. Best-effort,
 * comme l'accusé de réception initial : un échec ici ne doit jamais faire
 * perdre le résultat déjà publié par report() ci-dessous.
 */
async function evolveReaction(
  request: AgentRequest,
  ack: AckHandle,
  outcome: TaskOutcome,
): Promise<void> {
  const { projectId, kind, iid, noteId } = request;
  const emoji = OUTCOME_EMOJI[outcome];

  try {
    if (ack.awardId !== null) {
      if (noteId === null) {
        await gitlab.deleteAwardOnResource(projectId, kind, iid, ack.awardId);
      } else {
        await gitlab.deleteAwardOnNote(projectId, kind, iid, noteId, ack.awardId);
      }
    }
    if (noteId === null) {
      await gitlab.awardOnResource(projectId, kind, iid, emoji);
    } else {
      await gitlab.awardOnNote(projectId, kind, iid, noteId, emoji);
    }
  } catch (error) {
    log.warn(
      `évolution de la réaction emoji impossible : ${(error as Error).message}`,
    );
  }
}

/**
 * §6.10 : édite l'accusé de réception (request.ack) plutôt que de poster une
 * nouvelle note, pour qu'une seule note porte le statut vivant de la demande
 * — voir daemon/index.ts::acknowledge() pour la pose initiale de cette note
 * et de sa réaction 👀. L'identifiant a circulé via AgentRequest (voir
 * types.ts, AckHandle) : acknowledge() et report() ne se connaissaient pas
 * avant ce chantier, c'est ce champ qui les relie.
 *
 * Si l'édition échoue (note supprimée entre-temps par un humain, par
 * exemple) : le résultat n'est pas perdu, on republie une note neuve — sans
 * ack (dry-run, anciens appels), report() se comporte comme avant ce
 * chantier, une simple création.
 */
export async function report(
  request: AgentRequest,
  body: string,
  outcome: TaskOutcome,
): Promise<void> {
  const fullBody = `${body}\n\n<sub>cds-agent</sub>`;

  if (request.ack) {
    try {
      await gitlab.updateNote(
        request.projectId,
        request.kind,
        request.iid,
        request.ack.ackNoteId,
        fullBody,
      );
      await evolveReaction(request, request.ack, outcome);
      return;
    } catch (error) {
      log.warn(
        `édition de l'accusé de réception impossible (${(error as Error).message}) — ` +
          `note peut-être supprimée entre-temps : republication d'une nouvelle note`,
      );
    }
  }

  await gitlab.createNote(request.projectId, request.kind, request.iid, fullBody);
  if (request.ack) await evolveReaction(request, request.ack, outcome);
}

/**
 * Compte rendu du statut "tests-failing" : la baseline était verte, l'agent
 * n'a touché que des fichiers autorisés, et son assertion n'est pas
 * satisfaite par le code.
 *
 * Ce rapport publie le CONTENU des fichiers écrits, pas seulement le message
 * d'échec — c'est toute la différence entre « le bot est tombé en panne » et
 * « le bot a peut-être trouvé un défaut, voici l'assertion, tranchez ». Le
 * workspace est détruit juste après runImplement : ce commentaire est le seul
 * endroit où ce travail continue d'exister.
 *
 * Tout ce qui vient de l'agent ou du dépôt traverse defuseMentions() avant
 * republication, y compris le contenu des fichiers : un test écrit par un LLM
 * peut parfaitement contenir « @tout-le-monde » ou une quick action GitLab
 * dans un commentaire ou une chaîne (même logique qu'en publish.ts, §5.6).
 */
function buildTestsFailingReport(
  result: ImplementResult,
  seconds: number,
): string {
  const preamble = [
    `⚠️ **À trancher** — en ${seconds} s, ${defuseMentions(result.detail)}.`,
    `La suite de référence était verte avant intervention et seuls des fichiers autorisés ont été modifiés : soit l'assertion est fausse, soit elle a mis au jour un défaut du code. Rien n'a été poussé sur la branche source.`,
  ];

  // Chemin nominal : le travail est préservé dans une MR dédiée en Draft, et
  // son diff EST le rapport. Inutile de recopier le contenu des fichiers ici
  // — le lien vaut mieux qu'un commentaire de plusieurs centaines de lignes.
  if (result.mrUrl) {
    return [
      ...preamble,
      `📝 Les tests écrits sont préservés dans une merge request **Draft** : ${result.mrUrl}`,
      `Comparez son diff au code testé, puis fusionnez (l'assertion était juste, le défaut est réel) ou fermez (l'assertion était fausse).`,
    ].join("\n\n");
  }

  // Repli : l'ouverture de la MR a échoué. Le contenu part dans le
  // commentaire, ce qui reste très préférable à une perte sèche — le
  // workspace, lui, est déjà détruit.
  const artifacts = (result.artifacts ?? [])
    .map(
      (artifact) =>
        `<details><summary>${defuseMentions(artifact.path)}</summary>\n\n\`\`\`\n${defuseMentions(artifact.content)}\n\`\`\`\n\n</details>`,
    )
    .join("\n");

  const output = result.output
    ? `<details><summary>Sortie de la suite</summary>\n\n\`\`\`\n${defuseMentions(result.output.slice(-TESTS_RED_REPORT_TAIL_CHARS))}\n\`\`\`\n\n</details>`
    : "";

  return [...preamble, output, artifacts].filter(Boolean).join("\n\n");
}

/**
 * Section « relecture croisée » du rapport d'une implémentation livrée.
 * La distinction undefined/[] vient d'ImplementResult.chainedFindings :
 * `undefined` = pas de relecture (option coupée ou passage en échec), rien à
 * afficher — le rapport ne doit pas prétendre qu'une vérification a eu lieu ;
 * `[]` = elle a tourné et n'a rien trouvé, ce qui se dit explicitement.
 */
function chainedReviewNote(result: ImplementResult): string {
  const findings = result.chainedFindings;
  if (findings === undefined) return "";
  if (findings.length === 0) {
    return "\n\n🔎 Relecture croisée : rien à signaler sur les tests livrés.";
  }
  const lines = findings.map(
    (finding) =>
      `- \`${defuseMentions(finding.file)}\` : ${defuseMentions(finding.message)}`,
  );
  return (
    "\n\n🔎 **Relecture croisée** — la suite est verte, mais ces points méritent un œil humain avant de faire confiance aux tests :\n" +
    lines.join("\n")
  );
}

export async function runTask(request: AgentRequest): Promise<void> {
  log.info(`[worker] démarrage ${request.key}`);

  try {
    if (request.kind !== "merge_requests") {
      await report(
        request,
        "🤖 Seules les merge requests sont gérées pour l'instant.",
        "failed",
      );
      return;
    }

    const context = await buildContext(request);
    if (context.targetKind !== "merge_requests") {
      // Ne peut pas arriver en pratique : request.kind === "merge_requests"
      // ci-dessus implique que buildContext() a pris la branche MR (voir
      // context.ts). Garde-fou pour le vérificateur de types plutôt qu'un
      // cast — à partir d'ici, `context` est bien un MergeRequestContext
      // (§6.8) : sourceBranch, diffRefs et files sont garantis, plus aucune
      // vérification de nullité n'est nécessaire dans la suite de cette
      // fonction.
      throw new Error(
        "contexte incohérent : demande sur une merge request mais buildContext() a renvoyé un contexte issue",
      );
    }

    // Chantier "projects.json" : `request.project` a été résolu et figé par
    // daemon/index.ts::handle() avant même la mise en file — garanti présent
    // ici, authorize() n'ayant jamais laissé passer une demande dont le
    // projet est absent de projects.json (voir authorize.ts). Le garde-fou
    // ci-dessous protège le vérificateur de types, pas un cas réellement
    // atteignable en production. Résolu AVANT resolveIntent() : le
    // planificateur (chantier "planificateur") a besoin de la charte
    // dérivée de ces capacités pour ce dépôt précis.
    const project = request.project;
    if (!project) {
      throw new Error(
        "contexte incohérent : demande sans configuration de projet résolue (authorize() aurait dû la refuser)",
      );
    }

    // Chantier "planificateur" : remplace l'appel direct à detectIntent().
    // Le chemin déterministe (commande explicite, puis repli par mots-clés)
    // reste vérifié en premier, sans aucun appel au modèle — voir
    // resolveIntent pour la justification complète du repli sûr en cas
    // d'échec du planificateur.
    const decision = await resolveIntent(request, context, project);
    log.info(
      `[worker] intention : ${decision.intent}${decision.usedPlanner ? " (planificateur)" : " (déterministe)"}`,
    );

    if (!decision.execute) {
      const message = decision.refusal
        ? `🤖 Demande refusée : ${decision.refusal}.`
        : `🤖 ${UNKNOWN_INTENT_MESSAGE}${
            decision.plannerReason
              ? ` Le planificateur a répondu : « ${defuseMentions(decision.plannerReason)} ».`
              : ""
          }`;
      await report(request, message, "failed");
      return;
    }

    if (decision.intent === "unknown") {
      // Ne peut pas arriver en pratique : resolveIntent() ne renvoie jamais
      // execute=true avec intent="unknown" (voir son implémentation) — garde-fou
      // pour le vérificateur de types plutôt qu'un cast, comme pour
      // context.targetKind plus haut.
      throw new Error(
        "contexte incohérent : resolveIntent() a renvoyé execute=true avec une intention unknown",
      );
    }
    const intent = decision.intent;

    // Contrôle final, IDENTIQUE pour les deux chemins (déterministe ou
    // planificateur) : que l'intention vienne d'une commande explicite ou
    // d'un plan déjà validé (requestedCapabilities, voir resolveIntent),
    // cette vérification par intention reste la même que celle appliquée
    // avant le chantier "planificateur" — aucune divergence entre les deux,
    // un seul endroit qui décide "cette intention est-elle permise sur ce
    // dépôt ?".
    const refusal = intentRefusalReason(request.kind, intent, project.capabilities);
    if (refusal) {
      await report(request, `🤖 Demande refusée : ${refusal}.`, "failed");
      return;
    }

    // Chantier "planificateur" : `executionContext` ne diffère de `context`
    // que par `requestText` — le texte original de la demande sur le chemin
    // déterministe, ou le prompt rédigé par le planificateur sinon (voir
    // resolveIntent). Ce texte reste du contenu NON FIABLE, exactement comme
    // le texte brut de la demande avant ce chantier : il traverse le même
    // wrapUntrusted() que buildPrompt() (review.ts/implement.ts) appliquait
    // déjà à context.requestText — aucun nouveau canal de confiance, aucune
    // permission accordée par ce texte, l'exécution ci-dessous est sinon en
    // tout point identique à ce qu'elle était avant ce chantier.
    const executionContext: MergeRequestContext = {
      ...context,
      requestText: decision.requestText,
    };

    if (intent === "implement") {
      const result = await runImplement(executionContext, executionContext.sourceBranch, project);
      const seconds = Math.round(result.durationMs / 1000);

      // result.detail republie parfois du texte non maîtrisé : une sortie de
      // commande (npm install, suite de tests) ou une liste de fichiers dont
      // le nom vient du dépôt relu par l'agent. defuseMentions() neutralise
      // mentions et quick actions avant republication, même logique qu'en
      // publish.ts (§5.6). Appliqué sur le texte final (après troncature du
      // "tests-red", pas avant) : c'est ce texte-là, exactement, qui part
      // dans le commentaire.
      const messages: Record<typeof result.status, string> = {
        pushed: `✅ Tests poussés sur \`${executionContext.sourceBranch}\` en ${seconds} s — ${defuseMentions(result.detail)}`,
        "mr-opened": `✅ Merge request dédiée ouverte en ${seconds} s — ${defuseMentions(result.detail)}`,
        rejected: `⛔ Modifications refusées après ${seconds} s — ${defuseMentions(result.detail)}`,
        "tests-red": `❌ Les tests ne passent pas après ${seconds} s, rien n'a été poussé.\n\n<details><summary>Sortie</summary>\n\n\`\`\`\n${defuseMentions(result.detail.slice(-TESTS_RED_REPORT_TAIL_CHARS))}\n\`\`\`\n\n</details>`,
        "tests-failing": buildTestsFailingReport(result, seconds),
        "tests-broken": `❌ Les tests écrits n'ont même pas pu être exécutés en ${seconds} s — ${defuseMentions(result.detail)}.\n\n<details><summary>Sortie du lanceur</summary>\n\n\`\`\`\n${defuseMentions((result.output ?? "").slice(-TESTS_RED_REPORT_TAIL_CHARS))}\n\`\`\`\n\n</details>`,
        "no-change": `🤷 L'agent n'a produit aucune modification en ${seconds} s.`,
      };

      // Chantier "projects.json" : si ce dépôt a des capacités élargies par
      // rapport au défaut (tests-only, source-branch), le rapport le dit
      // explicitement — quelqu'un qui relit la MR/l'issue doit pouvoir
      // savoir que l'agent avait le droit d'aller au-delà du périmètre
      // habituel, pas seulement le déduire en constatant qu'un fichier
      // source a changé. repoCapabilitiesFor() est la même traduction que
      // celle utilisée par runImplement() ci-dessus, à partir du même
      // `project.capabilities.mergeRequest` : un seul calcul du "que peut
      // faire l'agent sur ce dépôt", jamais deux qui pourraient diverger.
      const capabilities = repoCapabilitiesFor(project.capabilities.mergeRequest);
      const capabilityNote = isDefaultCapabilities(capabilities)
        ? ""
        : `\n\n🔓 Capacités élargies pour ce dépôt : ${describeCapabilities(capabilities)}.`;

      // Une table exhaustive plutôt qu'une expression booléenne : le
      // vérificateur de types refusera de compiler si un statut est ajouté
      // sans qu'on ait décidé de son issue, là où un `=== "pushed" || ...`
      // rangeait silencieusement tout nouveau statut avec les pannes. C'est
      // exactement ce qui est arrivé à "tests-failing".
      const outcomes: Record<typeof result.status, TaskOutcome> = {
        pushed: "delivered",
        "mr-opened": "delivered",
        // Rien n'est livré, mais ce n'est pas une panne : c'est le seul cas
        // où le bot a peut-être trouvé un défaut réel (voir
        // buildTestsFailingReport et le statut "tests-failing" côté
        // implement.ts). Le ranger avec ❌ était précisément l'erreur que la
        // campagne du 1er août 2026 a rendue visible.
        "tests-failing": "to-triage",
        // Un fichier que le lanceur ne peut pas exécuter n'a rien à trancher :
        // c'est une panne de production de l'agent, pas une découverte.
        "tests-broken": "failed",
        rejected: "failed",
        "tests-red": "failed",
        "no-change": "failed",
      };
      await report(
        request,
        messages[result.status] + capabilityNote + chainedReviewNote(result),
        outcomes[result.status],
      );
      log.info(`[worker] terminé ${request.key} — ${result.status}`);
      return;
    }

    if (executionContext.files.length === 0) {
      await report(request, "🤖 Aucun changement à relire — le diff est vide.", "failed");
      return;
    }

    const { remarks, durationMs, truncated, omittedFiles } = await runReview(
      executionContext,
      executionContext.sourceBranch,
    );
    const seconds = Math.round(durationMs / 1000);

    // §5.7 : une revue silencieusement partielle est pire qu'un refus franc
    // — si le diff a dépassé le plafond envoyé au modèle, l'utilisateur doit
    // le savoir, pas seulement en déduire l'absence de remarques sur un
    // fichier qu'il pensait relu.
    const truncationWarning = truncated
      ? ` ⚠️ Diff trop volumineux pour être relu intégralement (plafond dépassé)${omittedFiles.length ? ` — non montré(s) au modèle : ${omittedFiles.join(", ")}` : ""} : la revue ci-dessous est partielle.`
      : "";

    if (remarks.length === 0) {
      await report(
        request,
        `🤖 Revue terminée en ${seconds} s : aucune remarque exploitable. Les remarques produites ne correspondaient à aucun fichier du diff et ont été écartées.${truncationWarning}`,
        "delivered",
      );
      return;
    }

    const outcomes = await publishReview(executionContext, remarks);
    const byPlacement = outcomes.reduce<Record<string, number>>(
      (acc, outcome) => {
        acc[outcome.placement] = (acc[outcome.placement] ?? 0) + 1;
        return acc;
      },
      {},
    );

    // outcomes peut être vide alors que remarks ne l'était pas : toutes les
    // remarques avaient déjà été publiées lors d'un précédent passage sur
    // cette même MR (§5.5, voir publishReview). Le détail par emplacement
    // n'a alors aucun sens à afficher (parenthèses vides).
    const detail =
      outcomes.length > 0
        ? ` (${Object.entries(byPlacement)
            .map(([k, v]) => `${v} ${k}`)
            .join(", ")}).`
        : " — déjà publiée(s) lors d'un précédent passage, rien de neuf à poster.";

    await report(
      request,
      `🤖 Revue terminée en ${seconds} s — ${outcomes.length} remarque(s) publiée(s)${detail}${truncationWarning}`,
      "delivered",
    );

    log.info(
      `[worker] terminé ${request.key} — ${outcomes.length} remarque(s) en ${seconds} s`,
    );
  } catch (error) {
    const message = (error as Error).message;
    log.error(`[worker] échec ${request.key} : ${message}`);
    // Le demandeur ne doit jamais rester sans réponse après un accusé de
    // réception. Le message d'erreur peut recopier du texte non maîtrisé
    // (une réponse d'API, une sortie de commande) : on le défuse avant de le
    // republier, comme pour result.detail plus haut (§5.6). Le simple
    // entourage par des backticks ne suffit pas à lui seul : un message sur
    // plusieurs lignes y ferait quand même apparaître une ligne en tout
    // début de ligne côté GitLab.
    await report(
      request,
      `🤖 La tâche a échoué : \`${defuseMentions(message)}\``,
      "failed",
    ).catch(() => {});
  }
}
