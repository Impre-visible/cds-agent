# Image du DAEMON lui-même — à ne pas confondre avec docker/agent.Dockerfile
# (l'image dans laquelle tourne l'agent LLM) ni docker/node22.Dockerfile
# (l'image par défaut des dépôts cibles). Celle-ci n'exécute que du code de ce
# dépôt, jamais du code écrit par un modèle.
#
# Utilisée par docker-compose.yml, qui documente le modèle d'exécution complet
# (conteneurs frères via le socket de l'hôte, identité des chemins de travail).

# Le client docker SEUL, pas le moteur : le daemon lance ses conteneurs agent
# en FRÈRES via le socket de l'hôte monté par compose. Pas de docker-in-docker
# — ce serait un second moteur à faire tourner, alors que le besoin est
# simplement de piloter celui de la machine.
FROM docker:27-cli AS dockercli

FROM node:26-bookworm-slim

# git : le daemon clone les dépôts à relire et pousse les branches
# (voir src/agent/workspace.ts). ca-certificates : HTTPS vers l'API GitLab et
# vers le fournisseur d'inférence.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app

# Dépendances d'abord, sources ensuite : une modification de src/ ne réinstalle
# pas node_modules. `npm ci` et non `npm install` — c'est le lockfile qui fait
# foi, et il est versionné.
COPY package.json package-lock.json ./
RUN npm ci

# Rien à compiler : le projet exécute ses .ts directement, via le
# type-stripping natif de Node 26 (voir README). C'est aussi pourquoi l'image
# garde ses devDependencies — `npm run dev` passe par tsx.
COPY . .

# Pas de USER non-root, et il faut le dire plutôt que le subir : le daemon doit
# pouvoir écrire sur le socket docker monté, dont le propriétaire et le groupe
# varient d'un hôte à l'autre (root:root sur Linux, l'utilisateur courant sur
# Docker Desktop). Ce socket donne de toute façon un accès équivalent à root
# sur la machine — c'est LE compromis de ce mode de déploiement, détaillé dans
# docker-compose.yml. Le durcissement qui compte vraiment porte sur les
# conteneurs AGENT (--cap-drop ALL, --read-only, --network none par défaut,
# voir src/agent/sandbox.ts), qui sont les seuls à exécuter du code non fiable.

CMD ["npm", "run", "dev"]
