import { buildContext } from "./context.ts";
import { config } from "../config.ts";
import { gitlab } from "../gitlab/client.ts";
import { publishReview } from "./publish.ts";
import { runReview } from "./review.ts";
import { runImplement } from "./implement.ts";
import { describeCapabilities, isDefaultCapabilities } from "./guard.ts";
import { repoCapabilitiesFor, type ResolvedCapabilities } from "../projects.ts";
import { defuseMentions } from "../daemon/request.ts";
import type { AckHandle, AgentRequest, ResourceKind } from "../types.ts";
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
 * §6.10 : fait évoluer la réaction 👀 (posée par daemon/index.ts::acknowledge())
 * vers ✅ ou ❌ selon l'issue de la tâche. L'API award emoji ne propose pas de
 * mise à jour en place : on supprime l'ancienne réaction (si elle a pu être
 * posée, voir AckHandle.awardId) avant d'en poser une nouvelle. Best-effort,
 * comme l'accusé de réception initial : un échec ici ne doit jamais faire
 * perdre le résultat déjà publié par report() ci-dessous.
 */
async function evolveReaction(
  request: AgentRequest,
  ack: AckHandle,
  ok: boolean,
): Promise<void> {
  const { projectId, kind, iid, noteId } = request;
  const emoji = ok ? "white_check_mark" : "x";

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
  ok: boolean,
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
      await evolveReaction(request, request.ack, ok);
      return;
    } catch (error) {
      log.warn(
        `édition de l'accusé de réception impossible (${(error as Error).message}) — ` +
          `note peut-être supprimée entre-temps : republication d'une nouvelle note`,
      );
    }
  }

  await gitlab.createNote(request.projectId, request.kind, request.iid, fullBody);
  if (request.ack) await evolveReaction(request, request.ack, ok);
}

export async function runTask(request: AgentRequest): Promise<void> {
  log.info(`[worker] démarrage ${request.key}`);

  try {
    if (request.kind !== "merge_requests") {
      await report(
        request,
        "🤖 Seules les merge requests sont gérées pour l'instant.",
        false,
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

    const intent = detectIntent(request.text, config.botUsername);
    log.info(`[worker] intention détectée : ${intent}`);

    if (intent === "unknown") {
      await report(
        request,
        "🤖 Je n'ai pas compris la demande. Utilisez une commande explicite : " +
          "« @bot review » pour relire la MR, ou « @bot implement-tests » pour " +
          "écrire des tests. À défaut, une formulation sans ambiguïté en langage " +
          "naturel fonctionne aussi (« fais une review de cette MR », « implémente " +
          "les tests ») — mais la commande explicite est plus fiable et reste " +
          "prioritaire si les deux sont présentes.",
        false,
      );
      return;
    }

    // Chantier "projects.json" : `request.project` a été résolu et figé par
    // daemon/index.ts::handle() avant même la mise en file — garanti présent
    // ici, authorize() n'ayant jamais laissé passer une demande dont le
    // projet est absent de projects.json (voir authorize.ts). Le garde-fou
    // ci-dessous protège le vérificateur de types, pas un cas réellement
    // atteignable en production.
    const project = request.project;
    if (!project) {
      throw new Error(
        "contexte incohérent : demande sans configuration de projet résolue (authorize() aurait dû la refuser)",
      );
    }

    const refusal = intentRefusalReason(request.kind, intent, project.capabilities);
    if (refusal) {
      await report(request, `🤖 Demande refusée : ${refusal}.`, false);
      return;
    }

    if (intent === "implement") {
      const result = await runImplement(context, context.sourceBranch, project);
      const seconds = Math.round(result.durationMs / 1000);

      // result.detail republie parfois du texte non maîtrisé : une sortie de
      // commande (npm install, suite de tests) ou une liste de fichiers dont
      // le nom vient du dépôt relu par l'agent. defuseMentions() neutralise
      // mentions et quick actions avant republication, même logique qu'en
      // publish.ts (§5.6). Appliqué sur le texte final (après troncature du
      // "tests-red", pas avant) : c'est ce texte-là, exactement, qui part
      // dans le commentaire.
      const messages: Record<typeof result.status, string> = {
        pushed: `✅ Tests poussés sur \`${context.sourceBranch}\` en ${seconds} s — ${defuseMentions(result.detail)}`,
        "mr-opened": `✅ Merge request dédiée ouverte en ${seconds} s — ${defuseMentions(result.detail)}`,
        rejected: `⛔ Modifications refusées après ${seconds} s — ${defuseMentions(result.detail)}`,
        "tests-red": `❌ Les tests ne passent pas après ${seconds} s, rien n'a été poussé.\n\n<details><summary>Sortie</summary>\n\n\`\`\`\n${defuseMentions(result.detail.slice(-TESTS_RED_REPORT_TAIL_CHARS))}\n\`\`\`\n\n</details>`,
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

      const ok = result.status === "pushed" || result.status === "mr-opened";
      await report(request, messages[result.status] + capabilityNote, ok);
      log.info(`[worker] terminé ${request.key} — ${result.status}`);
      return;
    }

    if (context.files.length === 0) {
      await report(request, "🤖 Aucun changement à relire — le diff est vide.", false);
      return;
    }

    const { remarks, durationMs, truncated, omittedFiles } = await runReview(
      context,
      context.sourceBranch,
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
        true,
      );
      return;
    }

    const outcomes = await publishReview(context, remarks);
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
      true,
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
      false,
    ).catch(() => {});
  }
}
