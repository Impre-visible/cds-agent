/**
 * Revue à passes multiples sur le backend OpenHands.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DEUX MÉCANISMES PORTENT LE MOT « PASSE », ET ILS N'ONT RIEN À VOIR
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Un TIRAGE (scripts/bench.sh --runs N) : N revues indépendantes, merge
 * request remise à zéro entre chaque, conversation oubliée. Ça mesure la
 * VARIANCE d'un modèle. Ce module n'y touche pas.
 *
 * Une PASSE (ce module) : N conversations successives DANS UNE MÊME revue,
 * sur une merge request qu'on ne remet pas à zéro. La passe K reçoit ce que
 * les précédentes ont déjà publié. Ça mesure l'ACCUMULATION.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POURQUOI `exclusion` ET PAS `chained`
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Mesuré sur `hardening`, même modèle, même merge request, trois passes :
 *
 *   mode          distinctes   nouvelles par passe   doublons
 *   independent       10            6 + 3 + 1            7
 *   chained            7            5 + 1 + 1           10
 *   exclusion         15            6 + 5 + 4            3
 *
 * `chained` produit de l'ANCRAGE : montrer les remarques précédentes invite le
 * modèle à les confirmer. La passe 3 a répondu « les 6 remarques précédentes
 * sont confirmées, aucun nouveau défaut » — elle a vérifié au lieu de
 * chercher. `exclusion` dit la même chose à l'envers (« c'est déjà couvert,
 * cherche ailleurs ») et la passe 3 rapporte encore 4 remarques neuves.
 *
 * La différence tient entièrement à la FORMULATION. C'est pourquoi les deux
 * textes vivent ici, en clair, plutôt que d'être reconstruits à l'appel.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POURQUOI LES REMARQUES VIENNENT DE GITLAB ET NON DES ÉVÉNEMENTS OPENHANDS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `GET /api/v1/conversation/<id>/events/search` existe, survit à la
 * disparition du bac à sable (les événements sont poussés au serveur par
 * webhook, pas lus dans le conteneur), et contient bien les `curl` que
 * l'agent a lancés — vérifié sur une conversation de la manche 4 : 49
 * événements, 45 occurrences de « discussions », 24 de « position ».
 *
 * Ce n'est pourtant pas la bonne source, pour trois raisons :
 *
 * 1. Ce sont des TENTATIVES, pas des résultats. Un POST refusé par GitLab
 *    (400 sur une `position` invalide — le cas le plus fréquent) laisse
 *    exactement la même trace qu'un POST accepté. La liste d'exclusion
 *    masquerait alors un défaut qui n'a jamais été signalé à personne.
 * 2. Il faudrait analyser des lignes de shell composées par le modèle, dont
 *    la forme change d'un modèle à l'autre et d'un run à l'autre. Un échec
 *    d'analyse rendrait une liste VIDE — c'est-à-dire une passe 2 qui refait
 *    la passe 1, en silence.
 * 3. L'agent continue de publier après l'expiration du délai d'attente du
 *    daemon (voir buildReport, cas "timeout"). GitLab le voit ; la
 *    conversation que le daemon a cessé de suivre, non.
 *
 * GitLab rend `position.new_path` et `position.new_line` structurés, dans une
 * API que le daemon utilise déjà. Le coût est d'un GET paginé par passe,
 * négligeable devant une passe qui dure des minutes.
 */

import {
  MAX_PREVIOUS_REMARKS_LISTED,
  MAX_PREVIOUS_REMARK_CHARS,
} from "../limits.ts";
import type { Discussion, Note } from "../types.ts";

/**
 * `independent` sert de TÉMOIN, et il n'est pas équivalent à N tirages : les
 * N conversations publient sur la MÊME merge request, sans remise à zéro.
 * C'est ce qui isole l'effet de l'addendum de l'effet du contexte partagé.
 */
export type ReviewPassMode = "independent" | "chained" | "exclusion";

export const REVIEW_PASS_MODES: readonly ReviewPassMode[] = [
  "independent",
  "chained",
  "exclusion",
];

export function isReviewPassMode(value: unknown): value is ReviewPassMode {
  return (
    typeof value === "string" &&
    (REVIEW_PASS_MODES as readonly string[]).includes(value)
  );
}

