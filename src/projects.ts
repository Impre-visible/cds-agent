import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { MAX_REVIEW_PASSES } from "./limits.ts";
import {
  isReviewPassMode,
  REVIEW_PASS_MODES,
  type ReviewPassMode,
} from "./tasks/passes.ts";

// ---------------------------------------------------------------------------
// Chantier "projects.json" — remplace la configuration par projet éclatée
// dans des variables d'environnement à rallonge (ALLOWED_PROJECTS,
// ALLOWED_USERS, AGENT_CAPABILITIES, DOCKER_IMAGES, TEST_COMMANDS,
// INSTALL_COMMANDS, TEST_DIRECTORY_OVERRIDES — voir config.ts pour le refus
// bruyant si l'une d'elles traîne encore dans l'environnement) par un fichier
// JSON versionné, lisible et relu par des humains (voir le rapport de la
// tâche : aucun secret n'y vit, le token reste dans l'environnement).
//
// Ce module est le point UNIQUE de lecture/validation/résolution de ce
// fichier — src/daemon/authorize.ts et src/tasks/openhands.ts consomment tous
// deux le même `ResolvedProject`, jamais une lecture parallèle.
//
// CE QUE CES CAPACITÉS VEULENT DIRE SUR CETTE BRANCHE. Elles décident
// toujours si une demande est acceptée (un dépôt qui n'accorde rien est
// refusé avant tout appel réseau, voir authorize.ts et
// tasks/openhands.ts). En revanche elles ne sont plus APPLIQUÉES sur ce que
// l'agent produit : le daemon ne clone plus, ne vérifie plus les fichiers
// touchés, ne rejoue plus les tests et ne publie plus lui-même — c'est
// OpenHands qui écrit et pousse. Elles sont énoncées à l'agent en toutes
// lettres (tasks/openhands.ts::permissionStatement) et rien de plus. Voir
// docs/openhands.md.
// ---------------------------------------------------------------------------

// Un composant "." ou ".." dans un motif : refusé inconditionnellement.
// Auparavant dans tasks/guard.ts, avec le reste du garde-fou de périmètre qui
// n'existe plus sur cette branche — seule la VALIDATION du fichier de
// configuration subsiste, et elle vit désormais là où le fichier est lu.
function hasUnsafeSegments(path: string): boolean {
  return path
    .split("/")
    .filter(Boolean)
    .some((segment) => segment === "." || segment === "..");
}

