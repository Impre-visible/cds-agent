FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1001 agent
USER agent

# §4.3 : sandbox.ts passe désormais --user <uid hôte>:<gid hôte> à chaque
# `docker run` (voir buildDockerRunArgs dans agent/sandbox.ts), qui écrase
# ce USER par défaut — celui-ci ne sert que de filet de sécurité pour une
# invocation manuelle sans --user (jamais root par défaut). HOME doit donc
# rester joignable en écriture par n'importe quel uid, pas seulement 1001 :
# /home/agent (créé par useradd -m ci-dessus) n'appartiendrait qu'à l'uid
# 1001 et serait fermé à tout autre uid passé via --user. On pointe donc
# HOME et le cache npm sous /tmp, mondialement inscriptible par défaut
# (mode 1777) — même modèle que docker/agent.Dockerfile, pour que les deux
# images se comportent de façon identique et documentée une fois passées
# dans sandbox.ts.
ENV HOME=/tmp/agent \
    npm_config_cache=/tmp/.npm
