FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm i -g opencode-ai@latest

# Même modèle d'exécution que docker/node22.Dockerfile (image install/tests) —
# §4.3 : un utilisateur non root par défaut, systématiquement écrasé à
# l'exécution par sandbox.ts, qui passe --user <uid hôte>:<gid hôte>
# (buildDockerRunArgs). Avant ce correctif, cette image n'avait pas de USER
# du tout (donc root par défaut) alors que node22.Dockerfile en avait un
# (uid 1001) : deux modèles d'exécution différents et non documentés pour
# un même daemon. Sans --user réellement passé (c'était le bug), le
# conteneur agent tournait effectivement en root et écrivait des fichiers
# root dans le dépôt monté depuis le /tmp de l'hôte — le rmSync
# best-effort de dispose() (workspace.ts) échoue alors en EPERM sur Linux.
RUN useradd -m -u 1001 agent
USER agent

# Voir la note équivalente dans docker/node22.Dockerfile : buildDockerRunArgs
# (agent/sandbox.ts) injecte désormais ces cinq mêmes valeurs en -e à chaque
# `docker run`, pour que la convention tienne quelle que soit l'image — y
# compris une image de ce dépôt qui n'aurait pas été reconstruite.
ENV HOME=/tmp/agent \
    XDG_CONFIG_HOME=/tmp/agent/.config \
    XDG_DATA_HOME=/tmp/agent/.local/share \
    XDG_CACHE_HOME=/tmp/agent/.cache \
    npm_config_cache=/tmp/.npm

# HOME et le cache npm vivent sous /tmp plutôt que /home/agent : --user
# écrase l'uid 1001 ci-dessus par l'uid réel de l'hôte (pas nécessairement
# 1001), qui doit donc pouvoir y écrire aussi. On ne pré-crée PLUS ces
# sous-dossiers ici avec un chmod -R 777 (le pansement que ce correctif
# retire) : /tmp est déjà mondialement inscriptible dans l'image de base
# (mode 1777, comme sur tout système Unix), donc n'importe quel uid peut y
# créer ses propres sous-répertoires à la volée (opencode, npm...) sans
# qu'on ait besoin de les précréer avec des permissions élargies. Ceinture
# et bretelles supplémentaire en exécution normale : sandbox.ts monte /tmp
# en tmpfs rw (mode 1777) via --read-only + --tmpfs (voir sandbox.ts), qui
# masque de toute façon tout ce qui existerait ici au moment du build.