// Les seuls caractères qu'un motif de chemin peut contenir. Un "?" littéral,
// par exemple, agirait comme un quantificateur s'il était un jour compilé en
// expression régulière : mieux vaut le refuser à la lecture du fichier que
// laisser un motif se comporter autrement qu'annoncé.
const WRITABLE_PATH_PATTERN_CHARS = /^[A-Za-z0-9_./*-]+$/;

/**
 * Un motif bien formé pour `MergeRequestCapabilities.writablePaths` : non
 * vide, jamais absolu (les chemins d'un dépôt sont relatifs à sa racine — un
 * motif commençant par "/" ne désignerait jamais rien, une configuration
 * morte plutôt qu'une erreur visible), sans composant "." ou "..", et composé
 * uniquement des caractères ci-dessus.
 *
 * Appliqué au CHARGEMENT de projects.json, pour qu'un motif mal formé soit
 * nommé plutôt que silencieusement inopérant.
 */
export function isWellFormedWritablePathPattern(pattern: string): boolean {
  if (!pattern || pattern.startsWith("/")) return false;
  if (hasUnsafeSegments(pattern)) return false;
  return WRITABLE_PATH_PATTERN_CHARS.test(pattern);
}

/**
 * Capacités applicables quand la demande porte sur une ISSUE. Non câblées à
 * aucun comportement aujourd'hui : `src/tasks/openhands.ts` refuse toute
 * cible qui n'est pas une merge request avant même de regarder une
 * capacité. Validées et résolues malgré tout, pour que le format du
 * fichier soit stable dès maintenant et qu'une future prise en charge des
 * issues n'ait pas à changer le schéma — une entrée mal orthographiée y est
 * déjà rejetée bruyamment au démarrage, comme pour mergeRequest ci-dessous.
 */
export interface IssueCapabilities {
  review: boolean;
  createMergeRequest: boolean;
  writeTests: boolean;
  writeBusinessCode: boolean;
}

/** Capacités applicables quand la demande porte sur une MERGE REQUEST — le seul flux réellement câblé (voir tasks/openhands.ts). */
export interface MergeRequestCapabilities {
  review: boolean;
  writeTests: boolean;
  writeBusinessCode: boolean;
  /**
   * true : l'agent est autorisé à pousser directement sur la branche source.
   * false (le défaut) : il lui est demandé d'ouvrir plutôt une merge request
   * dédiée en Draft, à faire relire par un humain avant fusion. Sur cette
   * branche c'est une CONSIGNE dans le prompt (voir
   * tasks/openhands.ts::permissionStatement), pas un contrôle — le daemon ne
   * voit pas ce qui est poussé. Sans effet si ni writeTests ni
   * writeBusinessCode n'est accordé.
   */
  pushToSourceBranch: boolean;
  /**
   * Autorise les blocs `suggestion` — des corrections applicables en un clic
   * depuis l'interface GitLab, attachées à la remarque qui les motive.
   *
   * Défaut `false` : un dépôt existant ne change pas de comportement. Ce
   * n'est pas une capacité d'écriture (rien n'est poussé ; c'est un humain
   * qui applique, ou non), mais ça met un bouton « appliquer » sous un texte
   * écrit par un modèle — le mettre par défaut serait décider à la place du
   * mainteneur.
   *
   * À `true`, une ligne est ajoutée au message envoyé à l'agent. La SYNTAXE
   * et les pièges (ce qu'un bloc remplace exactement, comment ne pas
   * dupliquer ou effacer du code) restent dans la compétence
   * `gitlab-mr-review` : c'est le principe de cette branche, le message reste
   * court et la méthode vit dans une compétence.
   */
  suggestions: boolean;
  /**
   * Motifs glob ("**" et "*" seulement) élargissant PRÉCISÉMENT l'accès en
   * écriture à un sous-ensemble du dépôt,
   * en plus des chemins de test — l'entre-deux entre "writeTests" seul
   * (chemins de test uniquement) et "writeBusinessCode" (dépôt entier) que
   * l'ancien AGENT_CAPABILITIES exprimait sous la forme write:<glob> et que
   * la migration vers ce fichier avait perdu. Toujours résolu (jamais
   * undefined) : [] si non déclaré, comportement inchangé.
   *
   * Trois façons de décrire "quels chemins sont modifiables" ne s'empilent
   * pas sans règle : voir assertCoherentWritablePaths, appliquée à CHAQUE
   * dépôt déclaré au chargement du fichier (fail-closed, règle 1 — jamais une
   * combinaison ambiguë silencieusement résolue d'une façon plutôt qu'une
   * autre) :
   *  - writeBusinessCode: true accorde déjà tout le dépôt ; des motifs non
   *    vides à côté n'auraient AUCUN effet observable — configuration
   *    rejetée comme incohérente plutôt que silencieusement ignorée : mieux
   *    vaut que l'auteur choisisse explicitement.
   *  - un motif élargit TOUJOURS aussi l'accès aux chemins de test :
   *    writeTests: false à côté de motifs non vides serait trompeur (ce qui
   *    est annoncé à l'agent l'autoriserait quand même) — rejeté pour la
   *    même raison. writeTests: true est donc obligatoire dès qu'un motif
   *    est déclaré.
   *  - writeTests: true seul (motifs vides) : comportement inchangé,
   *    "tests-only".
   */
  writablePaths: string[];
}

/**
 * Flux à deux niveaux : l'agent planifie, puis délègue l'exécution à un
 * sous-agent (outil `delegate` du SDK OpenHands, commandes `spawn` puis
 * `delegate`). Le sous-agent tourne EN-PROCESS dans le même bac à sable, rend
 * son résultat au parent et disparaît — rien n'est écrit sur disque, rien ne
 * survit à la tâche.
 *
 * `enabled: false` par défaut, et ce défaut n'est pas cosmétique : la manche 3
 * du banc a fait BAISSER la couverture (25/25 → 23/25) en ajoutant deux
 * consignes. Une étape de planification est plus lourde que ça. Tant que son
 * effet n'est pas mesuré, l'activer par défaut casserait la comparabilité des
 * manches déjà faites.
 *
 * ⚠ CE QUE CE RÉGLAGE NE FAIT PAS. Il ne restreint RIEN mécaniquement. Voir
 * tasks/openhands.ts::delegationInstructions pour le détail : le sous-agent a
 * les mêmes outils et le même jeton que le parent, et c'est le MODÈLE qui
 * choisit le type de sous-agent qu'il instancie. Les capacités lui sont
 * répétées, comme au parent. Rien de plus.
 */
export interface DelegationConfig {
  enabled: boolean;
  /**
   * Demander un plan avant l'exécution. Sans effet si `enabled` est faux.
   *
   * Le plan n'est PUBLIÉ dans la merge request que lorsque le dépôt accorde
   * une capacité d'écriture — voir delegationInstructions. Sur une revue en
   * lecture seule il resterait interne : publier un plan pour une action qui
   * ne modifie rien ajoute un commentaire par tâche sans rien permettre
   * d'interrompre.
   */
  planFirst: boolean;
}

/**
 * Revue à passes multiples : N conversations OpenHands successives sur la même
 * merge request, la passe K recevant ce que les précédentes ont publié.
 *
 * À NE PAS CONFONDRE avec les tirages du banc (`bench.sh --runs N`), qui sont
 * N revues INDÉPENDANTES avec remise à zéro entre chaque et mesurent la
 * variance. Ici on ne remet rien à zéro et on mesure l'accumulation. Voir
 * l'en-tête de tasks/passes.ts.
 *
 * `passes: 1` par défaut : le message envoyé est alors identique AU CARACTÈRE
 * PRÈS à celui d'avant ce chantier (buildPassAddendum rend "" et rien n'est
 * concaténé), ce qui garde comparables les manches déjà mesurées.
 */
export interface ReviewConfig {
  /** Nombre de passes. 1 = comportement actuel, strictement inchangé. */
  passes: number;
  /**
   * Ce qu'on transmet à la passe suivante. `exclusion` par défaut — c'est le
   * seul des trois qui ait fait mieux que la passe unique dans la mesure ;
   * sans effet tant que `passes` vaut 1.
   */
  passMode: ReviewPassMode;
}

export interface ResolvedCapabilities {
  issue: IssueCapabilities;
  mergeRequest: MergeRequestCapabilities;
}

export interface CommandsConfig {
  install: string;
  test: string;
  /**
   * Motif (regex, insensible à la casse) qui, présent dans la sortie du
   * lanceur de tests, atteste que des ASSERTIONS ont réellement tourné et
   * échoué — par opposition à un fichier de test que le lanceur n'a même pas
   * pu exécuter. NON LU sur cette branche : le daemon ne rejoue aucune suite
   * de tests. Accepté pour qu'un même projects.json reste valide ici et sur
   * `hardening`, où il sert à distinguer une assertion en échec d'un fichier
   * cassé.
   */
  assertionPattern?: string;
}

export interface DockerConfig {
  image: string;
}

/** Un projet tel que résolu pour un dépôt donné : fusion en profondeur de "defaults" et de "projects.<chemin>" (voir resolveProject). */
export interface ResolvedProject {
  /** Noms d'utilisateur autorisés à déclencher le bot sur ce dépôt (comparaison insensible à la casse, voir daemon/authorize.ts). Vide : personne n'est autorisé (fail-closed). */
  users: string[];
  capabilities: ResolvedCapabilities;
  commands: CommandsConfig;
  docker: DockerConfig;
  /** Flux à deux niveaux — voir DelegationConfig. Toujours résolu. */
  delegation: DelegationConfig;
  /** Revue à passes multiples — voir ReviewConfig. Toujours résolu. */
  review: ReviewConfig;
  /** Répertoires de test maison. NON LUS sur cette branche (le daemon ne reconnaît plus les chemins de test lui-même) ; acceptés pour rester compatible avec `hardening`. */
  testDirectories: string[];
}

/**
 * Défauts globaux injectés par l'appelant (config.testCommand/installCommand/
 * dockerDefaultImage, TOUJOURS lus depuis l'environnement — n'ont pas migré
 * vers projects.json, contrairement aux variantes par-dépôt TEST_COMMANDS/
 * INSTALL_COMMANDS/DOCKER_IMAGES) : c'est le repli ultime quand ni
 * "projects.<chemin>" ni le bloc "defaults" du fichier ne précisent une
 * commande ou une image. resolveProject() reste une fonction pure — ce
 * baseline est un paramètre, jamais une lecture directe de `config` — pour
 * rester testable sans dépendre du process réellement chargé.
 */
export interface ProjectsBaseline {
  commands: CommandsConfig;
  docker: DockerConfig;
}

const ISSUE_CAPABILITY_KEYS = [
  "review",
  "createMergeRequest",
  "writeTests",
  "writeBusinessCode",
] as const;

const MERGE_REQUEST_CAPABILITY_KEYS = [
  "review",
  "suggestions",
  "writeTests",
  "writeBusinessCode",
  "pushToSourceBranch",
] as const;

// Clés acceptées dans le bloc "mergeRequest" au sens large : les booléens
// ci-dessus, plus "writablePaths" (motifs, pas un booléen — voir
// MergeRequestCapabilities.writablePaths) qui n'a donc pas sa place dans
// MERGE_REQUEST_CAPABILITY_KEYS (utilisée par parseBooleanCapabilities, qui
// ne sait valider QUE des booléens). Distinct d'ISSUE_CAPABILITY_KEYS : le
// champ est volontairement absent du bloc "issue" (comme pushToSourceBranch),
// ce flux n'étant pas câblé (voir router.ts) — rien n'empêcherait de l'y
// ajouter le jour où les issues auront elles aussi un writablePaths à offrir.
const MERGE_REQUEST_BLOCK_KEYS = [
  ...MERGE_REQUEST_CAPABILITY_KEYS,
  "writablePaths",
] as const;

// Base "tout refusé" : contrairement à commands/docker (qui ont un repli
// global légitime via ProjectsBaseline, hérité de TEST_COMMAND/
// INSTALL_COMMAND/DOCKER_DEFAULT_IMAGE), aucune capacité n'a jamais eu de
// défaut global avant ce chantier — DEFAULT_CAPABILITIES (guard.ts) n'existe
// que côté code, jamais côté configuration. Fail-closed : une capacité tue
// (absente de "defaults" ET de l'entrée du dépôt) vaut refus, jamais un accès
// silencieusement accordé.
const BASE_ISSUE_CAPABILITIES: IssueCapabilities = {
  review: false,
  createMergeRequest: false,
  writeTests: false,
  writeBusinessCode: false,
};

const BASE_MERGE_REQUEST_CAPABILITIES: MergeRequestCapabilities = {
  review: false,
  suggestions: false,
  writeTests: false,
  writeBusinessCode: false,
  pushToSourceBranch: false,
  writablePaths: [],
};

/**
 * Bloc "delegation", validé comme les autres : une clé inconnue ou une valeur
 * non booléenne fait échouer le chargement plutôt que d'être ignorée en
 * silence. Un `"enable": true` mal orthographié qui ne ferait rien serait
 * exactement le genre de configuration muette que ce fichier refuse.
 */
function parseDelegationBlock(
  raw: unknown,
  path: string,
): Partial<DelegationConfig> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error(`projects.json invalide : "${path}" doit être un objet`);
  }
  assertOnlyKeys(raw, ["enabled", "planFirst"], path);

  const block: Partial<DelegationConfig> = {};
  for (const key of ["enabled", "planFirst"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new Error(
        `projects.json invalide : "${path}.${key}" doit être un booléen (reçu ${JSON.stringify(value)})`,
      );
    }
    block[key] = value;
  }
  return block;
}

