import { createHash } from "node:crypto";
import { config } from "../config.ts";
import { gitlab, GitLabError } from "../gitlab/client.ts";
import { defuseMentions } from "../daemon/request.ts";
import type { ValidatedRemark } from "./diff.ts";
import type { DiffRefs, MergeRequestContext } from "../types.ts";

export type Placement = "line" | "file" | "general";

export interface PublishOutcome {
  message: string;
  placement: Placement;
  detail?: string;
}

/**
 * Motif reconnaissant l'empreinte qu'on appose sur chaque commentaire publié
 * (voir fingerprintTag ci-dessous). Un commentaire HTML : invisible une fois
 * le markdown rendu par GitLab (contrairement à un texte en clair), mais bien
 * présent dans le corps brut relu via l'API — c'est justement ce qu'on relit
 * dans alreadyPublished().
 */
const FINGERPRINT_TAG_RE = /<!-- cds-agent:fp:([0-9a-f]{12}) -->/g;

/**
 * Identité stable d'une remarque : le triplet (fichier, ligne, message) qui
 * la caractérise pour un lecteur humain — c'est la même logique de clé que
 * validateRemarks() utilise déjà pour dédupliquer *avant* publication (voir
 * diff.ts). Le hash n'est là que pour obtenir une empreinte courte à glisser
 * dans un commentaire HTML ; aucune propriété cryptographique n'est requise.
 */
