# ADR 0005 — Modèle de capacités de l'agent, déclaratif et par dépôt

## Statut

Acceptée (`src/tasks/guard.ts`, `src/config.ts`, `src/tasks/implement.ts` —
commit `883d74c`).

## Contexte

Avant ce chantier, la question « qu'est-ce que l'agent a le droit de
produire ? » n'avait pas de réponse unique : `isTestPath` dans `guard.ts`
décidait, en dur, que seuls des chemins de test étaient modifiables ;
`checkHeadIntegrity` et le refus de push sur une branche protégée, dans
`implement.ts`, ajoutaient chacun leur propre contrainte ; et le choix
« push direct sur la branche source » était lui aussi figé, sans variante.
Élargir ce que l'agent pouvait faire pour un dépôt donné — par exemple
laisser un dépôt particulier accepter des changements de code source, pas
seulement des tests — n'avait pas de point d'entrée : il aurait fallu
modifier `guard.ts` lui-même, pour tous les dépôts à la fois.

Le propriétaire du projet a tranché que le daemon devait pouvoir pousser du
code (pas seulement des tests), à condition de disposer d'un moyen simple de
contrôler cette capacité dépôt par dépôt, plutôt que d'un interrupteur
global.

## Décision

Un modèle `RepoCapabilities` déclaratif, un par dépôt, résolu une seule fois
par exécution (`resolveCapabilities()` dans `tasks/implement.ts`) et propagé
explicitement à tout ce qui en a besoin (prompt de l'agent, `collectChanges`,
choix du mode de publication) plutôt que relu depuis `config` à chaque usage.

Deux axes, indépendants :

- **`writablePaths`** — `"tests-only"` (défaut, comportement historique :
  seuls les chemins reconnus par `isTestPath` sont modifiables), `"all"`
  (tout le dépôt, code source compris), ou une liste de motifs glob
  supplémentaires (`write:motif1|motif2`) qui s'ajoutent aux chemins de test
  sans aller jusqu'à `"all"`.
- **`publishMode`** — `"source-branch"` (défaut, comportement historique :
  push direct sur la branche source une fois tous les contrôles passés) ou
  `"dedicated-mr"` (le bot pousse sur une branche `cds-agent/...` dédiée et
  ouvre une merge request qui cible la branche source, à faire relire par un
  humain avant fusion — voir `openDedicatedMergeRequest()`).

Configuré via `AGENT_CAPABILITIES` (`src/config.ts::parseCapabilitiesMap`),
format `"groupe/depot=capacite1;capacite2,autre/depot=capacite3"`. Une entrée
absente retombe sur `DEFAULT_CAPABILITIES` (`tests-only`, `source-branch`) —
comportement strictement inchangé sans configuration. Un jeton non reconnu ou
mal orthographié (`write-al`, `dedicate-mr`...) fait échouer le démarrage
avec un message explicite : contrairement aux autres maps par dépôt
(`DOCKER_IMAGES`, `TEST_COMMANDS`...), silencieusement permissives sur une
entrée malformée, `AGENT_CAPABILITIES` décide ce que l'agent a le droit de
produire — une faute de frappe ne doit jamais se traduire par un périmètre
silencieusement différent de celui qu'on croit avoir configuré.

`guard.ts::isWritablePath` est désormais LE point unique qui répond à
« l'agent avait-il le droit de modifier ce chemin ? », utilisé à la fois par
`collectChanges` (le garde-fou, après coup) et par `buildPrompt`
(l'instruction donnée à l'agent, avant coup, purement informative — voir le
commentaire de `writeScopeInstructions` dans `implement.ts`) — plus de
logique dupliquée entre `guard.ts`, `implement.ts` et `router.ts`.

## Ce qui reste inconditionnel

Une capacité élargit ce que l'agent a le droit de *produire*, jamais ce que
le daemon accepte de ne pas *vérifier* :

- **`fingerprintGitMeta` / `checkHeadIntegrity`** (`agent/workspace.ts`,
  `tasks/implement.ts`) : le daemon reste seul committeur légitime, quelle
  que soit l'étendue de `writablePaths`. Ces deux contrôles s'appliquent
  avant même de regarder `collectChanges`.