/**
 * Bloc "review", validé comme les autres.
 *
 * `passes` doit être un entier de 1 à MAX_REVIEW_PASSES. Le plafond n'est pas
 * de la prudence rituelle : chaque passe est une conversation complète, donc
 * un bac à sable, un délai d'attente et un coût de modèle de plus. Un
 * `"passes": 30` posé par erreur bloquerait le worker des heures — il traite
 * les demandes en série.
 *
 * `passMode` est validé contre la liste exacte : un mode inconnu ferait
 * silencieusement autre chose que ce qui est écrit, et c'est précisément la
 * différence entre `chained` et `exclusion` qui décide du résultat.
 */
function parseReviewBlock(
  raw: unknown,
  path: string,
): Partial<ReviewConfig> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error(`projects.json invalide : "${path}" doit être un objet`);
  }
  assertOnlyKeys(raw, ["passes", "passMode"], path);

  const block: Partial<ReviewConfig> = {};

  if (raw.passes !== undefined) {
    const passes = raw.passes;
    if (
      typeof passes !== "number" ||
      !Number.isInteger(passes) ||
      passes < 1 ||
      passes > MAX_REVIEW_PASSES
    ) {
      throw new Error(
        `projects.json invalide : "${path}.passes" doit être un entier entre 1 et ` +
          `${MAX_REVIEW_PASSES} (reçu ${JSON.stringify(passes)})`,
      );
    }
    block.passes = passes;
  }

  if (raw.passMode !== undefined) {
    if (!isReviewPassMode(raw.passMode)) {
      throw new Error(
        `projects.json invalide : "${path}.passMode" doit valoir ` +
          `${REVIEW_PASS_MODES.map((mode) => `"${mode}"`).join(", ")} ` +
          `(reçu ${JSON.stringify(raw.passMode)})`,
      );
    }
    block.passMode = raw.passMode;
  }

  return block;
}

