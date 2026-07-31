FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm i -g opencode-ai@latest

ENV HOME=/tmp/agent \
    XDG_CONFIG_HOME=/tmp/agent/.config \
    XDG_DATA_HOME=/tmp/agent/.local/share \
    XDG_CACHE_HOME=/tmp/agent/.cache \
    npm_config_cache=/tmp/.npm

# Le conteneur tourne sous l'uid de l'hôte via --user : ces dossiers
# doivent être inscriptibles quel que soit cet uid.
RUN mkdir -p /tmp/agent/.config /tmp/agent/.local/share /tmp/agent/.cache /tmp/.npm \
    && chmod -R 777 /tmp/agent /tmp/.npm
