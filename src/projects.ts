import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isWellFormedWritablePathPattern, type RepoCapabilities } from "./tasks/guard.ts";

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
// fichier — src/daemon/authorize.ts, src/tasks/guard.ts (via
// repoCapabilitiesFor), src/tasks/implement.ts et src/agent/sandbox.ts
// consomment tous le même `ResolvedProject`, jamais une lecture parallèle.
// ---------------------------------------------------------------------------

/**
 * Capacités applicables quand la demande porte sur une ISSUE. Non câblées à
 * aucun comportement aujourd'hui : `src/tasks/router.ts` refuse encore toute
 * cible qui n'est pas une merge request avant même de regarder une capacité
 * (voir router.ts). Validées et résolues malgré tout, pour que le format du
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

/** Capacités applicables quand la demande porte sur une MERGE REQUEST — le seul flux réellement câblé aujourd'hui (voir router.ts). */
export interface MergeRequestCapabilities {
  review: boolean;
  writeTests: boolean;
  writeBusinessCode: boolean;
  /**
   * true : push direct sur la branche source une fois tous les contrôles
   * passés (comportement historique). false (également le défaut du bloc
   * "defaults" documenté par le propriétaire) : le bot pousse sur une
   * branche cds-agent/... dédiée et ouvre une merge request qui cible la
   * branche source, à faire relire par un humain avant fusion — voir
   * tasks/implement.ts::openDedicatedMergeRequest. Sans effet si ni
   * writeTests ni writeBusinessCode n'est accordé : aucune écriture n'a
   * jamais lieu, il n'y a rien à publier.
   */
  pushToSourceBranch: boolean;
  /**
   * Motifs glob (voir tasks/guard.ts::globToRegExp — "**" et "*" seulement)
   * élargissant PRÉCISÉMENT l'accès en écriture à un sous-ensemble du dépôt,
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
   *    vides à côté n'auraient AUCUN effet observable (repoCapabilitiesFor
   *    ferait de toute façon primer "all") — configuration rejetée comme
   *    incohérente plutôt que silencieusement ignorée : mieux vaut que
   *    l'auteur choisisse explicitement.
   *  - un motif élargit TOUJOURS aussi l'accès aux chemins de test (voir
   *    tasks/guard.ts::isWritablePath, qui vérifie isTestPath avant les
   *    motifs, quel que soit leur contenu) : writeTests: false à côté de
   *    motifs non vides serait trompeur (l'agent écrirait des tests malgré
   *    tout) — rejeté pour la même raison. writeTests: true est donc
   *    obligatoire dès qu'un motif est déclaré.
   *  - writeTests: true seul (motifs vides) : comportement inchangé,
   *    "tests-only".
   */
  writablePaths: string[];
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
   * pu exécuter (faute de syntaxe, import manquant). tasks/implement.ts s'en
   * sert pour ne préserver en MR Draft "à trancher" que le premier cas : le
   * second est du bruit pur, rapporté comme un échec. Optionnel — le défaut
   * (classifyRedSuite, implement.ts) couvre Vitest/Jest/node:test avec un
   * repli conservateur (sortie non reconnue ⇒ préserver) ; cette clé n'existe
   * que pour un lanceur au format de sortie différent. Attention : un motif
   * fourni a un contrat BINAIRE — il matche ⇒ assertions en échec, il ne
   * matche pas ⇒ fichier cassé — le repli conservateur ne s'applique qu'au
   * défaut. Un dépôt qui fournit son motif définit son signal, et l'assume.
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
  /** Répertoires de test maison, en plus des conventions standard reconnues par tasks/guard.ts::isTestPath — remplace TEST_DIRECTORY_OVERRIDES. */
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
  writeTests: false,
  writeBusinessCode: false,
  pushToSourceBranch: false,
  writablePaths: [],
};

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
 * tasks/guard.ts::isWellFormedWritablePathPattern) fait échouer le chargement
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
        `projects.json invalide : "${path}.writablePaths" contient un motif mal formé (${JSON.stringify(pattern)}) — un motif doit être un chemin RELATIF (jamais commencer par "/"), sans composant "." ou "..", et n'utiliser que des lettres/chiffres/"-"/"_"/"."/"/" et les jokers "*"/"**" (voir src/tasks/guard.ts::globToRegExp)`,
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
      `projects.json invalide : "${path}" incohérent — "writablePaths" (${JSON.stringify(capabilities.writablePaths)}) élargit toujours aussi l'accès aux chemins de test (voir tasks/guard.ts::isWritablePath), donc "writeTests": false à côté de motifs non vides est contradictoire ; passez "writeTests" à true`,
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
      ["capabilities", "commands", "docker", "testDirectories"],
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
    assertOnlyKeys(entryRaw, ["users", "capabilities", "commands", "docker", "testDirectories"], path);

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
  };
}

/**
 * Traduit les capacités "mergeRequest" résolues en RepoCapabilities
 * (tasks/guard.ts) — le modèle plus ancien et plus général qu'isWritablePath/
 * collectChanges consomment déjà, inchangé par ce chantier (aucune raison de
 * dupliquer son garde-fou). Priorité, du plus large au plus étroit :
 * writeBusinessCode ("all", englobe déjà tout) > writablePaths non vide
 * (motifs, l'entre-deux — voir MergeRequestCapabilities.writablePaths) >
 * writeTests ("tests-only") > "none". Cette priorité ne masque jamais une
 * combinaison ambiguë en silence : assertCoherentWritablePaths (appelée au
 * chargement du fichier, avant que ce code ne tourne jamais) a déjà fait
 * échouer le démarrage si writeBusinessCode et des motifs cohabitaient, ou si
 * des motifs cohabitaient avec writeTests: false — un appelant qui construit
 * MergeRequestCapabilities à la main (hors projects.json, par exemple un
 * test) sans passer par cette validation n'a que cet ordre de priorité pour
 * seul filet.
 */
export function repoCapabilitiesFor(
  mergeRequest: MergeRequestCapabilities,
): RepoCapabilities {
  let writablePaths: RepoCapabilities["writablePaths"];
  if (mergeRequest.writeBusinessCode) {
    writablePaths = "all";
  } else if (mergeRequest.writablePaths.length > 0) {
    writablePaths = mergeRequest.writablePaths;
  } else if (mergeRequest.writeTests) {
    writablePaths = "tests-only";
  } else {
    writablePaths = "none";
  }
  return {
    writablePaths,
    publishMode: mergeRequest.pushToSourceBranch ? "source-branch" : "dedicated-mr",
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
