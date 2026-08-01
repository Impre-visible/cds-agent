/**
 * §5.8 : ce fichier rassemble les constantes qui encodent de vraies
 * décisions — budget de contexte envoyé au modèle, verbosité de ce qu'on
 * republie (GitLab ou logs), patience face à GitLab, tailles de tampon,
 * seuils de compaction — plutôt que de les laisser dispersées, sous des
 * noms parfois presque identiques (MAX_NOTE_PAGES / MAX_NOTES_PAGES...),
 * au milieu d'une dizaine de fichiers où elles deviennent invisibles comme
 * arbitrages.
 *
 * Ce qui n'est délibérément PAS ici :
 * - les réglages d'exploitation (timeouts, tailles Docker, tentatives,
 *   intervalles de polling...) vivent dans src/config.ts, ajustables par
 *   variable d'environnement sans recompiler — c'est le bon endroit pour ce
 *   qu'un opérateur peut légitimement vouloir changer d'un déploiement à
 *   l'autre ;
 * - les constantes utilisées une seule fois, déjà bien nommées et
 *   commentées juste à côté du code qu'elles gouvernent, quand les
 *   regrouper ici n'aurait fait qu'éloigner le commentaire de son contexte
 *   sans gagner en lisibilité (ex. GIT_MAX_BUFFER dans agent/workspace.ts,
 *   LINE_NUMBER_WIDTH dans tasks/diff.ts) — voir le rapport du chantier
 *   §5.8 pour la liste de ce qui a été laissé en place et pourquoi.
 *
 * Chaque constante ci-dessous porte, dans son commentaire, ce qu'elle
 * arbitre réellement — pas "nombre maximal de caractères" mais pourquoi ce
 * nombre-là, ce qui casse en dessous, ce qui casse au-dessus. Module
 * volontairement sans dépendance (ni config.ts ni aucun autre module du
 * projet) : une simple table de constantes, importable de n'importe où sans
 * jamais risquer un cycle d'imports.
 */

// ---------------------------------------------------------------------------
// Budget de contexte envoyé au modèle (prompts de review et d'implémentation)
// ---------------------------------------------------------------------------
//
// Ces plafonds bornent ce qu'on envoie à un modèle 7B local dont la fenêtre
// de contexte tient sur quelques milliers de tokens (~4 caractères/token,
// heuristique usuelle — pas une mesure prise contre ce modèle précis,
// impossible à vérifier ici faute de modèle disponible, voir le rapport de
// ce chantier). Trop haut : le prompt déborde la fenêtre, au mieux un échec
// net, au pire une réponse fondée sur la seule partie que le serveur
// d'inférence a retenue, sans que rien ne le signale. Trop bas : le modèle
// perd le contexte dont il a réellement besoin (description du ticket,
// diff complet) pour produire une remarque pertinente. Ces valeurs visent à
// rester confortablement en dessous de la fenêtre plutôt qu'à la coller au
// plus juste — à revoir explicitement si AGENT_MODEL change pour un modèle
// à fenêtre significativement différente.

/**
 * Description d'un ticket lié, en caractères : partagée par review.ts et
 * implement.ts (même troncature, même raison — un ticket peut être
 * arbitrairement long, sans rapport avec la taille du diff à relire ou des
 * tests à écrire). Absorbée ici plutôt que dupliquée entre les deux
 * fichiers, comme review.ts et implement.ts le faisaient jusqu'ici
 * (chacun avec sa propre copie de la même valeur).
 */
export const MAX_ISSUE_DESCRIPTION_CHARS = 1500;

/**
 * Commentaires récents d'un ticket lié inclus dans le prompt de review
 * (tasks/review.ts). Distinct de MAX_ISSUE_DESCRIPTION_CHARS : un fil de
 * discussion peut à lui seul dépasser la description d'origine sur un
 * ticket disputé.
 */
export const MAX_ISSUE_COMMENTS_CHARS = 3000;

/**
 * Nombre de commentaires humains récents conservés par ticket lié
 * (tasks/context.ts) pour construire ce que le prompt présente comme "les
 * échanges récents" — pas une limite de caractères mais un nombre
 * d'éléments : au-delà, la conversation resterait lisible mais perdrait de
 * sa pertinence (les tout premiers échanges d'un fil de 50 messages
 * comptent rarement pour comprendre l'état actuel du ticket).
 */
export const RECENT_HUMAN_COMMENTS = 15;

/**
 * Plafond total (tous fichiers confondus) du diff inclus dans le prompt de
 * review (tasks/review.ts). Introduit récemment (§5.7) : une MR de
 * refactoring peut produire un diff de plusieurs mégaoctets. Au-delà de ce
 * plafond, review.ts tronque explicitement (avec une marque visible dans le
 * prompt) plutôt que de laisser le modèle répondre comme s'il avait tout lu.
 */
