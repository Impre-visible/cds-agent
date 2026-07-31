export interface ChangeSet {
  paths: string[];
  // Chemins hors périmètre de test — au sens large : un chemin qui n'est
  // pas un chemin de test, ou un statut de porcelain trop ambigu/suspect
  // pour être accepté sans discussion (voir isSuspectStatus plus bas).
  offending: string[];
  // Sous-cas volontairement distingué de `offending` : un fichier de test
  // *existant* que l'agent a supprimé (ou déplacé puis supprimé). Le chemin
  // reste, en apparence, dans le périmètre "tests/", donc un simple filtre
  // isTestPath ne le verrait jamais — c'est justement le contournement visé
  // (§2.3) : retirer un test gênant plutôt que d'en ajouter un qui passe.
  deletedTests: string[];
}

// Noms de répertoire reconnus comme périmètre de test, quel que soit
// l'écosystème : "test"/"tests" (Python, Ruby/Minitest, Maven/Gradle qui
// rangent leurs sources de test sous src/test/java), "__tests__" (Jest),
// "spec" (RSpec, Jasmine/Mocha). Comparaison insensible à la casse : un
// dossier "Test/" ou "Tests/" (convention .NET) est tout aussi explicite —
// on compare un segment de chemin *entier*, jamais une sous-chaîne, donc
// aucun risque de confondre avec "Contest/" ou "Latest/".
const TEST_DIRECTORY_NAMES = new Set(["tests", "test", "__tests__", "spec"]);

// Conventions de nommage de fichier de test par écosystème, en plus (et
// indépendamment) du critère de répertoire ci-dessus. Chaque regex ne
// s'applique qu'au *basename* du chemin, jamais au chemin complet : un
// dossier "test" plus haut dans l'arborescence ne doit pas influencer ce
// test-là, c'est déjà couvert par TEST_DIRECTORY_NAMES.
const TEST_FILENAME_PATTERNS: RegExp[] = [
  // JS/TS : foo.test.ts, foo.spec.tsx, variantes .cjs/.mjs.
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  // Python : pytest/unittest acceptent indifféremment les deux formes.
  /^test_.*\.py$/,
  /_test\.py$/,
  // Go : seule convention existante, imposée par `go test` lui-même.
  /_test\.go$/,
  // Java / Kotlin : JUnit (*Test.java, *Tests.java, *TestCase.java) et
  // Kotest/Spock (*Spec.kt, *Spec.java). La casse compte : "Test" doit être
  // capitalisé juste avant l'extension pour ne pas confondre avec
  // "Latest.java".
  /(Test|Tests|TestCase|Spec)\.(java|kt|kts)$/,
  // Scala : ScalaTest (*Spec.scala, *Suite.scala) et style JUnit (*Test.scala).
  /(Test|Spec|Suite)\.scala$/,
  // Ruby : RSpec (*_spec.rb) et Test::Unit/Minitest (*_test.rb, test_*.rb).
  /_spec\.rb$/,
  /_test\.rb$/,
  /^test_.*\.rb$/,
];

/**
 * Un chemin de test légitime : soit il vit sous un répertoire de test connu
 * (à n'importe quel niveau du chemin, pas seulement à la racine — un
 * monorepo range volontiers ses tests dans packages/api/test/), soit son
 * nom de fichier suit une convention de test d'un écosystème connu (JS/TS,
 * Python, Go, Java/Kotlin, Scala, Ruby).
 *
 * `extraDirectories` permet à un dépôt donné de déclarer ses propres noms de
 * répertoire de test (voir `testDirectories` dans projects.json, résolu par
 * src/projects.ts::resolveProject et propagé par tasks/implement.ts) sans
 * élargir la détection par défaut pour tous les autres dépôts : sans
 * configuration, seule TEST_DIRECTORY_NAMES s'applique.
 *
 * Hors périmètre, volontairement — pour ne pas transformer ce garde-fou en
 * passoire au nom de la couverture multi-écosystème :
 * - un fichier de fixture/config qui ne vit PAS sous un répertoire de test
 *   reconnu (ex. `conftest.py` ou `setup.py` posé à la racine ou dans
 *   `src/`) : ces noms ne suivent aucune convention de *test*, seule leur
 *   présence DANS un répertoire de test les couvre — exactement comme
 *   n'importe quel autre fichier de ce répertoire, comportement déjà
 *   existant et inchangé (un `tests/setup.py` était déjà accepté avant ce
 *   correctif, un `src/setup.py` ne l'est toujours pas) ;
 * - un nom de répertoire ou de fichier qui imite visuellement une
 *   convention connue (homoglyphes Unicode, ex. un "ｔest/" en largeur
 *   pleine) : non détecté, la protection anti-homoglyphe est hors de
 *   proportion avec la menace ici ;
 * - les tests unitaires Rust (`#[cfg(test)] mod tests { ... }` inline dans
 *   le fichier source lui-même) : il n'y a structurellement aucun chemin
 *   distinct à reconnaître, un garde-fou basé sur les chemins ne peut rien
 *   pour ce cas ;
 * - la convention .NET de projet-suffixe (`MyProject.Tests/Foo.cs`, où
 *   "Tests" n'est qu'une partie d'un segment plus large, pas le segment
 *   entier) : l'accepter demanderait une comparaison par sous-chaîne sur le
 *   nom de segment, ce qui rouvrirait exactement le risque de faux positif
 *   qu'on évite par ailleurs ("Latest", "Contest"...) ; un dossier "Tests/"
 *   ou "Test/" à lui seul reste lui reconnu (voir plus haut).
 */
