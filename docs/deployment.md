# Déploiement

Ce document répond à une question simple : comment ce POC tourne-t-il
ailleurs que dans un terminal ouvert avec `npm run dev` ? Aujourd'hui, la
réponse honnête est : **il ne tourne nulle part ailleurs** — il n'existe ni
Dockerfile pour le daemon lui-même, ni fichier `docker-compose`, ni unité
systemd, ni pipeline de déploiement. Ce document documente la contrainte et
propose ce qui est raisonnable à mettre en place, sans prétendre que c'est
déjà fait.

## Pourquoi ce n'est pas un simple oubli

Le daemon a deux dépendances qui compliquent toute forme d'exécution
« gérée » (systemd system-wide, conteneur, orchestrateur) :

1. **Un accès au démon Docker.** `src/agent/sandbox.ts` lance `docker run`
   pour chaque tâche — le process du daemon doit donc pouvoir invoquer le
   client `docker` et joindre le socket du démon (`/var/run/docker.sock` en
   usage courant). Ce n'est pas négociable : c'est le mécanisme central de
   confinement de l'agent (voir `docs/adr/0002-garde-fou-chemin-tests.md` et
   le README, section « Garde-fous de sécurité »).
2. **Une inférence locale joignable.** Le proxy d'inférence
   (`src/tools/proxy.ts`) résout `INFERENCE_UPSTREAM_URL` (LM Studio par
   défaut, `127.0.0.1:1234`) **depuis le point de vue du process du daemon**,
   pas depuis un conteneur. Un LM Studio qui tourne sur la machine de
   l'opérateur suppose donc que le daemon tourne sur cette même machine, ou
   qu'on redirige explicitement `INFERENCE_UPSTREAM_URL` vers une inférence
   distante — ce que ce projet ne fait pas nativement.

### Le cas particulier d'un daemon conteneurisé

La tentation naturelle serait d'écrire un `Dockerfile` pour le daemon
lui-même, à côté de `docker/agent.Dockerfile` et `docker/node22.Dockerfile`.
C'est réalisable techniquement (Node 26, aucune dépendance native), mais ça
n'élimine aucune des deux contraintes ci-dessus — ça les déplace :

- pour lancer `docker run` depuis l'intérieur d'un conteneur, il faut soit
  monter le socket Docker de l'hôte en bind mount
  (`-v /var/run/docker.sock:/var/run/docker.sock`), soit du Docker-in-Docker
  complet. La première option donne au conteneur du daemon un accès
  équivalent à root sur l'hôte (n'importe qui capable d'écrire dans ce
  conteneur peut lancer n'importe quel conteneur, monter n'importe quel
  chemin de l'hôte en volume, etc.) — un niveau de risque nettement supérieur
  à celui que la sandbox de `sandbox.ts` cherche justement à réduire pour
  l'agent lui-même. Conteneuriser le daemon pour mieux l'isoler, puis lui
  donner cet accès pour qu'il puisse encore lancer Docker, ne va pas dans le
  sens visé ;
- l'inférence locale devrait alors être jointe via `host.docker.internal`
  (ou un réseau `host`), ce qui revient à réintroduire, pour le conteneur du
  daemon lui-même cette fois (pas celui de l'agent), une bonne partie de la
  surface que le proxy filtrant de `src/tools/proxy.ts` cherche à réduire
  pour l'agent.

Conclusion assumée : **conteneuriser le daemon lui-même n'est pas
raisonnable pour ce POC**, tant que Docker-in-Docker réel ou un socket Docker
partagé restent la seule voie technique disponible. Ce n'est pas une
question d'effort d'implémentation, c'est un compromis de sécurité qui va à
l'encontre de l'objectif du projet.

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