export const MAX_TOTAL_DIFF_CHARS = 20_000;

/**
 * Plafond par fichier (tasks/review.ts), appliqué avant le plafond global
 * ci-dessus : empêche un seul fichier volumineux (fichier généré,
 * lockfile...) de consommer à lui seul tout le budget de
 * MAX_TOTAL_DIFF_CHARS et de faire disparaître les autres fichiers du
 * prompt sans même apparaître dans la liste des fichiers tronqués.
 */
export const MAX_FILE_DIFF_CHARS = 4_000;

/**
 * Fichiers GÉNÉRÉS, exclus du diff montré au modèle (tasks/review.ts,
 * buildDiffSection). Aucune revue n'a jamais rien à dire d'un lockfile ou
 * d'un bundle minifié : les y montrer est un gaspillage pur, et ce
 * gaspillage a un coût mesuré.
 *
 * Campagne du 1er août 2026, MR !2 : sur les 13 runs, sans une seule
 * exception, le log disait
 *   « diff tronqué — coupés : tests/todos.test.js, package-lock.json ;
 *     non montrés : server.js »
 * package-lock.json (106 888 octets) consommait le budget de
 * MAX_TOTAL_DIFF_CHARS et évinçait server.js (1 107 octets), un fichier
 * source que les modèles devaient ensuite ouvrir eux-mêmes — quand ils y
 * pensaient. MAX_FILE_DIFF_CHARS bornait déjà sa contribution, mais 4 000
 * caractères de lockfile restent 4 000 caractères pris à du vrai code.
 *
 * Ne concerne QUE la construction du prompt. Une remarque portant sur l'un de
 * ces fichiers reste recevable (tasks/diff.ts::validateRemarks continue de
 * les considérer comme appartenant au diff) : le modèle peut parfaitement les
 * ouvrir lui-même s'il a une raison de le faire.
 */
export const GENERATED_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)go\.sum$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)vendor\//,
];