type PartialCapabilities<K extends string> = Partial<Record<K, boolean>>;

/** Bloc "mergeRequest" tel que parsé : les booléens (partiels), plus "writablePaths" (partiel lui aussi — absent tant que non déclaré, ni par defaults ni par le projet). */
type ParsedMergeRequestBlock = PartialCapabilities<(typeof MERGE_REQUEST_CAPABILITY_KEYS)[number]> & {
  writablePaths?: string[];
};

interface ParsedCapabilitiesBlock {
  issue: PartialCapabilities<(typeof ISSUE_CAPABILITY_KEYS)[number]>;
  mergeRequest: ParsedMergeRequestBlock;
}

interface ParsedCommandsBlock {
  install?: string;
  test?: string;
  assertionPattern?: string;
}

interface ParsedDockerBlock {
  image?: string;
}

/** Champs communs à "defaults" et à chaque entrée de "projects" — seule "users" n'a de sens que par dépôt (voir ParsedEntry). */
interface ParsedCommonFields {
  capabilities: ParsedCapabilitiesBlock;
  commands: ParsedCommandsBlock;
  docker: ParsedDockerBlock;
  testDirectories?: string[];
  delegation?: Partial<DelegationConfig> | undefined;
  review?: Partial<ReviewConfig> | undefined;
}

interface ParsedEntry extends ParsedCommonFields {
  users: string[];
}

