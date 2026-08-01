# Déploiement

Ce document répond à une question simple : comment ce POC tourne-t-il
ailleurs que dans un terminal ouvert avec `npm run dev` ? Aujourd'hui, la
réponse est : **avec `docker compose up -d --build`** — voir
[`docker-compose.yml`](../docker-compose.yml) et
[`docker/daemon.Dockerfile`](../docker/daemon.Dockerfile), livrés depuis. Il
n'existe en revanche toujours ni unité systemd fournie, ni pipeline de
déploiement. Ce document documente les contraintes que ce mode d'exécution
n'élimine pas, et ce qu'il coûte.

## Pourquoi ce n'est pas un simple oubli

Le daemon a deux dépendances qui compliquent toute forme d'exécution
« gérée » (systemd system-wide, conteneur, orchestrateur) :

1. **Un accès au démon Docker.** `src/agent/sandbox.ts` lance `docker run`
   pour chaque tâche — le process du daemon doit donc pouvoir invoquer le
   client `docker` et joindre le socket du démon (`/var/run/docker.sock` en
   usage courant). Ce n'est pas négociable : c'est le mécanisme central de
   confinement de l'agent (voir `docs/adr/0002-garde-fou-chemin-tests.md` et
   le README, section « Garde-fous de sécurité »).
2. **Une inférence joignable.** Le proxy d'inférence (`src/tools/proxy.ts`)
   résout `INFERENCE_UPSTREAM_URL` (LM Studio par défaut, `127.0.0.1:1234`)
   **depuis le point de vue du process du daemon**, pas depuis un conteneur.
   Un LM Studio qui tourne sur la machine de l'opérateur suppose donc que le
   daemon tourne sur cette même machine. À défaut, `INFERENCE_UPSTREAM_URL`
   peut viser une inférence distante — y compris en `https://` et avec une
   clé d'API (`INFERENCE_API_KEY`, posée par le proxy et jamais transmise au
   conteneur agent) : voir le README, section « Modèle (local ou distant) ».

### Le cas particulier d'un daemon conteneurisé

C'est le mode livré (`docker compose up -d --build`), mais il n'élimine
aucune des deux contraintes ci-dessus — il les déplace, et le compromis
mérite d'être lu avant d'être accepté.

**Le socket Docker.** Pour lancer `docker run` depuis l'intérieur d'un
conteneur, il faut soit monter le socket de l'hôte
(`-v /var/run/docker.sock:/var/run/docker.sock`), soit du Docker-in-Docker
complet. C'est la première option qui est retenue : les conteneurs agent sont
des **frères**, pas des enfants. Conséquence à assumer — qui peut écrire sur
ce socket peut démarrer un conteneur privilégié qui monte `/`, soit un accès
équivalent à root sur l'hôte. Conteneuriser le daemon ne l'isole donc pas de
la machine ; ce n'est pas ce que ça achète.

Ce que ça achète réellement : un service qui redémarre seul après un crash et
au redémarrage de la machine, une construction reproductible, et une
configuration qui ne dépend plus de ce qui traîne dans le shell de celui qui
lance `npm run dev`.

Ce que ça ne dégrade **pas** : le code écrit par le modèle ne tourne jamais
dans le conteneur du daemon. Il tourne dans les conteneurs agent, lancés avec
`--cap-drop ALL`, `--read-only`, `--pids-limit` et `--network none` par
défaut (voir `src/agent/sandbox.ts`). Ce durcissement est intact.

Ce que ça dégrade : les conteneurs agent tournent sous l'uid du process
daemon (`hostUser()`), soit root-dans-le-conteneur au lieu de l'uid de
l'utilisateur. Sans capacités et en racine lecture seule, la portée reste
faible — mais c'est une régression réelle par rapport au lancement depuis un
terminal.

#### Les deux pièges qui font échouer une version naïve

Ils échouent tous les deux **en silence**, d'où leur traitement explicite
dans `docker-compose.yml` :

1. **L'identité des chemins.** Le daemon crée ses espaces de travail sous
   `TMPDIR` (`mkdtemp`, voir `agent/workspace.ts`) puis les monte dans les
   conteneurs agent (`-v <chemin>:/repo`). Ce chemin est interprété par le
   moteur Docker de l'**hôte**, pas par le conteneur du daemon : un `/tmp`
   interne donnerait un montage vide, sans erreur. `CDS_WORK_DIR` est donc
   monté **au même chemin absolu des deux côtés**, et `TMPDIR` pointe dessus.
2. **La joignabilité du proxy d'inférence.** Le proxy filtrant tourne *dans*
   le process daemon (`tools/proxy.ts`) ; l'agent le joignait via
   `host.docker.internal`, qui désigne l'hôte — donc plus le daemon une fois
   celui-ci conteneurisé. Les deux sont mis sur un réseau Docker commun et
   l'agent joint le daemon par son **nom** (`INFERENCE_PROXY_HOST` +
   `AGENT_DOCKER_NETWORK`). Bénéfice de bord : aucun port à publier, alors
   qu'exposer ce proxy reviendrait à offrir la vraie clé d'API à quiconque
   sur le réseau de la machine.