- **Le rejet des chemins contenant un composant `.` ou `..`**
  (`hasUnsafeSegments` dans `guard.ts`) : évalué avant toute capacité, y
  compris `writablePaths: "all"` — un chemin qui, une fois résolu, ne pointe
  plus vers l'endroit qu'il prétend n'est jamais acceptable, quel que soit le
  périmètre par ailleurs accordé.
- **Le refus de pousser sur une branche protégée**, mais seulement en mode
  `publishMode: "source-branch"` : en mode `dedicated-mr`, ce contrôle ne
  s'applique pas, car la branche créée par le bot est neuve et ne peut pas,
  par construction, être déjà protégée — le risque qu'il couvre (écraser une
  branche protégée existante) ne se pose structurellement pas dans ce mode
  (voir le commentaire d'`openDedicatedMergeRequest`).
- **La protection `deletedTests`** de `collectChanges` (ADR 0002) ne
  s'applique plus quand `writablePaths: "all"` : le dépôt entier étant
  modifiable, supprimer un fichier de test devient une action légitime comme
  une autre, pas un contournement à signaler à part. Le filet de sécurité se
  déplace alors vers `publishMode: "dedicated-mr"` (revue humaine) — c'est
  cette option qui rend acceptable d'élargir `writablePaths` en premier lieu.

Le rapport posté sur GitLab mentionne explicitement toute capacité
non par défaut (`🔓 Capacités élargies pour ce dépôt : ...`, voir
`describeCapabilities`/`isDefaultCapabilities` dans `guard.ts`, appelés par
`router.ts`) : quelqu'un qui relit la MR sait que l'agent avait le droit de
toucher au code source, pas seulement le déduire en constatant qu'un fichier
source a changé.

## Conséquences

- **La configuration par défaut (`AGENT_CAPABILITIES` absente) reproduit
  exactement le comportement d'avant ce chantier** — condition vérifiée par
  les tests existants (`guard.test.ts`, `implement.test.ts`) : aucune
  régression pour un dépôt qui ne configure rien.
- **Élargir `writablePaths` à `"all"` sans passer par `publishMode:
  "dedicated-mr"` reste possible** (les deux réglages sont indépendants) :
  rien n'empêche de configurer un push direct de code source arbitraire sur
  la branche source. C'est un choix de configuration assumé par l'opérateur,
  pas un défaut du système — mais aucun garde-fou du code n'empêche cette
  combinaison à risque.
- **Le contenu de ce que l'agent écrit hors du périmètre `tests-only` n'est
  toujours vérifié que par la suite de tests relancée par le daemon
  lui-même** (`runCommand(repo, testCommand, ...)` après l'exécution de
  l'agent) — aucune revue de code automatique du contenu produit, qu'il
  s'agisse de tests ou, désormais, de code source en mode `write-all`.

## Alternatives écartées

- **Un interrupteur global** (`ALLOW_SOURCE_WRITE=1` pour tout le daemon,
  par exemple) plutôt qu'un modèle par dépôt : écarté explicitement par la
  demande du propriétaire du projet (« faudrait un moyen facile de
  contrôler les capacités de l'agent ») — un interrupteur global appliquerait
  la même capacité à tous les dépôts surveillés, alors que le besoin réel est
  d'élargir le périmètre pour un dépôt précis sans toucher au comportement
  des autres.
- **Une capacité "appliquer le résultat dans un clone frais isolé"**
  (défense en profondeur supplémentaire, indépendante de `writablePaths`) :
  anticipée dans la forme du modèle (commentaire réservé dans
  `RepoCapabilities`, `guard.ts`) mais non implémentée — voir
  `docs/adr/0006-frontiere-confiance-patch-vs-clone.md`, qui traite cette
  question séparément.
- **Analyse statique ou revue automatique du contenu produit** en mode
  `write-all` : hors périmètre de ce chantier, non implémentée — le garde-fou
  reste, comme pour `tests-only` (ADR 0002), un contrôle de *chemin*, jamais
  de contenu.