/** Fichier projects.json une fois lu, parsé en JSON et validé — jamais la forme brute au-delà de parseProjectsFile. */
export interface ProjectsFile {
  defaults: ParsedCommonFields;
  /** Clé = chemin de dépôt en minuscules, comme ALLOWED_PROJECTS/ALLOWED_USERS avant ce chantier. */
  projects: Map<string, ParsedEntry>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fail-closed délibéré (§ règle 1 du chantier) : une clé qui n'est pas dans
 * `allowed` fait échouer le démarrage en la NOMMANT explicitement, avec son
 * chemin complet dans le fichier — jamais ignorée en silence. C'est la
 * garantie qu'une capacité mal orthographiée ("writeTest" au lieu de
 * "writeTests") ne se traduit jamais par un "false" qu'on croit avoir choisi
 * alors qu'il n'a jamais été lu.
 */
function assertOnlyKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `projects.json invalide : clé inconnue "${path}.${key}" — attendu : ${allowed.join(", ")}`,
      );
    }
  }
}

/**
 * Lit les champs booléens de `keys` présents dans `raw`, en ignorant ceux qui
 * ne le sont pas (fusion en profondeur oblige : "absent" doit rester
 * distinguable de "false", voir resolveProject). Ne valide PAS que `raw` ne
 * contient que ces clés — c'est la responsabilité de l'appelant (assertOnlyKeys),
 * car parseMergeRequestCapabilities ci-dessous a besoin d'accepter une clé
 * supplémentaire ("writablePaths", pas un booléen) que cette fonction ne sait
 * pas traiter elle-même.
 */
function parseBooleanFields<K extends string>(
  raw: Record<string, unknown>,
  keys: readonly K[],
  path: string,
): PartialCapabilities<K> {
  const result: PartialCapabilities<K> = {};
  for (const key of keys) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value !== "boolean") {
      throw new Error(
        `projects.json invalide : "${path}.${key}" doit être un booléen (true/false), pas ${JSON.stringify(value)}`,
      );
    }
    result[key] = value;
  }
  return result;
}

function parseBooleanCapabilities<K extends string>(
  raw: unknown,
  keys: readonly K[],
  path: string,
): PartialCapabilities<K> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new Error(`projects.json invalide : "${path}" doit être un objet`);
  }
  assertOnlyKeys(raw, keys, path);
  return parseBooleanFields(raw, keys, path);
}

/**
 * Bloc "mergeRequest" : les mêmes booléens que parseBooleanCapabilities,
 * plus "writablePaths" (motifs glob, voir MergeRequestCapabilities.
 * writablePaths) — la seule raison pour laquelle ce bloc n'utilise pas
 * directement parseBooleanCapabilities. Un motif mal formé (voir
 * isWellFormedWritablePathPattern ci-dessus) fait échouer le chargement
 * en le citant, comme toute autre valeur invalide de ce fichier — jamais
 * silencieusement ignoré ni laissé produire un filtre qui ne se comporte pas
 * comme annoncé.
 */
function parseMergeRequestCapabilities(raw: unknown, path: string): ParsedMergeRequestBlock {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new Error(`projects.json invalide : "${path}" doit être un objet`);
  }
  assertOnlyKeys(raw, MERGE_REQUEST_BLOCK_KEYS, path);

  const booleans = parseBooleanFields(raw, MERGE_REQUEST_CAPABILITY_KEYS, path);

  if (!("writablePaths" in raw)) return booleans;

  const patterns = parseStringArray(raw.writablePaths, `${path}.writablePaths`, "motifs glob") ?? [];
  for (const pattern of patterns) {
    if (!isWellFormedWritablePathPattern(pattern)) {
      throw new Error(
        `projects.json invalide : "${path}.writablePaths" contient un motif mal formé (${JSON.stringify(pattern)}) — un motif doit être un chemin RELATIF (jamais commencer par "/"), sans composant "." ou "..", et n'utiliser que des lettres/chiffres/"-"/"_"/"."/"/" et les jokers "*"/"**"`,
      );
    }
  }
  return { ...booleans, writablePaths: patterns };
}

/**
 * Rejette les combinaisons ambiguës entre les trois façons de décrire "quels
 * chemins sont modifiables" pour une MERGE REQUEST (voir le commentaire de
 * MergeRequestCapabilities.writablePaths) : appelée avec la capacité déjà
 * fusionnée (BASE + defaults + entrée du projet, comme resolveProject),
 * jamais avec un fragment isolé — une ambiguïté peut naître du croisement de
 * deux blocs qui, pris séparément, semblent chacun cohérents (defaults pose
 * writeBusinessCode, le projet ne pose que des motifs, par exemple).
 */
function assertCoherentWritablePaths(capabilities: MergeRequestCapabilities, path: string): void {
  if (capabilities.writeBusinessCode && capabilities.writablePaths.length > 0) {
    throw new Error(
      `projects.json invalide : "${path}" incohérent — "writeBusinessCode": true accorde déjà tout le dépôt, "writablePaths" (${JSON.stringify(capabilities.writablePaths)}) n'aurait alors aucun effet observable ; retirez l'un des deux pour lever l'ambiguïté`,
    );
  }
  if (!capabilities.writeTests && capabilities.writablePaths.length > 0) {
    throw new Error(
      `projects.json invalide : "${path}" incohérent — "writablePaths" (${JSON.stringify(capabilities.writablePaths)}) élargit toujours aussi l'accès aux chemins de test, donc "writeTests": false à côté de motifs non vides est contradictoire ; passez "writeTests" à true`,
    );
  }
}