/** Une remarque déjà publiée sur la merge request, réduite à ce qui sert. */
export interface PublishedRemark {
  /** Chemin du fichier, quand il est connu. */
  file: string | null;
  /** Ligne du diff, quand la remarque est ancrée. */
  line: number | null;
  /** Formulation courte — assez pour reconnaître, trop peu pour re-expliquer. */
  gist: string;
  /**
   * Clé de nouveauté. `fichier:ligne` quand la remarque est ancrée, sinon la
   * formulation normalisée. Deux remarques de même clé comptent pour une.
   */
  key: string;
}

/**
 * Première ligne non vide du corps, débarrassée du markdown le plus courant
 * et tronquée. Pas de troncature au milieu d'un mot : une formulation coupée
 * net se lit comme une autre remarque.
 */
function gistOf(body: string): string {
  const firstLine =
    body
      .split("\n")
      .map((line) => line.replace(/^[\s>*_#-]+/, "").trim())
      .find((line) => line.length > 0 && !line.startsWith("```")) ?? "";
  const flat = firstLine.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_PREVIOUS_REMARK_CHARS) return flat;
  const cut = flat.slice(0, MAX_PREVIOUS_REMARK_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > MAX_PREVIOUS_REMARK_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Le chemin cité dans le texte d'une remarque NON ancrée.
 *
 * Les commentaires généraux n'ont pas de `position` : sans ça ils
 * n'apporteraient qu'une formulation, et deux remarques générales sur le même
 * fichier ne se reconnaîtraient pas entre elles. Un modèle qui ne sait pas
 * ancrer cite presque toujours le fichier en clair, souvent dans un `code
 * span` — quatre des sept modèles de la première campagne étaient dans ce
 * cas, avec 0 remarque ancrée sur 10, sur 16, sur 6.
 *
 * Reconnaît un chemin plausible : au moins un caractère de chemin et une
 * extension courte. Volontairement conservateur — un faux positif ajouterait
 * à la liste d'exclusion un fichier que rien ne couvre, ce qui interdirait à
 * la passe suivante d'y chercher.
 */
const PATH_RE = /\b([\w.-]+(?:\/[\w.-]+)*\.[a-zA-Z]{1,5})\b/;

export function fileMentionedIn(body: string): string | null {
  return PATH_RE.exec(body)?.[1] ?? null;
}

function positionOf(note: Note): { file: string | null; line: number | null } {
  const position = note.position;
  if (!position) return { file: null, line: null };
  // new_path/new_line d'abord : une remarque porte presque toujours sur le
  // code ajouté. old_* est le repli des lignes supprimées, où GitLab laisse
  // new_line à null.
  const file = position.new_path ?? position.old_path ?? null;
  const line = position.new_line ?? position.old_line ?? null;
  return { file, line };
}

/**
 * Ce que le bot a publié sur la merge request depuis `since`.
 *
 * BORNÉ DANS LE TEMPS. Sans `since`, une revue antérieure — celle d'hier,
 * celle d'un autre modèle — entrerait dans la liste d'exclusion et
 * interdirait à la passe 1 de signaler ce qu'elle est censée signaler. Le
 * repère est pris AVANT la première passe, côté appelant.
 *
 * Seule la note d'ouverture d'une discussion compte : les réponses dans un
 * fil ne sont pas des remarques distinctes, ce sont des échanges sur une
 * remarque déjà comptée.
 */
export function extractRemarks(
  discussions: Discussion[],
  botUsername: string,
  since: number,
): PublishedRemark[] {
  const remarks: PublishedRemark[] = [];
  const seen = new Set<string>();

  for (const discussion of discussions) {
    const opener = discussion.notes[0];
    if (!opener || opener.system) continue;
    if (opener.author.username !== botUsername) continue;
    if (Date.parse(opener.created_at) < since) continue;

    const { file, line } = positionOf(opener);
    const gist = gistOf(opener.body);
    if (gist.length === 0) continue;

    const resolvedFile = file ?? fileMentionedIn(opener.body);
    const key =
      resolvedFile !== null && line !== null
        ? `${resolvedFile}:${line}`
        : resolvedFile !== null
          ? `${resolvedFile}:?`
          : gist.toLowerCase();

    if (seen.has(key)) continue;
    seen.add(key);
    remarks.push({ file: resolvedFile, line, gist, key });
  }

  return remarks;
}

/** "src/todoStore.js:28", "src/todoStore.js", ou "sans emplacement". */
export function locationOf(remark: PublishedRemark): string {
  if (remark.file === null) return "sans emplacement";
  return remark.line === null ? remark.file : `${remark.file}:${remark.line}`;
}

/**
 * L'addendum ajouté au message de la passe ≥ 2.
 *
 * Rend "" pour `independent` et pour une liste vide — c'est ce qui garantit
 * qu'une revue à `passes: 1` envoie EXACTEMENT le message d'avant ce
 * chantier, au caractère près, et que la manche 4 reste comparable à ce qui
 * sera mesuré ensuite.
 *
 * Exportée pour être testée unitairement : fonction pure.
 */
export function buildPassAddendum(
  mode: ReviewPassMode,
  previous: PublishedRemark[],
): string {
  if (mode === "independent" || previous.length === 0) return "";

  const listed = previous.slice(0, MAX_PREVIOUS_REMARKS_LISTED);
  const lines = listed.map(
    (remark) => `- ${locationOf(remark)} — ${remark.gist}`,
  );
  if (previous.length > listed.length) {
    lines.push(
      `- [... ${previous.length - listed.length} remarque(s) supplémentaire(s) non listée(s) ...]`,
    );
  }

  // Les deux formulations, en clair. Elles ne nomment aucun fichier ni aucun
  // défaut du jeu mesuré : la consigne porte sur la STRATÉGIE, sinon la
  // mesure apprendrait le corrigé au lieu de mesurer la méthode.
  const instruction =
    mode === "exclusion"
      ? "Une passe de revue précédente a déjà signalé les points ci-dessous, et ils sont " +
        "déjà publiés sur la merge request. Ne les republie pas, et ne te contente pas de " +
        "les vérifier : cherche des défauts d'une AUTRE NATURE, dans des fichiers ou des " +
        "comportements que cette liste ne couvre pas."
      : "Une passe de revue précédente a produit les remarques ci-dessous, déjà publiées " +
        "sur la merge request. Reprends-les : confirme celles qui tiennent, corrige celles " +
        "qui visent la mauvaise ligne ou décrivent mal le défaut, approfondis celles qui " +
        "restent vagues — et ajoute ce qu'elles ont manqué.";

  return `\n\n## Déjà couvert par une passe précédente\n${instruction}\n\n${lines.join("\n")}`;
}

/** Ce qu'une passe a produit, pour le journal et le récapitulatif. */
export interface PassOutcome {
  pass: number;
  /** Remarques publiées par CETTE passe (déjà dédupliquées entre elles). */
  published: number;
  /** Parmi elles, celles dont l'emplacement n'avait jamais été vu. */
  fresh: number;
  seconds: number;
  result: string;
}

/**
 * Sépare le neuf du déjà-vu, et enrichit `seen` au passage.
 *
 * C'EST LA MÉTRIQUE CENTRALE du chantier : si la passe 3 n'apporte jamais
 * rien, le protocole est à deux passes et il faut pouvoir le lire sans
 * dépouiller la merge request à la main.
 *
 * `seen` est muté volontairement — l'appelant le porte d'une passe à l'autre.
 */
export function countFresh(
  remarks: PublishedRemark[],
  seen: Set<string>,
): number {
  let fresh = 0;
  for (const remark of remarks) {
    if (seen.has(remark.key)) continue;
    seen.add(remark.key);
    fresh++;
  }
  return fresh;
}

/**
 * La ligne récapitulative de fin de revue.
 *
 *   3 passes (mode=exclusion) : 6 + 5 + 4 remarques nouvelles, 41 s
 *
 * Une passe stérile s'y lit comme un `0` — c'est le signal qu'on cherche.
 */
export function summarizePasses(
  passes: PassOutcome[],
  mode: ReviewPassMode,
): string {
  if (passes.length === 0) return `0 passe (mode=${mode})`;
  const fresh = passes.map((pass) => pass.fresh).join(" + ");
  const seconds = passes.reduce((total, pass) => total + pass.seconds, 0);
  return (
    `${passes.length} passe(s) (mode=${mode}) : ${fresh} remarque(s) nouvelle(s), ` +
    `${seconds} s`
  );
}
