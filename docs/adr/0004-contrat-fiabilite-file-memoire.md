# ADR 0004 — Contrat de fiabilité : file en mémoire, perte assumée

## Statut

Acceptée. Rendue explicite (statuts `running`/`failed`, non-rejeu de
`running`) par les commits `485b90d` (cycle de vie complet des demandes),
`acb0c13` (arrêt gracieux et perte de file rendue explicite) et `050ce3a`
(compaction du journal).

## Contexte

Une demande traverse plusieurs étapes entre sa détection et son traitement :
détectée → autorisée → réservée (`claimed`) → mise en file → accusée de
réception (`acked`) → prise par le worker (`running`) → terminée
(`done`/`failed`). Le worker lui-même (`TaskQueue`, `src/daemon/queue.ts`)
ne conserve son contenu qu'en mémoire du process ; `RequestStore`
(`src/daemon/store.ts`) journalise chaque transition sur disque
(`STATE_FILE`, JSONL append-only) mais ne rejoue rien tout seul — c'est
`main()` (`src/daemon/index.ts`) qui décide quoi faire des demandes trouvées
dans un état non terminal au redémarrage.

La question de fond : que garantit ce système entre le moment où une
demande est vue et le moment où elle produit un effet visible (commentaire
publié, code poussé) ?

## Décision

Un contrat de fiabilité délibérément **faible mais honnête**, plutôt qu'une
garantie forte non tenue :

- **`RequestStore` est la seule source de vérité persistante.** Il n'est
  jamais réinitialisé au redémarrage (sauf `state/processed.jsonl` absent :
  premier démarrage, voir `bootstrap.ts`), et `canProcess()` en dérive
  strictement la décision « peut-on (re)traiter cette demande » — `claimed`
  et `acked` sont rejouables (rien d'irréversible n'a eu lieu), `running` ne
  l'est **jamais**, `done`/`failed` non plus (issues terminales).
- **`running` ne se rejoue jamais automatiquement.** Le worker peut être en
  train de pousser du code au moment où il est interrompu — le seul choix
  sûr est de ne rien décider à sa place. Au redémarrage, une demande
  `running` interrompue est simplement signalée « à vérifier à la main »
  (`main()`, section `interrupted()`) : c'est un choix conscient de ne
  jamais risquer un double push plutôt que de garantir l'achèvement de
  toute demande.
- **La file en mémoire (`TaskQueue`) est jetable par construction.** Une
  demande poussée dans la file mais jamais démarrée (le daemon s'arrête ou
  crashe avant) est purement perdue — et c'est déjà trop tard pour s'en
  excuser côté GitLab : le to-do correspondant a déjà été marqué `done` au
  moment de l'accusé de réception, avant même que la tâche n'entre dans la
  file. `ackBody()` le dit explicitement dans le commentaire posté au
  demandeur (« file en mémoire, non garantie en cas de redémarrage »), et
  `shutdownSequence()` marque ces demandes `failed` avec une raison
  explicite plutôt que de les laisser à `acked` pour toujours — ce qui
  aurait, à tort, laissé croire à un rejeu automatique possible au
  redémarrage suivant.
- **`appendFileSync` sans `fsync`** : le commentaire de `record()`
  (`store.ts`) le documente lui-même — une ligne `claimed` peut ne jamais
  atteindre le disque en cas de crash brutal (coupure d'alimentation,
  `kill -9`), auquel cas la demande n'est pas seulement perdue mais rejouée
  depuis zéro au redémarrage (`canProcess()` la retraite comme jamais vue).
  La garantie réellement tenue est plus faible que celle qu'un lecteur
  pressé du code déduirait du commentaire de `handle()` dans `index.ts` :
  « jamais de double traitement silencieux tant que le fichier a
  effectivement été écrit », pas une garantie absolue de non-répétition.

## Conséquences

- **Ce système ne garantit jamais qu'une demande soit traitée.** Il
  garantit, au mieux, qu'elle ne sera jamais traitée deux fois de façon
  silencieuse une fois qu'elle a atteint l'état `running` et que ce fait a
  atteint le disque. C'est un compromis assumé pour un POC : perdre une
  demande (l'utilisateur peut rementionner le bot) coûte nettement moins
  cher qu'un double push ou une double publication sur une MR.
- **Aucune haute disponibilité.** Un seul daemon actif à la fois (verrou de
  fichier, `src/daemon/lock.ts`), un seul worker séquentiel — un crash
  arrête tout traitement jusqu'au redémarrage suivant, sans bascule.
- **Le journal (`STATE_FILE`) grossit avec l'usage** et est compacté (une
  ligne par clé, son dernier statut) au-delà d'un seuil de lignes brutes
  plutôt qu'à chaque démarrage — voir `RequestStore.compact()`. Le
  compactage lui-même est atomique (écriture dans un fichier temporaire puis
  renommage) : un crash pendant le compactage ne peut pas corrompre le
  fichier existant, au pire laisser un `.tmp` orphelin à côté.

## Alternatives écartées

- **File persistante** (base SQLite locale, ou simplement journaliser aussi
  le contenu de la file, pas seulement son statut) : éliminerait la perte
  de demandes `acked` non démarrées au redémarrage. Écartée pour un POC :
  ajoute une dépendance ou une complexité de sérialisation pour un gain qui
  ne se justifie que si le taux de redémarrage en cours de traitement
  devient un problème réel observé, pas hypothétique.
- **Rejouer automatiquement les demandes `running` interrompues** : écartée
  délibérément — il n'y a aucun moyen sûr de savoir, depuis le seul journal,
  si le push a eu lieu avant l'interruption. Rejouer à tort risquerait un
  double push sur une branche source ; ne pas rejouer risque seulement un
  oubli, détectable et corrigible par un humain (le message d'avertissement
  au démarrage le signale explicitement).
- **`fsync` à chaque écriture du store** : éliminerait la fenêtre de perte
  documentée sur `record()`, au prix d'un coût réel sur le chemin chaud de
  `handle()` (chaque demande traitée ferait au moins un `fsync` bloquant).
  Non fait : le commentaire du code choisit de documenter l'écart entre la
  garantie énoncée et la garantie réelle plutôt que de payer ce coût pour un
  scénario (crash brutal exactement entre l'écriture et le flush disque)
  jugé marginal pour un POC.
- **Accusé de réception après (pas avant) le passage en file** : n'aurait
  rien changé au problème de fond — que l'accusé de réception soit posté
  avant ou après l'entrée en file, le to-do est de toute façon marqué `done`
  côté GitLab dès que l'accusé part, ce qui est la vraie cause de
  l'irréversibilité si le daemon meurt juste après.
