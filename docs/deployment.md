# Déploiement

Ce document répond à une question simple : comment ce POC tourne-t-il ailleurs
que dans un terminal ouvert avec `npm run dev` ? Aujourd'hui, la réponse est :
**avec `docker compose up -d --build`** pour le daemon, et un second compose
pour l'instance OpenHands (voir [`docs/openhands.md`](./openhands.md)). Il
n'existe en revanche ni unité systemd fournie, ni pipeline de déploiement.

## Ce que la délégation à OpenHands a simplifié — et ce qu'elle n'a pas réglé

Sur la branche `hardening`, le daemon avait deux dépendances qui compliquaient
toute forme d'exécution gérée : un accès au démon Docker (il lançait un
conteneur par tâche) et une inférence joignable **depuis son propre point de
vue** (il hébergeait le proxy filtrant).

**Les deux ont disparu du daemon.** Il ne lance plus aucun conteneur, ne clone
plus rien, ne parle plus à un serveur de modèle. Son image n'embarque ni git ni
le client docker, ne monte pas `/var/run/docker.sock`, et tourne sous un
utilisateur non root. Ses seuls appels sortants sont l'API GitLab et l'instance
OpenHands.

**Elles n'ont pas disparu du déploiement**, elles ont changé de conteneur.
C'est OpenHands qui monte désormais le socket Docker — accès équivalent à root
sur la machine — pour créer ses bacs à sable, et qui doit joindre le serveur
d'inférence. La contrainte n'est pas éliminée : elle est déplacée vers un
composant qu'on n'écrit pas, et qui détient en plus le jeton GitLab en
écriture. C'est le compromis central de cette branche, détaillé dans
[`docs/openhands.md`](./openhands.md).

Ce qui EST réellement plus simple : le daemon n'a plus besoin de l'identité de
chemin hôte ↔ conteneur (`CDS_WORK_DIR`, `TMPDIR`) que le montage des espaces
de travail imposait, ni du réseau partagé pour rendre le proxy d'inférence
joignable depuis les conteneurs agent. Ces deux contraintes — les deux qui
faisaient échouer une version naïve du compose — n'existent plus. Le réseau
partagé subsiste, mais pour une raison beaucoup plus banale : que le daemon
puisse joindre OpenHands par son nom de conteneur.

## Ce qui reste vrai

- **Un seul daemon par verrou de fichier** (`src/daemon/lock.ts`) : pas de
  réplicas actifs, pas de haute disponibilité. Un daemon qui tombe est un
  daemon qui ne traite plus rien jusqu'au redémarrage suivant.
- **La file est en mémoire** : ce qui n'a pas démarré au moment d'un arrêt est
  perdu (voir `docs/adr/0004-contrat-fiabilite-file-memoire.md`). Une nuance
  propre à cette branche : une tâche `running` interrompue laisse une
  conversation OpenHands VIVANTE, qui continue sans personne pour en lire le
  résultat.
- **`STATE_FILE` doit survivre** à un `docker compose down` : c'est lui qui
  évite de rejouer une demande déjà traitée. Le volume `openhands-state` de
  l'autre compose a la même exigence, pour la même raison (il porte le jeton
  GitLab déclaré dans les réglages de l'instance).

## Redémarrage automatique

`restart: unless-stopped`, présent dans les deux compose, couvre le crash et le
redémarrage de la machine.
Sur macOS, il faut en plus que Docker Desktop soit réglé pour se lancer à
l'ouverture de session (*Settings → General → Start Docker Desktop when you
sign in*) : sans lui, aucun conteneur ne redémarre.

## Ce qui est raisonnable

Faire tourner le daemon comme un **process de longue durée sur l'hôte**, sous
un compte de service dédié, via une unité **systemd (user ou system)**. C'est
nettement plus facile qu'avant : le daemon n'a plus besoin ni du socket Docker
ni d'un accès direct à `127.0.0.1` pour l'inférence — seulement de joindre
GitLab et l'instance OpenHands en HTTP.

Exemple d'unité **non testée** (aucun environnement systemd disponible pour
la vérifier dans le cadre de ce chantier de documentation) — à adapter et à
valider avant tout usage réel :

```ini
# /etc/systemd/system/cds-agent.service  (ou ~/.config/systemd/user/ en mode --user)
[Unit]
Description=cds-agent (POC) — dispatcher de to-dos GitLab vers OpenHands
After=network-online.target
Wants=network-online.target

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

# Durcissement systemd — plus rien ici n'a besoin du socket Docker, donc
# rien n'empêche de serrer. Le confinement de ce qu'exécute le LLM, lui, ne
# se joue plus du tout à ce niveau : il est entre les mains d'OpenHands.
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/cds-agent/state
PrivateDevices=true
ProtectKernelTunables=true

[Install]
WantedBy=multi-user.target
```

Points d'attention pour qui voudrait vraiment déployer ça :

- **`EnvironmentFile`** attend un fichier au format `NOM=valeur` par ligne,
  compatible avec `.env` tel qu'utilisé ici — mais le petit parseur de
  `src/config.ts` (`loadDotEnv()`) et celui de systemd ne gèrent pas
  forcément les guillemets ou les valeurs multi-lignes de façon identique ;
  à vérifier valeur par valeur, pas supposé.
- **Le compte qui lance le service n'a PLUS besoin d'invoquer `docker`** — il
  n'a donc plus à être membre du groupe `docker`, ni à disposer de l'accès
  équivalent root que cette appartenance donne. C'est le seul gain de sécurité
  net et non transféré de cette branche. En revanche, le compte qui fait
  tourner l'instance OpenHands, lui, en a besoin.
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

- **Faire du daemon et d'OpenHands un seul compose** : ils ont des cycles de
  vie différents (on redémarre le daemon en développant, pas l'instance et son
  volume d'état), et OpenHands doit pouvoir tourner seul le temps d'être réglé
  à la main dans son interface. Deux fichiers reliés par un réseau nommé
  coûtent une commande de plus et évitent ça.
- **Un déploiement Kubernetes** (ou équivalent) : suppose une haute
  disponibilité et une répartition de charge que l'architecture actuelle ne
  fournit pas (verrou mono-instance, file en mémoire non partagée, un seul
  worker séquentiel — voir `docs/adr/0004-contrat-fiabilite-file-memoire.md`).
  Rien n'empêche d'y arriver un jour, mais ce serait un chantier
  d'architecture à part entière, pas un ajustement de packaging.
