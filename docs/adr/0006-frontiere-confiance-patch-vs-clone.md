# ADR 0006 — Frontière de confiance : patch extrait plutôt que clone manipulé, écarté pour l'instant

## Statut

Acceptée (décision par défaut : aucune implémentation, place réservée dans
`RepoCapabilities` — voir `src/tasks/guard.ts`).

## Contexte

L'agent tourne dans un conteneur Docker avec un accès en écriture complet à
un clone du dépôt cible (`/repo`) : il peut, en théorie, y écrire n'importe
quoi — pas seulement le fichier de test ou le code source attendu, mais
aussi manipuler `.git/config`, `.git/hooks`, ou l'historique lui-même
(`reset`, `commit`, `amend`). La question posée en revue était : où placer la
frontière de confiance entre « ce que l'agent produit dans son clone » et
« ce que le daemon accepte de faire partir vers GitLab » ?

Une option identifiée en revue : ne jamais faire confiance à l'état du clone
manipulé par l'agent — à la place, extraire un patch (un diff) de ce qu'il a
produit, et l'appliquer dans un clone frais, jamais touché par l'agent, avant
de committer et pousser depuis ce second clone. Cette option isolerait
structurellement toute altération du premier clone (hooks, config git,
historique) du chemin qui mène réellement à un commit poussé.

Le propriétaire du projet n'avait pas d'avis tranché sur cette frontière
(« je sais pas »). En l'absence d'arbitrage explicite, la décision retenue
est celle par défaut : ne pas implémenter cette option pour l'instant.

## Décision

**L'option « extraire un patch et l'appliquer dans un clone frais » est
écartée pour l'instant.**

Le motif : les vecteurs d'altération identifiés dans le clone manipulé par
l'agent sont déjà couverts par les contrôles défensifs en place, qui
n'exigent pas de changer de clone :

- **`fingerprintGitMeta`/`checkHeadIntegrity`** (`agent/workspace.ts`,
  `tasks/implement.ts`) — hooks git neutralisés avant l'exécution
  (`core.hooksPath` pointé vers un répertoire vide), empreinte de
  `.git/config`/`.git/info`/`.git/hooks` prise avant et revérifiée après :
  toute altération de ces trois zones interrompt le flux avant la moindre
  commande git supplémentaire.
- **`checkHeadIntegrity`** revérifie HEAD contre le serveur GitLab
  authentifié (un `fetch` réseau réel, que l'agent ne peut pas falsifier
  depuis l'intérieur du conteneur — il ne détient pas le token) plutôt que
  contre une référence locale que l'agent pourrait avoir maquillée
  (`git update-ref`).
- **`collectChanges`/`isWritablePath`** (`guard.ts`) rejette toute
  modification hors du périmètre accordé, quelle que soit la façon dont
  l'agent s'y serait pris à l'intérieur du conteneur.

Introduire un second clone ajouterait une classe entière de cas tordus, pour
un gain marginal étant donné ce qui est déjà couvert :

- des patchs qui ne s'appliquent pas proprement (conflits de contexte,
  décalage de lignes) sur le clone frais ;
- des fichiers binaires, que `git diff`/`git apply` gèrent mal ou pas du tout
  sans options supplémentaires ;
- des renommages et changements de mode de fichier (permissions), pas
  toujours représentés fidèlement dans un patch texte ;
- la duplication de l'étape d'installation/de test (déjà coûteuse en temps,
  voir `runCommand`) sur un second clone si l'on veut revérifier après
  application du patch.

## Conséquences

- **Le clone manipulé par l'agent reste le seul clone**, du premier octet
  écrit par l'agent jusqu'au commit poussé par le daemon. La frontière de
  confiance ne passe donc pas par un changement de support (clone A → clone
  B), mais par les contrôles listés ci-dessus, appliqués à ce même clone.
- **Place réservée dans le modèle de capacités** (`RepoCapabilities`,
  `guard.ts`, commentaire explicite) : un jeton `AGENT_CAPABILITIES` pour
  cette option n'existe pas aujourd'hui. Une tentative de l'invoquer malgré
  tout échoue bruyamment au démarrage (« capacité inconnue »,
  `parseCapabilitiesMap` dans `config.ts`), comme pour tout autre jeton non
  reconnu — jamais silencieusement ignorée.
- **Cette décision est un défaut, pas un principe intangible.** Elle a été
  rendue en l'absence d'un vecteur d'attaque concret non couvert par les
  contrôles existants, pour un système où la seule capacité d'écriture
  large aujourd'hui accordée (`writablePaths: "all"`) exige déjà, par
  construction, `publishMode: "dedicated-mr"` pour rester acceptable (revue
  humaine avant fusion — voir `docs/adr/0005-capacites-agent-par-depot.md`).
  Si les capacités de l'agent s'élargissent réellement en pratique au point
  que ce filet (revue humaine) ne suffise plus, cette décision doit être
  réévaluée.

## Alternatives écartées

- **Patch extrait + application dans un clone frais** : voir ci-dessus, motif
  principal de cette ADR.
- **Un clone en lecture seule pour l'agent, un second clone en écriture pour
  les commandes réellement destructrices** (installation, tests, push) :
  variante de l'option précédente, avec les mêmes inconvénients (cas tordus
  de synchronisation entre les deux clones) sans bénéfice de sécurité
  supplémentaire par rapport aux contrôles déjà en place sur le clone unique.
- **Ne rien faire de plus, sans même les contrôles actuels** : jamais une
  option sérieusement envisagée — c'est précisément ce que
  `fingerprintGitMeta`/`checkHeadIntegrity`/`collectChanges` existent pour
  éviter (voir ADR 0002 et le rapport du chantier de durcissement dont ce
  dépôt porte la trace).
