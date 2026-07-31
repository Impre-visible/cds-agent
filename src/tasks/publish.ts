import { gitlab, GitLabError } from "../gitlab/client.ts";
import type { ValidatedRemark } from "./diff.ts";
import type { DiffRefs, TaskContext } from "../types.ts";

export type Placement = "line" | "file" | "general";

export interface PublishOutcome {
  message: string;
  placement: Placement;
  detail?: string;
}

async function resolveShas(context: TaskContext): Promise<DiffRefs> {
  // La doc recommande les versions : le premier élément est la plus récente.
  const [latest] = await gitlab.mergeRequestVersions(
    context.projectId,
    context.targetIid,
  );
  if (latest?.head_commit_sha) {
    return {
      base_sha: latest.base_commit_sha,
      start_sha: latest.start_commit_sha,
      head_sha: latest.head_commit_sha,
    };
  }
  if (context.diffRefs) return context.diffRefs;
  throw new Error("aucun SHA exploitable : ni versions ni diff_refs");
}

function body(remark: ValidatedRemark): string {
  return `**${remark.severity}** — ${remark.message}\n\n<sub>cds-agent</sub>`;
}

export async function publishReview(
  context: TaskContext,
  remarks: ValidatedRemark[],
): Promise<PublishOutcome[]> {
  const shas = await resolveShas(context);
  const outcomes: PublishOutcome[] = [];
  const orphans: ValidatedRemark[] = [];

  for (const remark of remarks) {
    const common = {
      body: body(remark),
      "position[base_sha]": shas.base_sha,
      "position[start_sha]": shas.start_sha,
      "position[head_sha]": shas.head_sha,
      "position[new_path]": remark.file.new_path,
      "position[old_path]": remark.file.old_path,
    };

    // Niveau 1 — sur la ligne.
    if (remark.position) {
      try {
        await gitlab.createDiscussion(context.projectId, context.targetIid, {
          ...common,
          "position[position_type]": "text",
          "position[new_line]": remark.position.newLine,
          // Ligne inchangée : les deux numéros sont exigés. Ligne ajoutée : new_line seul.
          "position[old_line]": remark.position.oldLine ?? undefined,
        });
        outcomes.push({ message: remark.message, placement: "line" });
        continue;
      } catch (error) {
        const detail =
          error instanceof GitLabError ? `${error.status}` : String(error);
        console.log(
          `    ligne ${remark.position.newLine} refusée (${detail}), repli fichier`,
        );
      }
    }

    // Niveau 2 — sur le fichier.
    try {
      await gitlab.createDiscussion(context.projectId, context.targetIid, {
        ...common,
        "position[position_type]": "file",
      });
      outcomes.push({ message: remark.message, placement: "file" });
      continue;
    } catch (error) {
      const detail =
        error instanceof GitLabError ? `${error.status}` : String(error);
      console.log(
        `    fichier ${remark.file.new_path} refusé (${detail}), repli général`,
      );
    }

    // Niveau 3 — regroupé en commentaire général.
    orphans.push(remark);
  }

  if (orphans.length > 0) {
    const summary = [
      `🤖 Remarques non positionnables (${orphans.length}) :`,
      "",
      ...orphans.map(
        (r) => `- \`${r.file.new_path}\` — **${r.severity}** ${r.message}`,
      ),
      "",
      "<sub>cds-agent</sub>",
    ].join("\n");

    await gitlab.createNote(
      context.projectId,
      "merge_requests",
      context.targetIid,
      summary,
    );
    for (const remark of orphans) {
      outcomes.push({ message: remark.message, placement: "general" });
    }
  }

  return outcomes;
}
