/**
 * §5.8 : ce fichier rassemble les constantes qui encodent de vraies
 * décisions — verbosité de ce qu'on republie (GitLab ou logs), patience face
 * à GitLab et à OpenHands, seuils de compaction — plutôt que de les laisser
 * dispersées, sous des noms parfois presque identiques (MAX_NOTE_PAGES /
 * MAX_NOTES_PAGES...), au milieu d'une dizaine de fichiers où elles
 * deviennent invisibles comme arbitrages.
 *
 * Ce fichier a beaucoup MAIGRI sur cette branche : tout le budget de contexte
 * envoyé au modèle (plafonds de diff, de description de ticket, de
 * commentaires humains, motifs de fichiers générés) est parti avec les
 * modules qui construisaient les prompts. Le daemon n'envoie plus de contexte
 * à un modèle — c'est OpenHands qui explore. Ce qui remplace ces plafonds vit
 * dans la configuration d'OpenHands (voir docs/openhands.md).
 *
 * Ce qui n'est délibérément PAS ici : les réglages d'exploitation (timeouts,
 * tentatives, intervalles de polling...) vivent dans src/config.ts,
 * ajustables par variable d'environnement sans recompiler.
 *
 * Chaque constante ci-dessous porte, dans son commentaire, ce qu'elle arbitre
 * réellement — pas "nombre maximal de caractères" mais pourquoi ce nombre-là,
 * ce qui casse en dessous, ce qui casse au-dessus. Module volontairement sans
 * dépendance : une simple table de constantes, importable de n'importe où
 * sans jamais risquer un cycle d'imports.
 */

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
// OpenHands — patience du sondage
// ---------------------------------------------------------------------------

/**
 * Équivalent de GITLAB_ERROR_BODY_CHARS pour une OpenHandsError
 * (openhands/client.ts). Même valeur et même raison : le corps peut être une
 * trace Python complète ou la page d'erreur d'un reverse proxy.
 */
export const OPENHANDS_ERROR_BODY_CHARS = 400;

/**
 * Intervalle entre deux sondages du DÉMARRAGE d'une conversation OpenHands
 * (statut de l'AppConversationStartTask). Court : la séquence complète —
 * bac à sable, clone, script de setup, compétences — prend quelques dizaines
 * de secondes, et c'est la phase où un échec doit se dire vite.
 */
export const OPENHANDS_START_POLL_MS = 2_000;

/**
 * Budget de temps du seul DÉMARRAGE, distinct du budget de la tâche
 * (OPENHANDS_TIMEOUT_MINUTES, voir config.ts). Un bac à sable qui ne démarre
 * pas ne démarrera pas davantage en attendant l'heure : mieux vaut rendre la
 * main au demandeur avec un message clair. 5 min couvrent largement un
 * premier lancement qui doit encore télécharger l'image de l'agent-server.
 */
export const OPENHANDS_START_TIMEOUT_MS = 5 * 60_000;

/**
 * Intervalle entre deux sondages de l'EXÉCUTION. Nettement plus long que le
 * sondage du démarrage : la latence n'est pas un critère ici (le compte rendu
 * est publié quand le travail est fini, personne n'attend devant l'écran),
 * et une revue dure des minutes — marteler l'API n'apprendrait rien de plus.
 */
export const OPENHANDS_POLL_MS = 10_000;

// ---------------------------------------------------------------------------
// Revue à passes multiples — taille de l'addendum d'exclusion
// ---------------------------------------------------------------------------

/**
 * Nombre de remarques antérieures listées dans l'addendum d'une passe.
 *
 * Mesuré sur `hardening` : un addendum long fait PERDRE des passes (mode
 * exclusion, 2 passes utiles sur 3 contre 3 sur 3 en independent). La liste
 * sert à dire « pas ça », pas à transmettre la revue — au-delà, elle occupe
 * le contexte que la passe devrait dépenser à chercher ailleurs.
 */
export const MAX_PREVIOUS_REMARKS_LISTED = 40;

/**
 * Longueur de la formulation courte d'une remarque antérieure. Assez pour
 * reconnaître le défaut, trop peu pour le re-expliquer — ce qui est exactement
 * l'effet recherché.
 */
export const MAX_PREVIOUS_REMARK_CHARS = 120;

/**
 * Plafond de `review.passes` dans projects.json.
 *
 * Chaque passe est une conversation complète : un bac à sable, un délai
 * d'attente entier, un coût de modèle. Le worker traite les demandes EN SÉRIE
 * (voir daemon/queue.ts), donc un `"passes": 30` posé par erreur immobiliserait
 * le bot des heures sans que rien ne le signale. Cinq laisse largement de quoi
 * mesurer un protocole dont on sait déjà que la troisième passe est la
 * dernière à rapporter quelque chose.
 */
export const MAX_REVIEW_PASSES = 5;

// ---------------------------------------------------------------------------
// Pagination GitLab — plafonds de sécurité sur les collections paginées
// ---------------------------------------------------------------------------

/**
 * Nombre maximal de pages explorées pour une collection GitLab paginée
 * (to-dos, notes d'une issue ou d'une MR) — voir gitlab/client.ts::paginate.
 * Avec per_page=100, borne le pire cas à 2000
 * éléments par collection : largement au-delà de ce qu'un usage normal
 * produit (un to-do, une MR ou un ticket avec plus de 2000 entrées est une
 * anomalie, pas un cas nominal à optimiser), tout en empêchant qu'une
 * ressource massive ne déclenche un rapatriement sans fin qui bloquerait le
 * worker (celui-ci traite les to-dos en série, voir daemon/queue.ts).
 */
export const MAX_LIST_PAGES = 20;

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
 *
 * Ce que ce délai NE couvre PLUS : le daemon n'a plus de conteneur ni
 * d'espace de travail à nettoyer. Ce qui reste en vol est une conversation
 * OpenHands, qui survit à cet arrêt et continue son travail — voir
 * tasks/openhands.ts.
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
