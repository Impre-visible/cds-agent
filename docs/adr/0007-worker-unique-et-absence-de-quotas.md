# ADR 0007 — Worker unique assumé, aucun quota ni comptage de coûts

> **Branche `openhands`** : toujours d'actualité, et le coût de la décision
> augmente. Le worker unique ne tient plus une exécution locale mais une
> ATTENTE : il reste bloqué à sonder une conversation OpenHands pendant tout
> son budget (`OPENHANDS_TIMEOUT_MINUTES`), sans rien calculer. Autrement dit
> la file sérialise désormais quelque chose qui n'a plus aucune raison
> technique de l'être — OpenHands sait mener plusieurs conversations en
> parallèle. C'est le premier endroit où regarder si la latence devient
> gênante.

## Statut

Acceptée (`src/daemon/queue.ts`, `src/daemon/authorize.ts` — comportement
présent depuis les premières versions du POC, confirmé sans changement
pendant le chantier de durcissement).

## Contexte

Deux questions de charge, restées ouvertes à l'issue de la revue, portent
sur le même sujet de fond : rien, dans ce système, n'arbitre entre plusieurs
demandes concurrentes autrement que par leur ordre d'arrivée, et rien n'en
limite le volume.

1. **Un seul worker global ?** `TaskQueue` (`src/daemon/queue.ts`) est
   instanciée une seule fois pour tout le daemon
   (`const queue = new TaskQueue(trackedWorker, ...)` dans
   `tasks/implement.ts`) et traite les tâches strictement en série
   (`pump()` : une boucle `for` qui `await` chaque tâche avant de dépiler
   la suivante). Aucune notion de dépôt, de projet ou d'utilisateur
   n'intervient dans l'ordonnancement : une tâche à la fois, tous dépôts
   confondus, dans l'ordre FIFO où `push()` les a reçues.
2. **Quotas et coûts ?** `authorize()` (`src/daemon/authorize.ts`) vérifie
   `ALLOWED_PROJECTS`/`ALLOWED_USERS` — une liste blanche fail-closed — mais
   ne compte rien : ni le nombre de demandes en cours ou récentes d'un même
   utilisateur, ni les tokens consommés par l'agent, ni le temps de calcul
   cumulé. Un utilisateur autorisé peut mentionner le bot autant de fois
   qu'il le souhaite ; chaque mention produit une demande qui rejoint la
   même file.

## Décision

Les deux sont confirmés tels quels, comme des choix assumés plutôt que des
lacunes à corriger dans l'immédiat :

- **Un seul worker, pour tout le daemon.** Pas de parallélisme entre dépôts,
  pas de file par projet ou par utilisateur.
- **Aucun quota, aucun comptage de coût.** Rien ne limite le nombre de
  demandes qu'un utilisateur autorisé peut enfiler, et rien ne mesure ce que
  chaque exécution de l'agent consomme (temps, tokens d'inférence).

## Conséquences

- **Une implémentation de tests qui prend dix minutes** (le budget par
  défaut, `AGENT_TIMEOUT_MINUTES=10`, borné à 4 h par `config.ts`) **bloque
  toutes les revues et toutes les implémentations de tous les dépôts
  surveillés pendant ce temps.** Ce n'est pas un effet de bord marginal :
  c'est la conséquence directe et systématique du worker unique, qui
  s'applique à chaque tâche, pas seulement aux plus longues. Une revue de MR
  urgente sur un dépôt sans rapport avec la tâche en cours attend son tour
  dans la même file, sans priorité possible.
- **`TaskQueue.push()` renvoie une position dans la file** (voir
  `daemon/queue.ts`), affichée dans l'accusé de réception
  (`ackBody()`) : c'est la seule visibilité donnée à l'utilisateur sur cette
  contention — un chiffre, pas une estimation de temps d'attente (le temps
  restant de la tâche en cours n'est ni connu ni exposé au moment de
  l'accusé de réception).
- **Un utilisateur autorisé peut, seul, enfiler cinquante demandes** (ou
  plus) **et monopoliser le worker unique** aussi longtemps que ces demandes
  mettent à s'exécuter — rien dans `authorize()` ni dans `TaskQueue` ne
  distingue ce scénario d'un usage normal réparti entre plusieurs
  utilisateurs légitimes. La seule protection existante contre un usage
  répété d'une même demande est l'idempotence par clé (`push()` ne réempile
  pas une tâche déjà en attente), pas une limite de fréquence ou de volume.
- **Aucune mesure du coût réel d'exploitation** (temps de calcul cumulé,
  tokens consommés côté inférence) n'est disponible pour dimensionner ou
  arbitrer l'usage — `/metrics` (`daemon/health.ts`) expose la profondeur de
  la file et des compteurs de demandes traitées/refusées/abandonnées, jamais
  de coût.

## Alternatives écartées

- **Plusieurs workers en parallèle** (un par dépôt, ou un pool borné) :
  écartée — le propriétaire du projet a tranché explicitement pour un
  worker unique. Un pool introduirait par ailleurs des questions non
  résolues par ce POC : plusieurs conteneurs Docker simultanés (ressources
  partagées, `DOCKER_MEMORY`/`DOCKER_CPUS`/`DOCKER_PIDS_LIMIT` actuellement
  dimensionnés en supposant une seule exécution à la fois — voir
  `config.ts`), et plusieurs exécutions de l'agent partageant le même
  serveur d'inférence local, dont la capacité réelle à absorber des requêtes
  concurrentes n'a jamais été testée (voir ADR 0003, limite sur l'absence de
  modèle réel testé pendant ce chantier).
- **File avec priorité** (une demande de revue passerait devant une
  implémentation de tests en cours d'attente, par exemple) : non retenue —
  ajoute une notion d'ordonnancement qui n'existe pas aujourd'hui (FIFO
  strict), pour un bénéfice qui ne se justifie que si la contention du
  worker unique devient un problème observé en usage réel, pas hypothétique.
- **Quota par utilisateur ou par dépôt** (nombre de demandes en file
  simultanées, fenêtre de fréquence) : écarté — décision explicite du
  propriétaire du projet (« non, aucun »), pas un oubli. À réévaluer si un
  usage réel démontre qu'un utilisateur autorisé peut, de bonne ou de
  mauvaise foi, monopoliser le worker au détriment des autres.
- **Comptage de tokens ou de coût d'inférence** : écarté pour ce POC, qui
  tourne de toute façon sur un modèle local sans facturation à l'usage (voir
  ADR 0003) — le raisonnement changerait si le projet basculait un jour sur
  une API hébergée facturée.