export function isGeneratedFile(path: string): boolean {
  return GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

// ---------------------------------------------------------------------------
// Verbosité de ce qu'on republie — commentaires GitLab et logs console
// ---------------------------------------------------------------------------
//
// Ces plafonds bornent la taille d'un texte non maîtrisé (sortie de
// commande, message d'erreur, extrait de demande utilisateur) avant de le
// republier dans un commentaire GitLab ou un log console. Trop haut : un
// commentaire GitLab de plusieurs milliers de lignes (sortie de build
// bavarde) noie l'information utile et rend la MR/l'issue illisible pour un
// humain. Trop bas : la partie réellement utile (l'erreur elle-même, en fin
// de sortie pour une suite de tests) n'est plus visible.

/**
 * Queue conservée de la sortie brute d'une commande (install ou tests) dans
 * le `detail` interne d'implement.ts, en cas d'échec. On garde la FIN (pas
 * le début) : c'est là que se trouve l'erreur réelle d'une suite de tests
 * ou d'un install qui échoue (la pile d'erreurs, pas le bruit des paquets
 * installés avant elle) — même logique que agent/bounded-output.ts.
 */
export const COMMAND_OUTPUT_TAIL_CHARS = 1_200;

/**
 * Plafond final, appliqué par tasks/router.ts au message "tests-red" tout
 * juste avant de le publier sur GitLab (au-delà de COMMAND_OUTPUT_TAIL_CHARS
 * ci-dessus, qui a déjà réduit la sortie brute) : un filet de sécurité, pas
 * la limite qui joue en pratique — le texte à ce stade contient déjà la
 * sortie tronquée par implement.ts plus un court préfixe, donc largement
 * sous ce plafond dans le cas courant. Volontairement plus large que
 * COMMAND_OUTPUT_TAIL_CHARS plutôt qu'égal : il ne doit couper que si le
 * préfixe pousse exceptionnellement le total au-delà, jamais retrancher un
 * peu plus de la sortie déjà choisie par implement.ts.
 */
export const TESTS_RED_REPORT_TAIL_CHARS = 1_500;

/**
 * Contenu d'UN fichier de test écrit par l'agent, republié dans le rapport
 * quand la suite reste rouge alors que la baseline était verte (statut
 * "tests-failing", voir tasks/implement.ts).
 *
 * Ce cas recouvre deux situations opposées et mécaniquement indiscernables :
 * l'agent a écrit une assertion fausse, ou il a trouvé un vrai défaut du code.
 * Rien dans le dépôt ne permet de trancher — un humain, si — mais seulement
 * s'il voit l'assertion. D'où la republication du contenu et pas seulement du
 * message d'échec : sans elle, le résultat le plus précieux que le bot puisse
 * produire est jeté avec le workspace.
 *
 * 2 000 caractères couvrent très largement un fichier de test normal (500 à
 * 1 500 en pratique) ; au-delà, la coupe est visible dans le texte publié.
 */
export const MAX_TEST_ARTIFACT_CHARS = 2_000;

/**
 * Plafond cumulé des contenus republiés (tous fichiers confondus), pour qu'un
 * agent qui écrit dix fichiers ne produise pas un commentaire GitLab
 * illisible. Les fichiers sont pris dans l'ordre ; ceux qui ne rentrent plus
 * sont nommés sans leur contenu, jamais passés sous silence.
 */
export const MAX_TEST_ARTIFACT_TOTAL_CHARS = 6_000;

// ---------------------------------------------------------------------------
// Relecture croisée (tasks/chained-review.ts) — budget du prompt
// ---------------------------------------------------------------------------
//
// La relecture croisée relit les tests qu'une implémentation vient de pousser
// CONTRE le code source qu'ils importent — réponse à l'angle mort mesuré le
// 1er août 2026 : un modèle a décrit un bug en commentaire puis choisi la
// seule valeur d'entrée qui l'évite, suite verte, rien ne le signale. Le
// diff des tests seul ne suffit pas : « attend qu'une description de 2001
// caractères soit rejetée » n'est suspect qu'à côté de MAX_DESCRIPTION_LENGTH
// = 2000 — d'où l'inclusion du source, et donc ces plafonds (un fichier
// source n'est pas borné par nature, contrairement à un diff).

/** Contenu d'un fichier source joint au prompt de relecture croisée, par fichier. */
export const CHAINED_SOURCE_FILE_CHARS = 6_000;

/** Budget cumulé des fichiers source joints — au-delà, coupés visiblement. */
export const CHAINED_SOURCE_TOTAL_CHARS = 16_000;

/**
 * Nombre de fichiers source suivis depuis les imports des tests. Au-delà,
 * les tests importent trop de modules pour une relecture ciblée — les
 * premiers dans l'ordre des imports sont gardés, le prompt dit ce qui manque.
 */
export const CHAINED_MAX_SOURCE_FILES = 6;

/** Constats de relecture croisée republiés dans le rapport — au-delà, tronqués en le disant. */
export const CHAINED_MAX_FINDINGS = 5;

/**
 * Raison d'abandon d'une demande après épuisement de MAX_ATTEMPTS
 * (daemon/index.ts, notifyGiveUp), republiée dans un commentaire GitLab
 * visible du demandeur. Un message d'erreur brut peut être long (pile
 * d'exception, réponse d'API) ; ce plafond garde de quoi comprendre la
 * cause sans noyer le commentaire d'abandon sous du texte accessoire.
 */
export const ABANDON_REASON_CHARS = 500;

/**
 * Extrait de la demande utilisateur affiché dans le log console
 * (daemon/index.ts, handle()) au moment de la prise en charge d'un to-do —
 * jamais republié sur GitLab, seulement pour qu'un opérateur qui suit les
 * logs identifie la demande sans que celle-ci (potentiellement une
 * description entière) n'inonde la sortie du daemon.
 */
export const REQUEST_LOG_EXCERPT_CHARS = 100;

/**
 * Corps de réponse HTTP inclus dans le message d'une GitLabError
 * (gitlab/client.ts) — ce corps peut contenir une page d'erreur HTML
 * complète ou un JSON verbeux ; ce plafond garde de quoi diagnostiquer
 * (code d'erreur GitLab, message) sans faire déborder les logs à chaque
 * requête en échec.
 */
export const GITLAB_ERROR_BODY_CHARS = 400;

// ---------------------------------------------------------------------------
// Pagination GitLab — plafonds de sécurité sur les collections paginées
// ---------------------------------------------------------------------------

/**
 * Nombre maximal de pages explorées pour une collection GitLab paginée
 * (to-dos, diffs d'une MR, notes d'une issue ou d'une MR) — voir
 * gitlab/client.ts::paginate, tasks/context.ts::recentHumanNotes,
 * tasks/publish.ts::alreadyPublished, qui partagent tous la même valeur
 * (auparavant quatre constantes distinctes portant presque le même nom —
 * MAX_TODO_PAGES, MAX_DIFF_PAGES, MAX_NOTE_PAGES, MAX_NOTES_PAGES — pour
 * exactement la même décision). Avec per_page=100, borne le pire cas à 2000
 * éléments par collection : largement au-delà de ce qu'un usage normal
 * produit (un to-do, une MR ou un ticket avec plus de 2000 entrées est une
 * anomalie, pas un cas nominal à optimiser), tout en empêchant qu'une
 * ressource massive ne déclenche un rapatriement sans fin qui bloquerait le
 * worker (celui-ci traite les to-dos en série, voir daemon/queue.ts).
 */
export const MAX_LIST_PAGES = 20;

// ---------------------------------------------------------------------------
// Patience face à GitLab — attente de cohérence après un changement de MR
// ---------------------------------------------------------------------------

/**
 * Nombre de tentatives (tasks/context.ts) pour attendre que GitLab regénère
 * diff_refs et /diffs après un recontrôle de mergeabilité, fenêtre pendant
 * laquelle les deux sont momentanément vides. Combinée à
 * DIFF_REFS_DELAY_MS, l'attente totale (10 s) est un compromis assumé :
 * assez longue pour couvrir la fenêtre de recalcul GitLab habituelle
 * (rare, mais réelle), assez courte pour ne pas retarder indéfiniment un
 * worker qui traite les to-dos en série. Non couvert par un mécanisme
 * évènementiel (un webhook GitLab ferait l'affaire mais est hors périmètre
 * de ce projet) : voir le commentaire complet à l'appel dans context.ts.
 */
export const DIFF_REFS_RETRIES = 5;

/** Délai entre deux tentatives ci-dessus, en millisecondes. */
export const DIFF_REFS_DELAY_MS = 2_000;

// ---------------------------------------------------------------------------
// Tailles de tampon — mémoire du process daemon
// ---------------------------------------------------------------------------

/**
 * Sortie capturée (stdout/stderr d'un agent ou d'une commande sandboxée),
 * conservée après troncature — voir agent/bounded-output.ts pour la
 * justification complète (pourquoi on tronque le DÉBUT et garde la FIN).
 * 4 Mo couvre largement une sortie normale (logs de tests, sortie de
 * l'agent) tout en bornant strictement la mémoire du process daemon
 * lui-même face à un cas dégénéré (boucle qui spamme stdout jusqu'au
 * timeout) — ce n'est pas la mémoire du conteneur qui est en jeu ici, mais
 * celle du daemon qui tient cette chaîne accumulée.
 */
export const DEFAULT_MAX_CAPTURED_OUTPUT_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Cycle de vie du daemon — arrêt et fichier d'état
// ---------------------------------------------------------------------------

/**
 * Délai maximal laissé à la tâche en cours pour se terminer d'elle-même à
 * l'arrêt du daemon (SIGINT/SIGTERM), avant abandon (daemon/index.ts). Ni
 * env var ni réglage d'exploitation : ce délai n'a jamais eu besoin d'être
 * ajusté en pratique, contrairement à pollIntervalMs ou aux timeouts de
 * commande (config.ts, eux réellement variables d'un déploiement à
 * l'autre). Un second signal pendant l'attente force la sortie immédiate,
 * sans passer par ce délai.
 */
export const SHUTDOWN_GRACE_MS = 30_000;

/**
 * Seuil (en lignes brutes relues au démarrage) au-delà duquel
 * daemon/store.ts compacte le fichier d'état plutôt que de le laisser
 * grossir indéfiniment — voir RequestStore dans store.ts pour le détail.
 * Un cycle de vie complet d'une demande écrit jusqu'à quatre lignes
 * (claimed → acked → running → done|failed) pour une seule information
 * utile au final (le dernier statut) : à quelques centaines de demandes
 * par jour, ce seuil est franchi en quelques jours d'exploitation. Trop
 * bas : on recompacte à chaque redémarrage un fichier encore minuscule,
 * pour rien. Trop haut : le fichier grossit longtemps avant le premier
 * compactage, alourdissant la relecture au démarrage.
 */
export const COMPACT_THRESHOLD_LINES = 500;

/**
 * Chantier « fil de discussion » (tasks/explain.ts) : bornes du prompt d'une
 * explication demandée dans un fil.
 *
 * Un fil de revue compte en pratique deux à cinq messages ; en garder vingt
 * couvre très large tout en bornant le cas d'un fil qui aurait dérivé en
 * conversation de trente échanges. Ce sont les DERNIERS qui sont gardés (la
 * question posée est toujours le dernier message), et la coupe est annoncée
 * dans le prompt plutôt que silencieuse.
 */
export const EXPLAIN_MAX_THREAD_NOTES = 20;

/** Plafond par message du fil : une remarque de revue tient très en dessous. */
export const EXPLAIN_NOTE_CHARS = 2_000;

/**
 * Lignes de source montrées de part et d'autre de la ligne visée par le fil.
 * 40 de chaque côté : de quoi voir une fonction entière et ses voisines, ce
 * qui est précisément là où se cachent les défauts qu'un diff seul masque
 * (voir le bloc « Méthode » du prompt de revue).
 */
export const EXPLAIN_SOURCE_CONTEXT_LINES = 40;

/**
 * Plafond de la réponse publiée. Une explication est faite pour être lue dans
 * un fil GitLab : au-delà, ce n'est plus une explication, c'est un rapport.
 */
export const EXPLAIN_ANSWER_CHARS = 6_000;
