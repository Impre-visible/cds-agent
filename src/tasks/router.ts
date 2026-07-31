import { buildContext } from "./context.ts";
import { gitlab } from "../gitlab/client.ts";
import { publishReview } from "./publish.ts";
import { runReview } from "./review.ts";
import { runImplement } from "./implement.ts";
import { defuseMentions } from "../daemon/request.ts";
import type { AgentRequest } from "../types.ts";

type Intent = "review" | "implement" | "unknown";

function detectIntent(text: string): Intent {
  const normalized = text.toLowerCase();
  if (
    /\btests?\b/.test(normalized) &&
    /impl[ée]ment|[ée]cri|ajoute|cr[ée]e|write|add/.test(normalized)
  ) {
    return "implement";
  }
  if (/review|revue|relis|relire|relecture/.test(normalized)) return "review";
  return "unknown";
}

async function report(request: AgentRequest, body: string): Promise<void> {
  await gitlab.createNote(
    request.projectId,
    request.kind,
    request.iid,
    `${body}\n\n<sub>cds-agent</sub>`,
  );
}

export async function runTask(request: AgentRequest): Promise<void> {
  console.log(`  [worker] démarrage ${request.key}`);

  try {
    if (request.kind !== "merge_requests") {
      await report(
        request,
        "🤖 Seules les merge requests sont gérées pour l'instant.",
      );
      return;
    }

    const context = await buildContext(request);

    const intent = detectIntent(request.text);
    console.log(`  [worker] intention détectée : ${intent}`);

    if (intent === "unknown") {
      await report(
        request,
        "🤖 Je n'ai pas compris la demande. Formulations reconnues : « fais une review de cette MR » ou « implémente les tests ».",
      );
      return;
    }

    if (intent === "implement") {
      if (!context.sourceBranch) {
        await report(
          request,
          "🤖 L'implémentation de tests requiert une merge request avec une branche source.",
        );
        return;
      }

      const result = await runImplement(context, context.sourceBranch);
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
        rejected: `⛔ Modifications refusées après ${seconds} s — ${defuseMentions(result.detail)}`,
        "tests-red": `❌ Les tests ne passent pas après ${seconds} s, rien n'a été poussé.\n\n<details><summary>Sortie</summary>\n\n\`\`\`\n${defuseMentions(result.detail.slice(-1500))}\n\`\`\`\n\n</details>`,
        "no-change": `🤷 L'agent n'a produit aucune modification en ${seconds} s.`,
      };

      await report(request, messages[result.status]);
      console.log(`  [worker] terminé ${request.key} — ${result.status}`);
      return;
    }

    if (!context.sourceBranch || context.files.length === 0) {
      await report(request, "🤖 Aucun changement à relire — le diff est vide.");
      return;
    }

    const { remarks, durationMs } = await runReview(
      context,
      context.sourceBranch,
    );
    const seconds = Math.round(durationMs / 1000);

    if (remarks.length === 0) {
      await report(
        request,
        `🤖 Revue terminée en ${seconds} s : aucune remarque exploitable. Les remarques produites ne correspondaient à aucun fichier du diff et ont été écartées.`,
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
      `🤖 Revue terminée en ${seconds} s — ${outcomes.length} remarque(s) publiée(s)${detail}`,
    );

    console.log(
      `  [worker] terminé ${request.key} — ${outcomes.length} remarque(s) en ${seconds} s`,
    );
  } catch (error) {
    const message = (error as Error).message;
    console.error(`  [worker] échec ${request.key} : ${message}`);
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
    ).catch(() => {});
  }
}
