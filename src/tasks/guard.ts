export interface ChangeSet {
  paths: string[];
  offending: string[];
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
 * répertoire de test (voir config.testDirectoryOverrides, résolu par le
 * projet dans tasks/implement.ts) sans élargir la détection par défaut pour
 * tous les autres dépôts : sans configuration, seule TEST_DIRECTORY_NAMES
 * s'applique.
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

/** Lit l'état réel du dépôt, sans faire confiance à ce que l'agent déclare. */
export function collectChanges(
  porcelain: string,
  extraDirectories: string[] = [],
): ChangeSet {
  const paths: string[] = [];

  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const payload = line.slice(3);
    // Un renommage s'écrit "ancien -> nouveau" : les deux chemins comptent.
    for (const part of payload.split(" -> ")) {
      const clean = part.trim().replace(/^"|"$/g, "");
      if (clean) paths.push(clean);
    }
  }

  const unique = [...new Set(paths)];
  return {
    paths: unique,
    offending: unique.filter((path) => !isTestPath(path, extraDirectories)),
  };
}