export function isTestPath(
  path: string,
  extraDirectories: string[] = [],
): boolean {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return false;

  // Un composant "." ou ".." dans un chemin issu de `git status --porcelain`
  // ne devrait jamais se produire (git ne les émet pas pour un chemin suivi
  // ou untracked normal). Le tolérer reviendrait à laisser passer un chemin
  // comme "vendor/test/../../server.js" : un segment "test" est bien
  // présent, mais une fois résolu le chemin ne pointe plus du tout vers ce
  // répertoire — c'est exactement le genre de détournement qu'un agent
  // hostile tenterait pour faire passer une modification hors périmètre.
  // Par prudence on rejette tout chemin de cette forme plutôt que de le
  // résoudre : aucun chemin légitime produit par git n'en a besoin.
  if (segments.some((segment) => segment === "." || segment === ".."))
    return false;

  const knownDirectories = new Set([
    ...TEST_DIRECTORY_NAMES,
    ...extraDirectories.map((directory) => directory.toLowerCase()),
  ]);

  // Répertoire de test à n'importe quel niveau du chemin : comparaison par
  // segment entier (jamais startsWith/includes sur la chaîne complète), pour
  // ne pas confondre un dossier "test" avec "contest" ou "latest".
  const directories = segments.slice(0, -1);
  if (
    directories.some((segment) => knownDirectories.has(segment.toLowerCase()))
  )
    return true;

  const basename = segments.at(-1) ?? "";
  return TEST_FILENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

// ---------------------------------------------------------------------------
// Modèle de capacités de l'agent (chantier "capacités")
// ---------------------------------------------------------------------------
//
// Avant ce chantier, "quels chemins l'agent peut modifier" était une question
// dont la réponse était éparpillée : isTestPath ci-dessus (en dur), plus
// checkHeadIntegrity et le refus de branche protégée dans implement.ts, plus
// deux intentions figées dans router.ts. RepoCapabilities rassemble ça en UN
// point de configuration par dépôt (voir src/projects.ts::repoCapabilitiesFor,
// qui traduit les capacités "mergeRequest" de projects.json), et
// isWritablePath ci-dessous est
// désormais LE point unique qui répond à « l'agent avait-il le droit de
// modifier ce chemin ? » — implement.ts (collectChanges) et router.ts
// (rapport) s'y réfèrent tous les deux plutôt que de réévaluer la question
// chacun à sa façon.
//
// Ce que ce modèle NE couvre PAS, et laisse inconditionnel à dessein (voir le
// rapport du chantier) : fingerprintGitMeta/checkHeadIntegrity (le daemon
// reste seul committeur, quelle que soit la capacité accordée), le refus des
// chemins contenant un composant "." ou ".." (hasUnsafeSegments ci-dessous,
// appliqué avant toute capacité), et le refus de pousser sur une branche
// protégée (implement.ts, pour le mode "source-branch" — le mode
// "dedicated-mr" pousse par construction sur une branche neuve créée par le
// bot, jamais sur une branche existante).

export interface RepoCapabilities {
  /**
   * "tests-only" (défaut, comportement historique) : seuls les chemins
   * reconnus par isTestPath (plus testDirectories, voir projects.json) sont
   * modifiables — le code source reste intouchable, sans exception.
   * "all" : tout chemin du dépôt est modifiable, y compris le code source.
   * "none" : aucun chemin n'est modifiable, pas même un chemin de test —
   * chantier "projects.json" (voir src/projects.ts::repoCapabilitiesFor) :
   * un dépôt dont ni writeTests ni writeBusinessCode n'est accordé se
   * traduit par cette valeur. En pratique, tasks/router.ts refuse l'intention
   * "implement" avant même d'atteindre isWritablePath dans ce cas (message
   * utile au demandeur) — cette valeur est le filet de sécurité qui rendrait
   * de toute façon tout chemin refusé si ce garde-fou amont était un jour
   * contourné par erreur.
   * string[] : motifs glob supplémentaires (voir globToRegExp plus bas),
   * modifiables EN PLUS des chemins de test — un élargissement ciblé, sans
   * aller jusqu'à "all". N'a plus de source de configuration depuis le
   * chantier "projects.json" (le schéma validé par le propriétaire n'expose
   * que des booléens, voir le rapport de la tâche) : conservé ici pour ne
   * pas casser un appelant direct de isWritablePath/collectChanges qui
   * construirait encore ce genre de capacité à la main.
   */
  writablePaths: "tests-only" | "all" | "none" | string[];
  /**
   * "source-branch" (défaut, comportement historique) : push direct sur la
   * branche source de la MR une fois tous les contrôles passés.
   * "dedicated-mr" : le bot pousse sur une branche cds-agent/... et ouvre une
   * merge request dédiée (voir tasks/implement.ts::openDedicatedMergeRequest)
   * — à faire relire par un humain avant fusion. C'est cette option qui rend
   * acceptable d'élargir writablePaths : le filet de sécurité se déplace de
   * "seuls des tests peuvent être touchés" à "une revue humaine est requise
   * avant que quoi que ce soit n'atteigne la branche source".
   */
  publishMode: "source-branch" | "dedicated-mr";
  // Emplacement réservé pour une future capacité "appliquer le résultat dans
  // un clone frais isolé plutôt que dans le clone manipulé par l'agent" (pas
  // implémentée à ce stade — voir le rapport du chantier "capacités"). Un
  // jeton non reconnu par parseCapabilitiesMap (config.ts) échoue déjà
  // bruyamment au démarrage : rien à faire ici pour qu'une tentative
  // prématurée d'utiliser cette capacité soit rejetée plutôt qu'ignorée.
}

/** Comportement historique, reproduit exactement sans configuration. */
export const DEFAULT_CAPABILITIES: Readonly<RepoCapabilities> = Object.freeze({
  writablePaths: "tests-only",
  publishMode: "source-branch",
});

export function isDefaultCapabilities(capabilities: RepoCapabilities): boolean {
  return (
    capabilities.writablePaths === "tests-only" &&
    capabilities.publishMode === "source-branch"
  );
}

/**
 * Résumé humain d'une capacité non par défaut, pour le rapport posté sur
 * GitLab (router.ts) : quelqu'un qui relit une MR doit pouvoir savoir que
 * l'agent avait le droit d'élargir son périmètre, pas seulement le déduire
 * en constatant qu'un fichier source a changé.
 */
export function describeCapabilities(capabilities: RepoCapabilities): string {
  const parts: string[] = [];
  if (capabilities.writablePaths === "all") {
    parts.push("tout le dépôt modifiable (code source compris)");
  } else if (capabilities.writablePaths === "none") {
    parts.push("aucune écriture autorisée");
  } else if (Array.isArray(capabilities.writablePaths)) {
    parts.push(
      `motifs supplémentaires modifiables : ${capabilities.writablePaths.join(", ")}`,
    );
  }
  if (capabilities.publishMode === "dedicated-mr") {
    parts.push("résultat proposé via une merge request dédiée, pas de push direct");
  }
  return parts.join(" ; ");
}

/**
 * Un composant "." ou ".." dans le chemin (voir le commentaire équivalent
 * dans isTestPath ci-dessus, qui applique le même refus). Extrait en
 * fonction indépendante — plutôt que réutilisé depuis l'intérieur
 * d'isTestPath — pour qu'isWritablePath puisse l'appliquer AVANT même de
 * regarder la capacité accordée : ce refus est inconditionnel, y compris
 * pour writablePaths="all" (voir le rapport du chantier "capacités" —
 * "une capacité élargit ce que l'agent a le droit de produire, jamais ce que
 * le daemon accepte de ne pas vérifier").
 */
function hasUnsafeSegments(path: string): boolean {
  return path
    .split("/")
    .filter(Boolean)
    .some((segment) => segment === "." || segment === "..");
}

/**
 * Traduit un motif glob simple ("src/**", "docs/*.md") en RegExp ancrée sur
 * le chemin entier. Sous-ensemble volontairement restreint aux deux jokers
 * utiles pour une liste de chemins/répertoires de dépôt : "**" (n'importe
 * quelle suite de caractères, traverse les "/") et "*" (n'importe quoi sauf
 * "/", reste à l'intérieur d'un segment). Pas de classes de caractères
 * ("[abc]") ni de "?" : un vrai moteur glob n'apporterait rien ici et
 * ajouterait des pièges (échappement, ReDoS) pour un usage qui reste une
 * simple liste de motifs de configuration, pas un langage à exposer tel quel
 * à une donnée non fiable.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    if (char === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i++;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}$`);
}

/**
 * LE point unique qui répond à « l'agent avait-il le droit de modifier ce
 * chemin ? » (voir l'en-tête de section ci-dessus). collectChanges
 * (guard.ts) et le prompt de l'agent (implement.ts::buildPrompt) s'y
 * réfèrent tous les deux plutôt que de réévaluer isTestPath chacun à leur
 * façon.
 *
 * Sans capacités renseignées (DEFAULT_CAPABILITIES), équivalent strict à
 * `isTestPath(path, extraTestDirectories)` — c'est ce qui garantit le
 * comportement par défaut inchangé (voir guard.test.ts).
 */
export function isWritablePath(
  path: string,
  capabilities: RepoCapabilities = DEFAULT_CAPABILITIES,
  extraTestDirectories: string[] = [],
): boolean {
  // Inconditionnel : évalué avant toute capacité, y compris "all".
  if (hasUnsafeSegments(path)) return false;

  if (capabilities.writablePaths === "all") return true;
  // "none" : même un chemin de test reste refusé, contrairement à
  // "tests-only" ci-dessous qui s'appuie justement sur le fallthrough
  // isTestPath — voir le commentaire de RepoCapabilities.writablePaths.
  if (capabilities.writablePaths === "none") return false;
  if (isTestPath(path, extraTestDirectories)) return true;
  if (Array.isArray(capabilities.writablePaths)) {
    return capabilities.writablePaths.some((pattern) =>
      globToRegExp(pattern).test(path),
    );
  }
  return false;
}

/**
 * Un statut XY que ce flux ne devrait normalement jamais produire : un
 * conflit de fusion non résolu, un changement de type (fichier <-> lien
 * symbolique, qui pourrait déguiser un chemin de test en pointeur vers
 * autre chose), ou une entrée "ignorée" (ne devrait pas apparaître, puisque
 * `-uall` sans `--ignored` ne les demande pas).
 *
 * Le principe directeur, volontaire : un statut qu'on n'a pas explicitement
 * décidé d'accepter est traité comme suspect, jamais comme anodin — c'est
 * le garde-fou qui doit justifier une exception, pas l'inverse.
 */
function isSuspectStatus(code: string): boolean {
  if (code === "??") return false; // non suivi : cas normal, traité plus bas comme un ajout
  if (code === "!!") return true; // ignoré : ne devrait jamais apparaître ici
  // "U" en X ou en Y marque un chemin non fusionné ; "AA"/"DD" (ajouté ou
  // supprimé des deux côtés) sont eux aussi des conflits, sans lettre "U".
  if (code.includes("U") || code === "AA" || code === "DD") return true;
  // Changement de type (T) : un fichier de test remplacé par un lien
  // symbolique (ou l'inverse) reste un chemin "tests/…" pour isTestPath,
  // mais son contenu réel est indéterminé sans inspection supplémentaire.
  if (code.includes("T")) return true;
  return false;
}

/**
 * "D" en colonne X (index) ou Y (arbre de travail) signale qu'à l'état
 * courant, ce chemin n'a plus de contenu — que ce soit une suppression
 * simple ("D "/" D"/"MD"/"AD"...) ou un renommage suivi d'une suppression
 * du fichier renommé ("RD"/"CD", constaté empiriquement : git émet bien un
 * second caractère "D" dans ce cas, la paire de chemins -z est produite
 * comme pour tout renommage/copie).
 */
function isDeleteStatus(code: string): boolean {
  return code[0] === "D" || code[1] === "D";
}

/**
 * Lit l'état réel du dépôt, sans faire confiance à ce que l'agent déclare.
 *
 * `capabilities` (défaut DEFAULT_CAPABILITIES, soit "tests-only") élargit ce
 * qui compte comme "dans le périmètre" via isWritablePath ci-dessus, à la
 * place du strict isTestPath d'avant ce chantier — c'est ce qui garde le
 * comportement par défaut inchangé sans capacités renseignées. Avec
 * writablePaths="all", la protection deletedTests (pensée pour un agent
 * limité aux tests, qui pourrait être tenté de supprimer un test gênant
 * plutôt que d'en écrire un qui passe) n'a plus lieu d'être distinguée du
 * reste : le dépôt entier étant modifiable, supprimer un test est une action
 * légitime comme une autre, pas un contournement à signaler à part — le
 * filet de sécurité se déplace alors vers publishMode="dedicated-mr" (revue
 * humaine), voir le rapport du chantier "capacités".
 */
export function collectChanges(
  porcelain: string,
  extraDirectories: string[] = [],
  capabilities: RepoCapabilities = DEFAULT_CAPABILITIES,
): ChangeSet {
  // Format `--porcelain=v1 -z` (implement.ts est responsable de passer -z à
  // git) : chaque entrée est terminée par un octet nul et n'est JAMAIS
  // quotée — accents, espaces, guillemets, retours à la ligne dans un nom
  // de fichier traversent tels quels. Constaté empiriquement contre un vrai
  // dépôt (git 2.50) plutôt que déduit de mémoire : un renommage ou une
  // copie ajoute une DEUXIÈME entrée -z, le chemin d'origine, SANS son
  // propre préfixe XY et sans le séparateur " -> " du format v1 sans -z —
  // "R  nouveau\0ancien\0", jamais "R  ancien -> nouveau". Le renommage
  // s'écrit toujours en colonne X, jamais en Y, y compris pour les statuts
  // combinés ("RM", "RD").
  const tokens = porcelain.split("\0").filter((token) => token.length > 0);

  const paths: string[] = [];
  const offending = new Set<string>();
  const deletedTests = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    // `filter` ci-dessus garantit qu'aucun token n'est vide, mais
    // TypeScript (noUncheckedIndexedAccess) ne le sait pas depuis un accès
    // indexé : le fallback ne joue aucun rôle, `entry` ne peut pas être
    // vide ici.
    const entry = tokens[i] ?? "";
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;

    const isRenameOrCopy = code[0] === "R" || code[0] === "C";
    // Le chemin d'origine est une entrée -z séparée, jamais un suffixe de
    // la ligne courante : on consomme le token suivant.
    const originPath = isRenameOrCopy ? tokens[++i] : undefined;

    paths.push(path);
    if (originPath) paths.push(originPath);

    if (isSuspectStatus(code)) {
      offending.add(path);
      if (originPath) offending.add(originPath);
      continue;
    }

    // Le chemin courant (nouveau nom en cas de renommage/copie) : une
    // suppression qui le touche et qui reste, malgré tout, sous un chemin
    // de test est le scénario de contournement visé par §2.3 — distingué
    // de "offending" pour un message d'erreur qui ne prête pas à confusion
    // avec un simple fichier hors périmètre. Non pertinent quand
    // writablePaths="all" (voir le commentaire de la fonction) : la
    // suppression y est alors une modification permise comme une autre.
    const fullAccess = capabilities.writablePaths === "all";
    if (!fullAccess && isDeleteStatus(code) && isTestPath(path, extraDirectories)) {
      deletedTests.add(path);
    } else if (!isWritablePath(path, capabilities, extraDirectories)) {
      offending.add(path);
    }

    // Le chemin d'origine d'un renommage/copie n'est pas une suppression :
    // son contenu survit sous le nouveau nom. Seul compte, comme pour tout
    // autre chemin, son appartenance ou non au périmètre de test.
    if (originPath && !isWritablePath(originPath, capabilities, extraDirectories)) {
      offending.add(originPath);
    }
  }

  return {
    paths: [...new Set(paths)],
    offending: [...offending],
    deletedTests: [...deletedTests],
  };
}
