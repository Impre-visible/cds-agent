import { buildContext } from "./context.ts";
import { gitlab } from "./gitlab.ts";
import { publishReview } from "./publish.ts";
import { runReview } from "./review.ts";
import { runImplement } from "./implement.ts";
import type { AgentRequest } from "./types.ts";

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

      const messages: Record<typeof result.status, string> = {
        pushed: `✅ Tests poussés sur \`${context.sourceBranch}\` en ${seconds} s — ${result.detail}`,
        rejected: `⛔ Modifications refusées après ${seconds} s — ${result.detail}`,
        "tests-red": `❌ Les tests ne passent pas après ${seconds} s, rien n'a été poussé.\n\n<details><summary>Sortie</summary>\n\n\`\`\`\n${result.detail.slice(-1500)}\n\`\`\`\n\n</details>`,
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

    await report(
      request,
      `🤖 Revue terminée en ${seconds} s — ${outcomes.length} remarque(s) publiée(s) ` +
        `(${Object.entries(byPlacement)
          .map(([k, v]) => `${v} ${k}`)
          .join(", ")}).`,
    );

    console.log(
      `  [worker] terminé ${request.key} — ${outcomes.length} remarque(s) en ${seconds} s`,
    );
  } catch (error) {
    const message = (error as Error).message;
    console.error(`  [worker] échec ${request.key} : ${message}`);
    // Le demandeur ne doit jamais rester sans réponse après un accusé de réception.
    await report(request, `🤖 La tâche a échoué : \`${message}\``).catch(
      () => {},
    );
  }
}