/** Fusion en profondeur, champ par champ, de la capacité "mergeRequest" — factorisée pour que la validation (assertCoherentWritablePaths, appliquée au résultat) et resolveProject partagent la MÊME règle de fusion. */
function mergeMergeRequestCapabilities(
  defaultsBlock: ParsedMergeRequestBlock,
  entryBlock: ParsedMergeRequestBlock,
): MergeRequestCapabilities {
  return {
    ...BASE_MERGE_REQUEST_CAPABILITIES,
    ...defaultsBlock,
    ...entryBlock,
  };
}

function parseCapabilitiesBlock(raw: unknown, path: string): ParsedCapabilitiesBlock {
  if (raw === undefined) return { issue: {}, mergeRequest: {} };
  if (!isPlainObject(raw)) {
    throw new Error(`projects.json invalide : "${path}" doit être un objet`);
  }
  assertOnlyKeys(raw, ["issue", "mergeRequest"], path);
  return {
    issue: parseBooleanCapabilities(raw.issue, ISSUE_CAPABILITY_KEYS, `${path}.issue`),
    mergeRequest: parseMergeRequestCapabilities(raw.mergeRequest, `${path}.mergeRequest`),
  };
}

function parseCommandsBlock(raw: unknown, path: string): ParsedCommandsBlock {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new Error(`projects.json invalide : "${path}" doit être un objet`);
  }
  assertOnlyKeys(raw, ["install", "test", "assertionPattern"], path);

  const result: ParsedCommandsBlock = {};
  for (const key of ["install", "test", "assertionPattern"] as const) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(
        `projects.json invalide : "${path}.${key}" doit être une chaîne non vide`,
      );
    }
    result[key] = value;
  }

  // Une regex invalide échouerait bien plus tard, au moment de classifier la
  // sortie d'une suite de tests — loin du réglage fautif. Même politique que
  // le reste du fichier : refuser au chargement, en nommant le champ.
  if (result.assertionPattern !== undefined) {
    try {
      new RegExp(result.assertionPattern, "i");
    } catch (error) {
      throw new Error(
        `projects.json invalide : "${path}.assertionPattern" n'est pas une regex valide — ${(error as Error).message}`,
      );
    }
  }
  return result;
}

function parseDockerBlock(raw: unknown, path: string): ParsedDockerBlock {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new Error(`projects.json invalide : "${path}" doit être un objet`);
  }
  assertOnlyKeys(raw, ["image"], path);

  const result: ParsedDockerBlock = {};
  if ("image" in raw) {
    const value = raw.image;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`projects.json invalide : "${path}.image" doit être une chaîne non vide`);
    }
    result.image = value;
  }
  return result;
}

function parseStringArray(raw: unknown, path: string, label: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((value) => typeof value === "string" && value.trim())) {
    throw new Error(`projects.json invalide : "${path}" doit être un tableau de ${label} non vides`);
  }
  return raw;
}

/**
 * Valide une valeur déjà parsée en JSON (JSON.parse) contre le schéma
 * projects.json. Fonction pure exportée séparément du chargement fichier
 * (voir ProjectsRegistry plus bas) pour être testable sans toucher au
 * système de fichiers — voir tests/projects.test.ts.
 *
 * Fail-closed partout (règle 1 du chantier) : "projects" est obligatoire
 * (même vide : {} — aucun dépôt n'est alors jamais autorisé), toute clé
 * inconnue à n'importe quel niveau fait échouer le parsing en la nommant.
 */