Le proxy filtrant conserve donc exactement son rôle : c'est toujours lui qui
détient `INFERENCE_API_KEY`, et l'agent ne voit qu'une adresse locale au
réseau Docker. `CONTAINER_INFERENCE_URL`, qui court-circuite le proxy et fait
descendre la clé jusqu'au conteneur agent, reste déconseillé — plus encore
dans ce mode.

#### Redémarrage automatique

`restart: unless-stopped` couvre le crash et le redémarrage de la machine.
Sur macOS, il faut en plus que Docker Desktop soit réglé pour se lancer à
l'ouverture de session (*Settings → General → Start Docker Desktop when you
sign in*) : sans lui, aucun conteneur ne redémarre.

## Ce qui est raisonnable

Faire tourner le daemon comme un **process de longue durée sur l'hôte**, sous
un compte de service dédié, via une unité **systemd (user ou system)**. Ça
correspond à ce que le code suppose déjà (accès direct au socket Docker,
accès direct à `127.0.0.1` pour l'inférence), sans aucun changement de code.
C'est aussi ce qui a été réellement utilisé pendant le développement de ce
POC (le README documente `npm run dev` dans un terminal).

Exemple d'unité **non testée** (aucun environnement systemd disponible pour
la vérifier dans le cadre de ce chantier de documentation) — à adapter et à
valider avant tout usage réel :

```ini
# /etc/systemd/system/cds-agent.service  (ou ~/.config/systemd/user/ en mode --user)
[Unit]
Description=cds-agent (POC) — daemon de revue/tests GitLab piloté par LLM local
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/cds-agent
EnvironmentFile=/opt/cds-agent/.env
ExecStart=/usr/bin/npx tsx src/daemon/index.ts
Restart=on-failure
RestartSec=10
# Le daemon pose déjà son propre verrou de fichier (src/daemon/lock.ts) :
# un redémarrage systemd sur crash ne crée pas de double instance, la
# nouvelle reprend le verrou périmé de l'ancienne.

# Durcissement systemd de base — sans lien avec la sandbox Docker de
# l'agent, qui reste le mécanisme de confinement de CE qu'exécute le LLM.
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/cds-agent/state
# Le daemon a besoin du socket Docker : pas de PrivateDevices/ProtectKernelTunables
# agressif qui le couperait de /var/run/docker.sock.

[Install]
WantedBy=multi-user.target
```

Points d'attention pour qui voudrait vraiment déployer ça :

- **`EnvironmentFile`** attend un fichier au format `NOM=valeur` par ligne,
  compatible avec `.env` tel qu'utilisé ici — mais le petit parseur de
  `src/config.ts` (`loadDotEnv()`) et celui de systemd ne gèrent pas
  forcément les guillemets ou les valeurs multi-lignes de façon identique ;
  à vérifier valeur par valeur, pas supposé.
- **Le compte qui lance le service doit pouvoir invoquer `docker`** — en
  pratique, membre du groupe `docker` (ou équivalent), ce qui lui donne de
  facto un accès équivalent root sur la machine (limite connue de Docker,
  pas spécifique à ce projet).
- **`Restart=on-failure` ne rejoue rien côté GitLab** : au redémarrage, le
  daemon retrouve son état via `STATE_FILE` (voir
  `docs/adr/0004-contrat-fiabilite-file-memoire.md`) — une tâche `running`
  au moment du crash n'est jamais rejouée automatiquement, elle attend une
  vérification manuelle.
- **Un seul daemon par verrou de fichier** (`src/daemon/lock.ts`) : ce n'est
  pas un mécanisme prévu pour plusieurs réplicas actifs. Pas de haute
  disponibilité au sens habituel — un daemon qui tombe est un daemon qui ne
  traite plus rien jusqu'au redémarrage suivant.

## Ce qui n'est pas raisonnable (aujourd'hui)

- **Un `docker-compose.yml`** orchestrant le daemon *et* Docker (Docker-in-
  Docker) *et* un serveur d'inférence conteneurisé : chacune de ces briques
  ajoute une couche d'indirection réseau (voir plus haut) sans bénéfice net
  pour un POC mono-instance, et aucune des trois n'a pu être vérifiée
  fonctionnellement dans le cadre de ce chantier (modèle coupé, Docker non
  lancé — voir les contraintes de la tâche).
- **Un déploiement Kubernetes** (ou équivalent) : suppose une haute
  disponibilité et une répartition de charge que l'architecture actuelle ne
  fournit pas (verrou mono-instance, file en mémoire non partagée, un seul
  worker séquentiel — voir `docs/adr/0004-contrat-fiabilite-file-memoire.md`).
  Rien n'empêche d'y arriver un jour, mais ce serait un chantier
  d'architecture à part entière, pas un ajustement de packaging.
