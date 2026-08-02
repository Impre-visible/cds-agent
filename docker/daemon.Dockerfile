# Image du DAEMON — le dispatcher. Il n'exécute que du code de ce dépôt,
# jamais du code écrit par un modèle : tout ce qu'un agent produit vit dans le
# bac à sable d'OpenHands, dans un autre conteneur, sur une autre image (voir
# docker/openhands/docker-compose.yml et docs/openhands.md).
#
# Ce que cette image N'A PLUS, par rapport à la branche `hardening` :
#   - le client docker, parce que le daemon ne lance plus aucun conteneur ;
#   - git, parce qu'il ne clone plus rien et ne pousse plus rien.
# Elle ne monte donc pas non plus le socket docker de l'hôte — cet accès
# équivalent à root disparaît côté daemon. Il n'a pas disparu du déploiement
# pour autant : c'est OpenHands qui le détient désormais, puisque c'est lui
# qui crée les bacs à sable.

FROM node:26-bookworm-slim

# ca-certificates : HTTPS vers l'API GitLab. Avec l'appel vers l'instance
# OpenHands, c'est tout ce que ce process émet sur le réseau.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

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

# Utilisateur non root — possible ici, alors que la branche `hardening` devait
# y renoncer : plus rien n'a besoin d'écrire sur un socket docker dont le
# propriétaire et le groupe varient d'un hôte à l'autre. Le daemon n'écrit que
# dans /app/state, monté par compose et rendu inscriptible pour cet uid.
USER node

CMD ["npm", "run", "dev"]