export function parseProjectsFile(raw: unknown): ProjectsFile {
  if (!isPlainObject(raw)) {
    throw new Error("projects.json invalide : le contenu doit être un objet JSON");
  }
  assertOnlyKeys(raw, ["defaults", "projects"], "");

  const defaultsRaw = raw.defaults;
  if (defaultsRaw !== undefined && !isPlainObject(defaultsRaw)) {
    throw new Error('projects.json invalide : "defaults" doit être un objet');
  }
  if (isPlainObject(defaultsRaw)) {
    assertOnlyKeys(
      defaultsRaw,
      ["capabilities", "commands", "docker", "testDirectories", "delegation", "review"],
      "defaults",
    );
  }

  const defaults = {
    capabilities: parseCapabilitiesBlock(
      isPlainObject(defaultsRaw) ? defaultsRaw.capabilities : undefined,
      "defaults.capabilities",
    ),
    commands: parseCommandsBlock(
      isPlainObject(defaultsRaw) ? defaultsRaw.commands : undefined,
      "defaults.commands",
    ),
    docker: parseDockerBlock(
      isPlainObject(defaultsRaw) ? defaultsRaw.docker : undefined,
      "defaults.docker",
    ),
    delegation: parseDelegationBlock(
      isPlainObject(defaultsRaw) ? defaultsRaw.delegation : undefined,
      "defaults.delegation",
    ),
    review: parseReviewBlock(
      isPlainObject(defaultsRaw) ? defaultsRaw.review : undefined,
      "defaults.review",
    ),
    testDirectories: parseStringArray(
      isPlainObject(defaultsRaw) ? defaultsRaw.testDirectories : undefined,
      "defaults.testDirectories",
      "noms de répertoire",
    ),
  };

  // "defaults" seul, fusionné avec le socle "tout refusé" (comme le ferait
  // resolveProject pour un projet qui ne surcharge rien) : une incohérence
  // posée ici se répercuterait sur tout projet qui ne la corrige pas — autant
  // la signaler tout de suite plutôt que d'attendre qu'un projet en hérite.
  assertCoherentWritablePaths(
    mergeMergeRequestCapabilities(defaults.capabilities.mergeRequest, {}),
    "defaults.capabilities.mergeRequest",
  );

  const projectsRaw = raw.projects;
  if (!isPlainObject(projectsRaw)) {
    throw new Error(
      'projects.json invalide : "projects" est obligatoire et doit être un objet (même vide : {} — fail-closed, aucun dépôt n\'est alors autorisé)',
    );
  }

  const projects = new Map<string, ParsedEntry>();
  for (const [projectPath, entryRaw] of Object.entries(projectsRaw)) {
    const path = `projects["${projectPath}"]`;
    if (!isPlainObject(entryRaw)) {
      throw new Error(`projects.json invalide : "${path}" doit être un objet`);
    }
    assertOnlyKeys(
      entryRaw,
      ["users", "capabilities", "commands", "docker", "testDirectories", "delegation", "review"],
      path,
    );

    const users = parseStringArray(entryRaw.users, `${path}.users`, "noms d'utilisateur") ?? [];

    const key = projectPath.toLowerCase();
    if (projects.has(key)) {
      throw new Error(
        `projects.json invalide : dépôt "${projectPath}" déclaré plusieurs fois (comparaison insensible à la casse)`,
      );
    }

    const capabilities = parseCapabilitiesBlock(entryRaw.capabilities, `${path}.capabilities`);

    // Validée sur le résultat FUSIONNÉ (defaults + entrée de ce projet),
    // exactement ce que resolveProject produira pour de vrai — une ambiguïté
    // qui ne naît que du croisement des deux blocs (l'un pose
    // writeBusinessCode, l'autre des motifs) doit échouer ici aussi, pas
    // seulement quand les deux champs cohabitent dans le même bloc.
    assertCoherentWritablePaths(
      mergeMergeRequestCapabilities(defaults.capabilities.mergeRequest, capabilities.mergeRequest),
      `${path}.capabilities.mergeRequest`,
    );

    projects.set(key, {
      users,
      capabilities,
      commands: parseCommandsBlock(entryRaw.commands, `${path}.commands`),
      docker: parseDockerBlock(entryRaw.docker, `${path}.docker`),
      testDirectories: parseStringArray(entryRaw.testDirectories, `${path}.testDirectories`, "noms de répertoire"),
      delegation: parseDelegationBlock(entryRaw.delegation, `${path}.delegation`),
      review: parseReviewBlock(entryRaw.review, `${path}.review`),
    });
  }

  return { defaults, projects };
}

/**
 * Résout la configuration effective d'un dépôt : `null` si le dépôt n'a pas
 * d'entrée dans "projects" (fail-closed — voir daemon/authorize.ts, qui
 * traite ce cas exactement comme l'ancien refus silencieux "hors
 * ALLOWED_PROJECTS"). Sinon, fusion en profondeur, CHAMP PAR CHAMP :
 * "projects.<chemin>" surcharge "defaults", qui lui-même surcharge la base
 * interne "tout refusé" (capacités) ou le `baseline` fourni par l'appelant
 * (commandes/image — voir ProjectsBaseline). Une capacité omise partout
 * retombe donc sur false, jamais sur un accès accordé par défaut.
 */