function fingerprint(remark: ValidatedRemark): string {
  const line = remark.position?.newLine ?? "file";
  const key = [remark.file.new_path, line, remark.message].join(":");
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

function fingerprintTag(remark: ValidatedRemark): string {
  return `<!-- cds-agent:fp:${fingerprint(remark)} -->`;
}

// Comme MAX_TODO_PAGES/MAX_DIFF_PAGES dans gitlab/client.ts : borne le pire
// cas (2000 notes) plutôt que de paginer indéfiniment.
const MAX_NOTES_PAGES = 20;

/**
 * §5.5 : rien côté GitLab n'empêche de publier deux fois la même review (un
 * humain qui relance la commande, ou un rejeu après un échec réseau en
 * cours de publication). On déduplique en relisant, à chaque publication,
 * les commentaires déjà postés par le bot sur cette MR plutôt qu'en gardant
 * une trace locale : ça survit à un redémarrage du daemon (le fichier
 * d'état de request.ts ne fait que suivre le *traitement* de la demande, pas
 * ce qui a effectivement été écrit sur GitLab), et ça reste correct si deux
 * exécutions distinctes (deux demandes de review successives) portent sur
 * le même diff. Alternative envisagée et écartée : porter la déduplication
 * uniquement en mémoire/fichier local — plus simple, mais qui ne détecte
 * rien après un redémarrage ni un rejeu déclenché depuis GitLab lui-même.
 *
 * gitlab.notes() (bulk) a été retiré de gitlab/client.ts pendant ce
 * chantier (remplacé par notesPage(), page par page — voir le commentaire à
 * sa définition) : on pagine donc ici nous-mêmes avec cette primitive,
 * plutôt que d'ajouter une méthode bulk dédiée dans un fichier sur lequel un
 * autre chantier est en cours.
 */
async function alreadyPublished(
  projectId: number,
  iid: number,
): Promise<Set<string>> {
  const fingerprints = new Set<string>();
  let page: number | null = 1;

  for (let visited = 0; page !== null && visited < MAX_NOTES_PAGES; visited++) {
    const result = await gitlab.notesPage(
      projectId,
      "merge_requests",
      iid,
      page,
      "asc",
    );
    for (const note of result.items) {
      if (
        note.author.username.toLowerCase() !== config.botUsername.toLowerCase()
      )
        continue;
      for (const match of note.body.matchAll(FINGERPRINT_TAG_RE)) {
        if (match[1]) fingerprints.add(match[1]);
      }
    }
    page = result.nextPage;
  }

  return fingerprints;
}

/**
 * Les SHA "actuellement" en tête côté GitLab, ou `null` si l'information
 * n'est momentanément pas disponible. La doc recommande les versions : le
 * premier élément est la plus récente.
 *
 * Peut renvoyer `null` sans que la MR ait bougé : GitLab vide temporairement
 * ce genre d'information pendant un recontrôle de mergeabilité (voir la
 * boucle d'attente de context.ts, DIFF_REFS_RETRIES) — ce n'est pas la même
 * chose qu'un push réel, et il ne faut pas confondre les deux (voir
 * resolveShas ci-dessous).
 */
async function currentDiffRefs(
  projectId: number,
  iid: number,
): Promise<DiffRefs | null> {
  const [latest] = await gitlab.mergeRequestVersions(projectId, iid);
  if (!latest?.head_commit_sha) return null;
  return {
    base_sha: latest.base_commit_sha,
    start_sha: latest.start_commit_sha,
    head_sha: latest.head_commit_sha,
  };
}

/** Un triplet de SHA identique terme à terme : même état de la MR. */
function sameShas(a: DiffRefs, b: DiffRefs): boolean {
  return (
    a.base_sha === b.base_sha &&
    a.start_sha === b.start_sha &&
    a.head_sha === b.head_sha
  );
}

/**
 * §5.4 : les positions des remarques ont été calculées par validateRemarks
 * (diff.ts) sur context.files, obtenu au moment de buildContext() — soit
 * potentiellement plusieurs minutes avant d'arriver ici, le temps que
 * l'agent LLM tourne (jusqu'à config.agentTimeoutMs). Résoudre les SHA à
 * *cet instant-ci* plutôt qu'à celui du calcul des positions reviendrait à
 * publier, avec les SHA du nouveau diff si quelqu'un a poussé entre-temps,
 * des positions calculées sur l'ancien : commentaires sur les mauvaises
 * lignes, ou rafale de 400 (position invalide) qui bascule tout en repli
 * fichier/général sans que rien ne le distingue d'un simple refus GitLab
 * ponctuel.
 *
 * On fige donc les SHA dès buildContext() (context.diffRefs) et on ne fait
 * plus, ici, que vérifier qu'ils sont toujours d'actualité :
 * - context.diffRefs présent et toujours à jour (ou fraîcheur non vérifiable,
 *   voir currentDiffRefs) → on le réutilise tel quel, comme avant ce
 *   correctif ;
 * - context.diffRefs présent mais périmé (la MR a réellement bougé pendant
 *   la review) → on ABANDONNE plutôt que de publier des positions douteuses.
 *   Un recalcul silencieux republierait des remarques que l'agent n'a pas
 *   relues sur le nouveau code ; dire clairement à l'utilisateur de relancer
 *   la demande est plus utile qu'une review qui a l'air correcte mais ne
 *   l'est pas forcément ;
 * - context.diffRefs absent (buildContext() n'a pas réussi à en figer un,
 *   voir context.ts) → seul cas où on tente une résolution ici, faute de
 *   mieux ; aucune fraîcheur à vérifier puisqu'il n'y a pas de référence à
 *   comparer.
 */
async function resolveShas(context: MergeRequestContext): Promise<DiffRefs> {
  if (context.diffRefs) {
    const current = await currentDiffRefs(context.projectId, context.targetIid);
    if (current && !sameShas(current, context.diffRefs)) {
      throw new Error(
        "la MR a été mise à jour pendant la review, relancez la demande",
      );
    }
    return context.diffRefs;
  }

  const current = await currentDiffRefs(context.projectId, context.targetIid);
  if (current) return current;
  throw new Error("aucun SHA exploitable : ni versions ni diff_refs");
}

/**
 * §5.6 : remark.message vient du LLM, qui a lui-même lu du texte rédigé par
 * des tiers (diff, description de la MR, commentaires du ticket lié). Publié
 * tel quel, il peut contenir une mention qui notifie réellement quelqu'un,
 * ou une ligne interprétée comme une quick action GitLab (`/close`,
 * `/merge`...) exécutée avec les droits du PAT du bot — defuseMentions()
 * neutralise les deux sans toucher au reste du texte (voir request.ts).
 */
function body(remark: ValidatedRemark): string {
  return `**${remark.severity}** — ${defuseMentions(remark.message)}\n\n<sub>cds-agent</sub>\n${fingerprintTag(remark)}`;
}

export async function publishReview(
  context: MergeRequestContext,
  remarks: ValidatedRemark[],
): Promise<PublishOutcome[]> {
  const shas = await resolveShas(context);
  const published = await alreadyPublished(context.projectId, context.targetIid);
  const outcomes: PublishOutcome[] = [];
  const orphans: ValidatedRemark[] = [];

  for (const remark of remarks) {
    if (published.has(fingerprint(remark))) {
      console.log(
        `    remarque déjà publiée sur cette MR (idempotence §5.5), ignorée : ${remark.file.new_path}`,
      );
      continue;
    }

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
    // Une empreinte par remarque, glissée en fin de sa propre ligne : un
    // commentaire regroupe plusieurs remarques indépendantes, chacune doit
    // rester reconnaissable individuellement pour qu'une seconde passe ne
    // republie que celles qui sont réellement nouvelles (voir
    // alreadyPublished ci-dessus).
    const summary = [
      `🤖 Remarques non positionnables (${orphans.length}) :`,
      "",
      ...orphans.map(
        (r) =>
          `- \`${r.file.new_path}\` — **${r.severity}** ${defuseMentions(r.message)} ${fingerprintTag(r)}`,
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