export function resolveProject(
  file: ProjectsFile,
  projectPath: string,
  baseline: ProjectsBaseline,
): ResolvedProject | null {
  const entry = file.projects.get(projectPath.toLowerCase());
  if (!entry) return null;

  return {
    users: entry.users,
    capabilities: {
      issue: {
        ...BASE_ISSUE_CAPABILITIES,
        ...file.defaults.capabilities.issue,
        ...entry.capabilities.issue,
      },
      mergeRequest: mergeMergeRequestCapabilities(
        file.defaults.capabilities.mergeRequest,
        entry.capabilities.mergeRequest,
      ),
    },
    commands: {
      install:
        entry.commands.install ?? file.defaults.commands.install ?? baseline.commands.install,
      test: entry.commands.test ?? file.defaults.commands.test ?? baseline.commands.test,
      // Pas de repli baseline : aucun équivalent env (le défaut vit dans
      // implement.ts, au plus près du classifieur qui l'applique).
      assertionPattern:
        entry.commands.assertionPattern ?? file.defaults.commands.assertionPattern,
    },
    docker: {
      image: entry.docker.image ?? file.defaults.docker.image ?? baseline.docker.image,
    },
    testDirectories: entry.testDirectories ?? file.defaults.testDirectories ?? [],
    delegation: {
      // Fail-closed comme les capacités : non déclaré ⇒ désactivé. Le défaut
      // du bloc "defaults" s'applique, puis celui du projet le surcharge.
      enabled:
        entry.delegation?.enabled ?? file.defaults.delegation?.enabled ?? false,
      planFirst:
        entry.delegation?.planFirst ?? file.defaults.delegation?.planFirst ?? false,
    },
    review: {
      // 1 par défaut : le message envoyé reste identique au caractère près à
      // celui d'avant ce chantier, ce qui garde comparables les manches déjà
      // mesurées. Voir ReviewConfig.
      passes: entry.review?.passes ?? file.defaults.review?.passes ?? 1,
      passMode:
        entry.review?.passMode ?? file.defaults.review?.passMode ?? "exclusion",
    },
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readProjectsFileText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `fichier de configuration des projets introuvable ou illisible (${path}) : ${(error as Error).message}`,
    );
  }
}

function parseProjectsFileText(raw: string, path: string): ProjectsFile {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} : JSON invalide — ${(error as Error).message}`);
  }
  return parseProjectsFile(json);
}

/**
 * Chargement direct (sans suivi de rechargement) — utilisé par les outils
 * dry-run (tools/dry-*.ts) qui n'ont besoin que d'une lecture ponctuelle,
 * jamais d'un rechargement à chaud. Fatal comme ProjectsRegistry.loadFromPath
 * ci-dessous : un fichier absent, illisible ou invalide y échoue bruyamment.
 */
export function loadProjectsFile(path: string): ProjectsFile {
  return parseProjectsFileText(readProjectsFileText(path), path);
}

/** Premier dépôt déclaré, dans l'ordre d'apparition du fichier — les outils dry-run n'en ont besoin que d'un seul. */
export function firstProjectPath(file: ProjectsFile): string | undefined {
  return file.projects.keys().next().value;
}

export interface ProjectsReloadResult {
  reloaded: boolean;
  /** Présent uniquement si le rechargement a été TENTÉ et a échoué — la configuration précédente reste alors en vigueur (voir reloadIfChanged). */
  error?: Error;
}

/**
 * Détient la dernière configuration `projects.json` valide, avec support du
 * rechargement à chaud (règle "Rechargement à chaud" du chantier) :
 * `daemon/index.ts::poll()` appelle `reloadIfChanged()` à chaque cycle, juste
 * avant `collectTodos()`. Une empreinte de contenu (sha256), pas un simple
 * horodatage : robuste à une réécriture rapide (deux `writeFileSync`
 * successifs dans le même test, par exemple) où la résolution de `mtime` du
 * système de fichiers pourrait ne pas avoir changé.
 */
export class ProjectsRegistry {
  private file: ProjectsFile;
  private fingerprint: string;

  private constructor(file: ProjectsFile, fingerprint: string) {
    this.file = file;
    this.fingerprint = fingerprint;
  }

  /**
   * Chargement initial : FATAL si le fichier est absent, illisible ou
   * invalide — c'est le comportement voulu au démarrage (règle 1 du
   * chantier : "fichier absent ou illisible → le daemon ne démarre pas"),
   * à la différence de reloadIfChanged ci-dessous.
   */
  static loadFromPath(path: string): ProjectsRegistry {
    const raw = readProjectsFileText(path);
    const file = parseProjectsFileText(raw, path);
    return new ProjectsRegistry(file, sha256(raw));
  }

  /**
   * Recharge si l'empreinte du fichier a changé depuis le dernier
   * chargement réussi. NE JETTE JAMAIS : si la lecture échoue ou si le
   * contenu est devenu invalide, l'erreur est renvoyée dans le résultat et
   * LA CONFIGURATION PRÉCÉDENTE RESTE EN VIGUEUR — c'est à l'appelant
   * (daemon/index.ts::poll()) de la journaliser bruyamment sans faire
   * tomber le daemon (règle "Rechargement à chaud" : différent du
   * chargement initial, fatal, lui).
   */
  reloadIfChanged(path: string): ProjectsReloadResult {
    let raw: string;
    try {
      raw = readProjectsFileText(path);
    } catch (error) {
      return { reloaded: false, error: error as Error };
    }

    const fingerprint = sha256(raw);
    if (fingerprint === this.fingerprint) return { reloaded: false };

    try {
      const file = parseProjectsFileText(raw, path);
      this.file = file;
      this.fingerprint = fingerprint;
      return { reloaded: true };
    } catch (error) {
      return { reloaded: false, error: error as Error };
    }
  }

  resolve(projectPath: string, baseline: ProjectsBaseline): ResolvedProject | null {
    return resolveProject(this.file, projectPath, baseline);
  }

  firstProjectPath(): string | undefined {
    return firstProjectPath(this.file);
  }
}
