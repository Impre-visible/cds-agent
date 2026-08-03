# cds-agent, branche `openhands`

Sur cette branche, `cds-agent` est réduit à ce qu'il fait de mieux : détecter
les mentions GitLab et dispatcher. Tout le reste — clone, exploration, revue,
écriture, publication — passe à une instance [OpenHands](https://openhands.dev)
auto-hébergée.

**Il n'y a pas de commutateur.** La branche EST la variable : `hardening` porte
l'exécution maison (sandbox durcie, périmètre vérifié, tests rejoués côté
hôte), `openhands` porte la délégation intégrale. On compare les deux en
changeant de branche, pas en changeant un réglage — ce qui évite qu'un chemin
mort traîne dans le code de l'autre, et rend la question posée nette : est-ce
que le montage maison fait mieux qu'OpenHands tel quel ?

Le code de l'exécution maison n'existe plus ici. `src/agent/`, `src/tools/`,
`tasks/review.ts`, `tasks/implement.ts`, `tasks/guard.ts`, `tasks/publish.ts`,
`tasks/context.ts`, `tasks/planner.ts`, `tasks/router.ts` et leurs tests ont
été supprimés, avec les variables d'environnement qui les pilotaient. Ils sont
intacts sur `hardening`.

## Sommaire

- [Ce qui change vraiment](#ce-qui-change-vraiment)
- [Démarrer l'instance](#démarrer-linstance)
- [Configurer l'accès GitLab](#configurer-laccès-gitlab)
- [Changer de modèle](#changer-de-modèle)
- [Lancer une revue](#lancer-une-revue)
- [Où vivent les prompts et les compétences](#où-vivent-les-prompts-et-les-compétences)
- [Le bac à sable](#le-bac-à-sable)
- [Ce qui a été vérifié, et où](#ce-qui-a-été-vérifié-et-où)
- [Ce que je n'ai pas pu vérifier](#ce-que-je-nai-pas-pu-vérifier)
- [Pièges rencontrés au montage](#pièges-rencontrés-au-montage)
- [Comparabilité avec le banc de mesure](#comparabilité-avec-le-banc-de-mesure)

## Ce qui change vraiment

### Ce que le daemon garde

Tout l'amont, celui qui fonctionne et qui est mesuré : polling des to-dos et
fenêtre de rattrapage (`daemon/todos.ts`), construction de la demande et
relecture de la note complète (`daemon/request.ts`), listes blanches
fail-closed (`daemon/authorize.ts`), journal d'idempotence (`daemon/store.ts`),
file FIFO à un seul worker (`daemon/queue.ts`), accusé de réception par
réaction emoji, verrou d'instance, arrêt gracieux, `/healthz`.

### Ce que le daemon cesse de garantir

C'est le cœur du compromis, et il faut le lire avant de basculer un dépôt qui
compte.

| Garantie sur `hardening` | Sur cette branche |
|---|---|
| Périmètre des fichiers modifiés vérifié avant le push (`tasks/guard.ts`) | **Disparue.** Une consigne dans le prompt, rien de plus |
| Tests de référence rejoués côté hôte avant publication | **Disparue.** OpenHands décide seul de ce qu'il livre |
| Contrôle de `HEAD` et de `.git` après exécution | **Disparue** |
| Remarques validées et repositionnées avant publication (`tasks/publish.ts`) | **Disparue.** OpenHands commente directement |
| Sandbox `--cap-drop ALL --read-only --network none` | **Remplacée** par le bac à sable d'OpenHands, avec ses réglages |
| Jeton GitLab jamais confié à un processus non fiable | **Abandonné.** OpenHands détient le jeton en écriture |

Les capacités de `projects.json` sont toujours lues, et un dépôt qui n'en
accorde aucune est toujours refusé — mais pour le reste, elles ne sont plus
qu'une phrase adressée à l'agent (voir `permissionStatement` dans
`src/tasks/openhands.ts`). Un agent qui passe outre n'est plus arrêté par
personne.

`commands` et `docker.image` de `projects.json` ne sont plus lus du tout : le
daemon n'installe rien et ne lance aucun conteneur. Ils restent acceptés dans
le fichier — sans quoi le même `projects.json` ne serait pas valide sur les
deux branches, et comparer demanderait de l'éditer à chaque bascule.

C'est un choix assumé : ce chantier troque des garde-fous maison contre la
maturité d'un agent dédié. Ce qui est perdu doit être regagné par la
configuration d'OpenHands — c'est le sujet des sections suivantes.

### Le nouveau chemin

```
to-do GitLab
  → filtres et autorisations          (inchangé)
  → réaction 👀                        (inchangé)
  → file FIFO                          (inchangé)
  → POST /api/v1/app-conversations     (nouveau)
  → sondage jusqu'à complétion         (nouveau)
  → réaction ✅/🔍/❌ ; note UNIQUEMENT si le daemon sait quelque chose
    que la merge request ne montre pas (adresse de la conversation : au log)
```

## Démarrer l'instance

### Prérequis

Dans `.env`, à la racine :

```dotenv
OPENHANDS_URL=http://127.0.0.1:3000          # depuis un terminal
OPENHANDS_API_KEY=<openssl rand -hex 32>
AGENT_MODEL=openai/<votre-modèle>            # voir la note sur LiteLLM plus bas
CONTAINER_INFERENCE_URL=http://host.docker.internal:1234/v1
INFERENCE_API_KEY=<si le fournisseur en réclame une>
```

`OPENHANDS_URL` est obligatoire : sans elle le daemon refuse de démarrer,
puisqu'il n'a aucun autre exécutant. En conteneur, `docker-compose.yml` la
remplace par `http://cds-openhands:3000` — le nom du conteneur sur le réseau
partagé.

### `OPENHANDS_API_KEY` : laissez-la VIDE, sauf si vous exposez le port

C'est contre-intuitif, alors voici la mesure plutôt que le raisonnement.

Renseignée, elle protège l'API V1 : chaque requête doit porter un en-tête
`X-Session-API-Key` correspondant. **Mais le client HTTP de l'interface web
n'envoie aucun en-tête d'authentification** — `frontend/src/api/open-hands-axios.ts`
n'a qu'un intercepteur de *réponse*, rien en requête, pas de `withCredentials`,
et il n'existe pas d'écran de saisie de clé dans ce build open source. Dès que
`SESSION_API_KEY` est posée, l'interface se prend un `401` sur chacun de ses
appels : plus de réglages, plus de lecture des conversations. Vérifié contre
une instance réelle : `GET /api/v1/settings` sans clé → `401`, avec clé →
`404` (le code documenté pour « aucun réglage enregistré »).

Le compose la laisse donc **vide par défaut**. Ce qui protège l'instance dans
cette configuration n'est pas une clé, c'est le `ports:` : le port n'est publié
que sur `127.0.0.1`, et le daemon passe par le réseau Docker privé. Rien
d'extérieur à la machine ne l'atteint.

Posez une clé si vous exposez le port au-delà du loopback — mais sachez que
vous perdez alors l'interface, et qu'il faudra tout piloter par l'API. Pour une
campagne de comparaison, c'est un mauvais échange : la visibilité sur ce que
fait l'agent est précisément ce qu'on cherche à évaluer.

### Les deux commandes

Le réseau d'abord (il est créé par le compose du daemon ; à la main si vous ne
lancez pas le daemon en conteneur) :

```bash
docker network create cds-agent-net
```

Puis l'instance, **depuis la racine du dépôt** :

```bash
docker compose --env-file .env -f docker/openhands/docker-compose.yml up -d
```

`--env-file .env` n'est pas décoratif — voir
[Pièges rencontrés au montage](#pièges-rencontrés-au-montage).

### Vérifier qu'elle répond

```bash
curl -sS http://127.0.0.1:3000/health
# → OK
```

`/health` est hors de `/api/v1` et n'est pas authentifié. Pour vérifier que la
clé passe bien, interrogez une route V1 :

```bash
curl -sS -H "X-Session-API-Key: $OPENHANDS_API_KEY" \
  'http://127.0.0.1:3000/api/v1/app-conversations/search?limit=1'
```

Un `401` signifie que `OPENHANDS_API_KEY` et `SESSION_API_KEY` divergent — ou
que vous avez posé une clé côté serveur et pas côté client. Une liste JSON
signifie que tout est en place.

Avec la configuration par défaut (aucune clé), ces deux requêtes répondent sans
en-tête, et **l'interface web fonctionne** — c'est le point à vérifier en
premier : si `http://127.0.0.1:3000` affiche des erreurs sur chaque action,
c'est presque toujours `SESSION_API_KEY` qui est posée.

Le daemon fait lui-même ce premier appel à `/health` au démarrage et le
journalise — sans refuser de démarrer si l'instance n'est pas encore là
(l'ordre de `docker compose up` ne garantit rien).

## Configurer l'accès GitLab

Deux réglages, et ils ne font pas la même chose.

### 1. L'hôte — `GITLAB_HOST`

Vérifié dans le code amont
(`openhands/app_server/integrations/gitlab/constants.py`) : `GITLAB_HOST` est
un **nom d'hôte**, avec `gitlab.com` pour défaut. Le code retire de lui-même
`https://`, `http://` et le `/` final, donc y coller votre `GITLAB_URL`
fonctionne. Le compose le fait déjà.

C'est ce qui rend une instance **self-managed** utilisable : sans ça, OpenHands
parlerait à gitlab.com.

Si votre GitLab interne est en HTTP simple, il faut en plus
`ALLOW_INSECURE_GIT_ACCESS=true` sur le conteneur OpenHands.

### 2. Le jeton

`GITLAB_TOKEN` arrive dans le conteneur par `env_file`, et OpenHands l'exporte
dans l'environnement du bac à sable — l'agent peut donc s'en servir en ligne
de commande. Mais pour que **le serveur lui-même** sache cloner le dépôt de
`selected_repository`, le jeton doit être déclaré dans ses réglages. Une fois,
après le premier démarrage :

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/settings \
  -H "X-Session-API-Key: $OPENHANDS_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
        "provider_tokens": {
          "gitlab": { "token": "'"$GITLAB_TOKEN"'", "host": "gitlab.example.com" }
        }
      }'
```

Le champ `host` du jeton est vérifié dans le modèle `ProviderToken`
(`openhands/app_server/integrations/provider.py`). Le réglage survit à un
`docker compose down` grâce au volume `openhands-state`.

L'équivalent en cliquant : `Settings > Integrations > GitLab Token`.

### Un ou deux comptes bot ?

Le daemon et OpenHands peuvent partager le même PAT — c'est ce que fait le
compose, par simplicité. Deux comptes valent mieux si vous voulez distinguer
dans l'historique GitLab ce qui vient de l'accusé de réception (le daemon) et
ce qui vient du travail (OpenHands), ou révoquer l'un sans l'autre.

**Portée du jeton.** La documentation amont demande `api`, `read_user`,
`read_repository`, `write_repository`. Elle décrit aussi un montage à deux
jetons : le jeton large dans `Settings > Integrations` pour le serveur, un
jeton plus étroit (sans `api`) déclaré comme secret `GITLAB_TOKEN` dans
`Settings > Secrets` pour ce que l'agent manipule lui-même. Réduire ce que
l'agent peut faire sans réduire ce que le serveur peut faire — c'est le levier
le plus intéressant côté sécurité, et je ne l'ai pas testé.

## Lancer une revue

Rien ne change côté utilisateur. Dans une merge request d'un dépôt autorisé
par `projects.json` :

```
@cds-bot review
```

Le daemon poste 👀, met la demande en file, démarre une conversation OpenHands,
attend, puis fait évoluer la réaction en ✅ / 🔍 / ❌.

**Sur le cas nominal, il ne publie aucune note.** OpenHands a déjà publié son
travail sur la merge request ; une note du daemon par-dessus ferait deux
messages pour un seul résultat. Restent publiés les seuls cas où le daemon sait
quelque chose que la merge request ne montre pas : attente d'une décision
humaine, abandon d'attente, échec.

**Aucun lien vers la conversation n'est publié non plus**, et c'est délibéré :
une merge request est lue par des gens qui n'ont pas accès à l'instance, et
elle lui survit. L'adresse est journalisée côté daemon.

Pour lancer le daemon depuis un terminal :

```bash
npm run dev
```

Le journal doit afficher, au démarrage :

```
Exécution déléguée à OpenHands (http://127.0.0.1:3000).
⚠ Le daemon ne vérifie pas ce qui part : OpenHands publie et pousse lui-même…
OpenHands répond (GET /health → OK).
```

### Ce qui est envoyé

Volontairement minimal (voir `buildMessage` dans `src/tasks/openhands.ts`) :
la cible et son adresse, le demandeur, le texte exact de la demande encadré
comme une donnée non fiable, et les limites accordées au dépôt. **Pas** de
diff numéroté, pas de ticket lié, pas de commentaires humains récents —
OpenHands clone et explore lui-même. S'il lui manque quelque chose, ça se règle
dans sa configuration, pas dans ce message.

Un seul appel supplémentaire à GitLab est fait avant de dispatcher : la lecture
de la merge request pour connaître sa **branche source**, sans laquelle
OpenHands travaillerait sur la branche par défaut du dépôt. Best-effort : si
l'appel échoue, le daemon délègue quand même.

### Une conversation par merge request, pas une par mention

Le daemon tient un registre `state/conversations.json` qui associe chaque
merge request à sa conversation OpenHands (`src/openhands/conversations.ts`).
Une deuxième mention sur la même MR **reprend** la conversation existante via
`POST /api/v1/app-conversations/{id}/send-message` au lieu d'en ouvrir une
neuve.

Deux raisons, et la seconde n'était pas prévue :

1. **Un conteneur par merge request, pas un par mention.** Sans ça, chaque
   relance laisse un `oh-agent-server-*` de plus (voir les pièges ci-dessous).
2. **L'agent garde son contexte.** « J'ai pas compris ta remarque » arrive
   dans une conversation qui contient la remarque. C'est ce qui remplace, en
   mieux, le chemin dédié aux fils de discussion de `hardening`
   (`tasks/explain.ts`), qui n'existe pas ici.

Le message de relance ne répète pas le préambule (cible, adresse) — l'agent
l'a déjà — mais **redit les limites**, parce que `projects.json` est relu à
chaud et qu'elles ont pu changer entre deux mentions.

Le daemon repart sur une conversation neuve, en oubliant l'entrée du registre,
dans tous les cas où la reprise n'a pas de sens : conversation supprimée dans
l'interface, bac à sable `MISSING`/`ERROR`, conversation archivée (410), ou
dernière exécution en `error`/`stuck` — relancer un modèle enlisé ne le
désenlise pas. Un bac à sable simplement en `PAUSED` (mis en pause par
OpenHands pour tenir sa limite) est **relancé** (`POST
/api/v1/sandboxes/{id}/resume`) plutôt qu'abandonné.

## Où vivent les prompts et les compétences

C'est ici que se joue la qualité, et c'est le vrai sujet du chantier. Les
règles qui vivaient dans `buildPrompt` (`tasks/review.ts`, `tasks/implement.ts`)
— lire les fichiers en entier, chercher des défauts réels, ne pas écrire un
test qui épouse un comportement buggé — n'ont plus d'endroit où être dites
depuis le daemon. Elles doivent aller **dans le dépôt relu**, ou dans
l'instance.

OpenHands appelle désormais ça des **compétences** (*skills*) ; « microagents »
est l'ancien nom, et les anciens répertoires restent lus.

### Les quatre emplacements

| Ce que vous voulez | Où l'écrire | Quand c'est chargé |
|---|---|---|
| Conventions valables pour **tout** ce qui touche un dépôt | `AGENTS.md` à la racine **du dépôt relu** | Toujours, dans le prompt système |
| Savoir-faire n'utile qu'à certaines tâches | `<dépôt>/.agents/skills/<nom>/SKILL.md` | Nom + description toujours ; contenu quand l'agent l'invoque |
| Déclenchement sur un mot-clé de la demande | même fichier, avec `triggers:` en frontmatter | Injecté quand le mot apparaît |
| Règle attachée à des fichiers précis | même fichier, avec `paths:` | Injecté quand un fichier correspondant est lu ou écrit |
| Règles valables pour **tous** les dépôts | `~/.agents/skills/` **dans le conteneur OpenHands** | Toujours disponible |

`.openhands/microagents/` et `.openhands/skills/` restent supportés ;
`.agents/skills/` est l'emplacement à retenir pour du neuf. Précédence :
projet > utilisateur > registre public.

Format minimal d'un `SKILL.md` :

```markdown
---
name: revue-defauts-reels
description: Comment relire une merge request sur ce dépôt. À utiliser pour toute demande de revue.
---

Lis chaque fichier touché EN ENTIER avant de commenter une ligne.
Ne signale que ce qui est faux, pas ce qui est différent de tes préférences.
```

Pour des règles **globales** à tous les dépôts, montez un répertoire hôte sur
`/root/.agents/skills` dans le service `openhands` du compose. Je ne l'ai pas
fait par défaut : le `HOME` réel du processus dans l'image amont n'est pas
documenté, et un montage au mauvais endroit échoue en silence — c'est
exactement le genre de chose à vérifier au montage plutôt qu'à supposer.

### Les deux autres leviers

- `<dépôt>/.openhands/setup.sh` : joué à chaque fois qu'OpenHands commence à
  travailler sur ce dépôt. C'est là que va `npm ci` — l'équivalent de
  `INSTALL_COMMANDS` dans `projects.json`.
- `<dépôt>/.openhands/hooks.json` : des **hooks `stop`** peuvent BLOQUER la fin
  d'une tâche tant qu'un script ne passe pas. C'est le seul mécanisme amont qui
  ressemble à ce que `tasks/guard.ts` faisait côté hôte, et c'est le premier
  endroit où regarder pour regagner une partie de ce qui est perdu :

  ```json
  {
    "stop": [
      { "matcher": "*", "hooks": [{ "command": ".openhands/hooks/quality_gate.sh", "timeout": 120 }] }
    ]
  }
  ```

  Le script rend `{"decision":"deny","reason":"..."}` et sort en 2 pour refuser.
  Différence de nature à ne pas perdre de vue : ce garde-fou tourne **dans le
  bac à sable**, versionné dans le dépôt relu — donc modifiable par ce que
  l'agent y écrit. Celui de `hardening` tournait sur l'hôte, hors de sa
  portée.

## Changer de modèle

### En pratique : deux lignes

```bash
sed -i '' 's|^AGENT_MODEL=.*|AGENT_MODEL=openrouter/anthropic/claude-sonnet-4|' .env
npm run dev
```

C'est tout. Le daemon aligne l'instance OpenHands sur `AGENT_MODEL` à chaque
démarrage, et le dit :

```
Modèle OpenHands changé — modèle : openrouter/xiaomi/mimo-v2.5 → openrouter/anthropic/claude-sonnet-4.
1 conversation(s) oubliée(s) : les merge requests déjà touchées repartiront sur une
conversation neuve, sans quoi elles auraient continué avec l'ancien modèle.
```

Au démarrage suivant, sans changement : `Modèle OpenHands : déjà aligné sur …`
— aucune écriture, donc aucun risque d'écraser un réglage fait à la main dans
l'interface entre deux campagnes.

### Pourquoi le daemon doit s'en mêler

Parce que `.env` **seul** ne fait rien, et silencieusement.

Vérifié en le testant : instance relancée avec `LLM_MODEL=openai/sonde-de-test`
dans son environnement, `GET /api/v1/settings` continuait d'annoncer le modèle
précédent — et c'est celui-là que l'agent utilise. Aucun code de l'application
server V1 ne lit `LLM_MODEL` ni `LLM_API_KEY` ; `LLM_BASE_URL` n'y est lu que
comme repli pour `OPENHANDS_PROVIDER_BASE_URL`, qui est autre chose. Le modèle
vit dans les **réglages de l'instance** (`agent_settings.llm.*`), persistés
dans le volume `openhands-state`.

Sans cet alignement, changer de modèle demanderait de cliquer dans l'interface
à chaque fois — ingérable pour comparer une dizaine de modèles. Et surtout :
sur `hardening`, `AGENT_MODEL` dans `.env` **est** le modèle. Une campagne où
une branche lit `.env` et l'autre un réglage d'interface est une campagne où
l'on finit par mesurer deux modèles différents sans s'en apercevoir. C'est
l'erreur la plus coûteuse possible dans une comparaison, et la moins visible.

### Le piège que l'alignement referme

Une conversation **garde le modèle avec lequel elle a démarré**, et sur cette
branche une merge request réutilise sa conversation. Changer de modèle sans
rien d'autre ferait donc remesurer l'ANCIEN modèle sur toute MR déjà touchée.

Le registre `state/conversations.json` est donc vidé dès que le modèle change,
et seulement dans ce cas : poser une clé d'API manquante ou corriger un
`base_url` n'y touche pas — ces conversations tournent déjà sur le bon modèle,
les jeter perdrait du contexte pour rien.

### Les deux autres façons de faire

**Par l'interface** — `Settings > LLM`, `Advanced` activé. Attention : le
prochain démarrage du daemon réalignera sur `.env`.

**Par l'API**, si vous scriptez sans passer par le daemon :

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/settings \
  -H 'content-type: application/json' \
  -d '{"agent_settings_diff": {"llm": {
        "model": "openrouter/anthropic/claude-sonnet-4",
        "base_url": "https://openrouter.ai/api/v1",
        "api_key": "sk-or-..." }}}'
```

`agent_settings_diff` fait une fusion en profondeur côté serveur : envoyer le
seul sous-objet `llm` ne touche ni aux réglages MCP, ni au condenseur.

### Ce qui n'est pas détecté

Une clé d'API **changée** à modèle et point d'accès identiques passe
inaperçue : le serveur ne rend jamais la clé, seulement `llm_api_key_set`. La
seule alternative serait de réécrire les réglages à chaque démarrage, ce qui
effacerait sans prévenir tout réglage fait à la main. Si vous changez de clé
sans changer de modèle, passez par l'interface ou le curl ci-dessus.

## Le bac à sable

Réglages exposés par OpenHands (préfixe `SANDBOX_`) : `SANDBOX_TIMEOUT`,
`SANDBOX_BASE_CONTAINER_IMAGE`, `SANDBOX_VOLUMES`, `SANDBOX_USER_ID`,
`SANDBOX_USE_HOST_NETWORK`, `SANDBOX_ENABLE_GPU`, `SANDBOX_KEEP_RUNTIME_ALIVE`,
`SANDBOX_ENV_*` (passe-plat vers l'environnement du bac à sable). Le
fournisseur se choisit par `RUNTIME` : `docker` (défaut), `process` (aucune
isolation), `remote`.

**Il n'y a pas d'équivalent à `--cap-drop ALL`, `--read-only` ou
`--pids-limit`.** Le durcissement de `src/agent/sandbox.ts` n'a pas de pendant
dans les variables documentées. Pour une revue en lecture seule, il n'y a pas
non plus de commutateur amont qui retirerait les outils d'écriture à l'agent :
le levier disponible est le prompt (ce que fait `permissionStatement`) et,
éventuellement, un jeton GitLab en lecture seule côté `Settings > Secrets`.

`SECURITY_CONFIRMATION_MODE=true` fait demander confirmation avant chaque
action. Le daemon le gère : la conversation passe en
`waiting_for_confirmation`, il le rapporte comme 🔍 « à trancher » avec le lien.
Mais personne ne répondra automatiquement — c'est un mode interactif, pas un
mode daemon.

## Ce qui a été vérifié, et où

Tout ce qui suit vient du **code du serveur** ou de la documentation officielle,
pas d'un exemple ni d'un billet de blog. Le code de l'application server vit
dans `OpenHands/legacy` (déplacé depuis `OpenHands/OpenHands`, qui héberge
désormais Agent Canvas — voir la section suivante).

| Fait | Source |
|---|---|
| Les routes V1 sont montées sous `/api/v1` | `openhands/app_server/v1_router.py` |
| `POST /api/v1/app-conversations` rend un `AppConversationStartTask` | `app_conversation/app_conversation_router.py`, `@router.post('')` |
| `GET /api/v1/app-conversations?ids=` et `/start-tasks?ids=` sont des lectures **par lot** : tableau aligné, `null` pour un inconnu. Il n'existe pas de `GET /<id>` | mêmes fichiers, `batch_get_*` |
| L'authentification auto-hébergée est `X-Session-API-Key` contre `SESSION_API_KEY`, **pas** `Authorization: Bearer` | `openhands/app_server/utils/dependencies.py` |
| Sans `SESSION_API_KEY`, aucun contrôle n'est installé | même fichier, `get_dependencies()` |
| `initial_message` = `{role, content:[{type,text}]}` | `openhands/sdk/conversation/request.py`, `SendMessageRequest` |
| Statuts de démarrage (`WORKING` → … → `READY` / `ERROR`) | `app_conversation_models.py`, `AppConversationStartTaskStatus` |
| Statuts d'exécution, et le fait qu'`idle` **n'est pas** terminal | `openhands/sdk/conversation/state.py`, `is_terminal()` |
| `SandboxStatus` : `STARTING`/`RUNNING`/`PAUSED`/`ERROR`/`MISSING` | `sandbox/sandbox_models.py` |
| `GITLAB_HOST`, nom d'hôte, défaut `gitlab.com`, préfixes retirés | `integrations/gitlab/constants.py` |
| `ProviderToken` a un champ `host` | `integrations/provider.py` |
| `GET /health` hors `/api/v1`, non authentifié | `app.py` + `status/status_router.py` |
| L'interface web n'envoie aucun en-tête d'authentification — `SESSION_API_KEY` la casse | `frontend/src/api/open-hands-axios.ts`, **et vérifié contre une instance réelle** |
| Image, port, `docker.sock`, `AGENT_SERVER_IMAGE_*` | [docs — Setup](https://docs.openhands.dev/openhands/usage/run-openhands/local-setup) |
| `openai/<modèle>` + `LLM_BASE_URL` pour un point d'accès compatible OpenAI | [docs — Local LLMs](https://docs.openhands.dev/openhands/usage/llms/local-llms) |
| Compétences : emplacements, précédence, frontmatter | [docs — Skills](https://docs.openhands.dev/overview/skills) |
| `setup.sh` et hooks `stop` | [docs — Repository Customization](https://docs.openhands.dev/openhands/usage/customization/repository) |
| Variables `SANDBOX_*`, `LLM_*`, `ALLOW_INSECURE_GIT_ACCESS` | [docs — Environment Variables](https://docs.openhands.dev/openhands/usage/environment-variables) |

### Deux corrections au cahier des charges

**La version.** La dernière version documentée est **1.8**, pas 1.7.0 (tags
`v1.8.0`, `v1.7.2`, `v1.7.1`, `v1.7.0` sur le dépôt amont). Le compose épingle
`1.8` ; l'image de bac à sable qui va avec est `1.26.0-python`.

**Le v0.** Le cahier des charges annonce `/api/conversations` supprimé le
1er avril 2026. La documentation V1 actuelle dit le contraire : « OpenHands is
in a transition period: legacy (V0) endpoints still exist alongside the new
`/api/v1` endpoints ». Les en-têtes de dépréciation dans le code portent bien
la date d'avril 2026, mais le code V0 est toujours là. Sans effet sur ce
chantier — le client n'utilise que V1 — mais la prémisse est fausse et
ça vaut d'être dit.

## Ce que je n'ai pas pu vérifier

Liste explicite, comme demandé. Rien de ce qui suit n'a été testé contre une
instance réelle : je n'en ai pas démarré une.

1. **Aucune exécution de bout en bout.** Le client est testé unitairement
   (25 tests : requête, réponse, statuts, timeout) contre un `fetch` simulé.
   La forme exacte du JSON a été relue dans les modèles Pydantic du serveur,
   mais aucun octet n'a été échangé avec une vraie instance.

2. **Où sont faits les appels au modèle.** En V1, l'agent tourne dans le
   conteneur *agent-server*, pas dans le serveur OpenHands. Il est donc
   possible que `LLM_BASE_URL` doive être joignable **depuis le bac à sable**
   et pas seulement depuis le serveur. Le compose ajoute
   `host.docker.internal:host-gateway` sur le serveur ; si l'inférence échoue
   en DNS, c'est la première piste — et il faudra probablement passer par
   `SANDBOX_ENV_*` ou une adresse routable.

3. **Le nom d'hôte du conteneur pour `OPENHANDS_URL`.** Testé sur le papier
   (le réseau partagé et le `container_name` sont les mêmes mécanismes que
   ceux du compose du daemon, qui fonctionne), pas en vrai.

4. **La forme exacte du `POST /api/v1/settings`** pour déclarer le jeton
   GitLab. Le modèle `POSTProviderModel` accepte bien
   `provider_tokens: {gitlab: {token, host}}`, mais la route accepte un
   `dict[str, Any]` et applique des fusions par section : le payload
   ci-dessus est plausible, il n'est pas confirmé par un aller-retour réel.
   L'équivalent en cliquant dans l'interface, lui, est documenté.

5. **`~/.agents/skills/` dans le conteneur.** Le `HOME` du processus dans
   l'image amont n'est pas documenté — d'où l'absence de montage par défaut.

6. **Les réglages `SANDBOX_*` en V1.** La page qui les documente les rattache
   à la section `[sandbox]` de `config.toml`, qui est l'héritage V0. La
   documentation V1 parle de *sandbox specs* et prévient elle-même que « le
   commutateur de configuration peut encore s'appeler `RUNTIME` pendant la
   migration ». Lesquels de ces réglages ont encore un effet en V1 est à
   vérifier au montage.

7. **L'annulation d'une conversation.** À l'expiration du timeout, le daemon
   cesse d'attendre mais **n'annule rien** : la conversation continue côté
   OpenHands. `DELETE /api/v1/app-conversations/{id}` existe, mais supprimer
   une conversation en cours n'est pas la même chose que l'interrompre
   proprement, et je n'ai pas trouvé de route d'annulation documentée. Le
   compte rendu publié dans la MR le dit explicitement, plutôt que de laisser
   croire à une annulation.

8. ~~**Le chemin web `/conversations/<id>`.**~~ **Levé, et dans l'autre sens
   que prévu.** Je pensais que `conversation_url` renvoyé par le serveur
   faisait autorité et que `/conversations/<id>` n'était qu'un repli. Mesuré
   contre une instance réelle : `conversation_url` vaut
   `http://localhost:<port-éphémère>/api/conversations/<id>` — l'API de
   l'agent-server, pas une page. La route de l'interface est bien
   `/conversations/:conversationId` (`frontend/src/routes.ts`). Le client
   construit donc toujours l'adresse sur `OPENHANDS_URL` et n'utilise plus
   `conversation_url` du tout.

9. **Si une conversation reste lisible une fois son bac à sable en pause.**
   La pause libère le conteneur, et c'est ce qu'on voudrait faire
   automatiquement en fin de tâche. Mais je n'ai pas vérifié si l'historique
   de la conversation reste consultable dans l'interface une fois le bac à
   sable arrêté (les événements sont-ils dans le file store de l'app server,
   ou relus depuis l'agent-server ?). Tant que ce n'est pas tranché, le
   daemon ne met RIEN en pause : perdre l'accès à ce que l'agent a fait
   coûterait plus cher qu'un conteneur qui traîne.

10. **La pérennité de l'application server.** Voir ci-dessous — c'est le point
   le plus important de cette liste.

### Le point qui mérite une décision

Le dépôt `OpenHands/OpenHands` **n'est plus** l'application server : à partir
de `v1.8.0`, c'est **Agent Canvas**, un produit différent (frontend TypeScript,
« developer control center » capable de piloter OpenHands, Claude Code, Codex
ou n'importe quel agent ACP). Le code Python de l'application server — celui
qui sert `/api/v1/app-conversations`, celui dont tout ce chantier dépend — a
été déplacé dans `OpenHands/legacy`, **archivé** (dernier push le 27 juillet
2026).

L'image `docker.openhands.dev/openhands/openhands:1.8` reste celle que la
documentation officielle donne pour l'auto-hébergement, et l'API V1 y est
documentée comme l'API courante. Mais un serveur dont le code source est dans
un dépôt archivé et dont le nom a été repris par un autre produit n'est pas un
socle sur lequel bâtir sans le savoir. Si ce backend doit vivre au-delà d'une
campagne de comparaison, il faut trancher : rester sur cette image épinglée, ou
viser Agent Canvas (qui a sa propre API, non étudiée ici, et un modèle
d'authentification différent — `LOCAL_BACKEND_API_KEY`).

## Pièges rencontrés au montage

**`--env-file .env` n'est pas facultatif.** `env_file:` dans un service ne sert
qu'à passer des variables *au conteneur* ; il n'alimente pas l'interpolation
`${...}` du fichier compose, qui ne lit que le shell et le `.env` du répertoire
du projet — ici `docker/openhands/`, pas la racine. Constaté en le lançant :
`${AGENT_MODEL}` et `${OPENHANDS_API_KEY}` étaient vides et les `:?` ont fait
échouer la commande — mais `${INFERENCE_API_KEY:-local-key}`, qui a un défaut,
serait tombé silencieusement sur `local-key`, pour un 401 d'inférence sans
rapport apparent bien plus tard. D'où la commande lancée depuis la racine avec
`--env-file .env`.

**`AGENT_MODEL` n'est pas interchangeable tel quel.** opencode (sur
`hardening`) accepte n'importe quel nom de fournisseur — il en déclare un
custom sous ce nom ; LiteLLM non. `lmstudio/qwen…` marche sur `hardening` et
échoue ici. `openai/qwen…` marche sur les deux — c'est la valeur à retenir
pour comparer les deux approches sur le même modèle.

**Le réseau doit exister avant.** `cds-agent-net` est déclaré `external` dans
le compose OpenHands. Deux fichiers compose qui déclareraient tous deux le
même réseau nommé se marcheraient dessus.

**`localhost:3000` passe `new URL()`.** Node lit `localhost:` comme un schéma.
`validateOpenHandsUrl` contrôle donc le protocole, pas seulement la réussite de
l'analyse — sans quoi la valeur serait passée pour échouer au premier `fetch`.

**Le bac à sable ne s'arrête pas tout seul.** Après une conversation
terminée, le conteneur `oh-agent-server-<id>` reste `RUNNING` : il n'existe
aucun ramasseur d'inactivité dans l'application server V1. Le seul nettoyage
est `pause_old_sandboxes()`, appelée uniquement au DÉMARRAGE d'un nouveau bac
à sable, qui met en pause les plus anciens au-delà de `max_num_sandboxes`
(`openhands/app_server/sandbox/docker_sandbox_service.py`).

Conséquence directe, constatée en usage réel : **deux mentions du bot sur la
même merge request laissaient deux conteneurs derrière elles**, puis trois,
etc. C'est ce que corrige le registre de conversations décrit ci-dessous.

**`OH_SANDBOX_MAX_NUM_SANDBOXES=1` ne marche pas.** Le code appelle
`pause_old_sandboxes(max_num_sandboxes - 1)`, et cette fonction lève
`ValueError('max_num_sandboxes must be greater than 0')` si son argument est
≤ 0. À 1, plus aucune conversation ne peut démarrer. **2 est le minimum
utilisable** — c'est la valeur posée par le compose, en filet.

**`SESSION_API_KEY` casse l'interface web.** C'est le premier mur rencontré au
montage réel : l'API est bien protégée, mais le frontend open source n'a aucun
moyen d'envoyer la clé, donc chaque action de l'UI répond `401`. Le compose la
laisse vide par défaut, et c'est le binding sur `127.0.0.1` qui tient lieu de
protection. Voir la section « Démarrer l'instance ».

**Le préfixe `/app-conversations` se compose avec `/api/v1`.** Les deux
préfixes viennent de deux routeurs différents côté serveur. Les avoir oubliés
a produit des requêtes vers `/api/v1` tout court ; c'est un test unitaire qui
l'a attrapé, pas une instance.

## Comparabilité avec le banc de mesure

Oui, la même campagne peut tourner sur les deux backends — le protocole tient
sans changement. Mais trois choses ne seront pas comparables, et il vaut mieux
le savoir avant d'interpréter les résultats.

**Ce qui reste identique.** Le déclencheur (`@bot review` sur la MR !5), le
corpus (les onze défauts plantés et documentés), le modèle (à condition
d'écrire `AGENT_MODEL=openai/<modèle>`, valide des deux côtés), le point
d'accès d'inférence, et la mesure elle-même : compter les défauts trouvés
parmi les onze, en lisant ce qui est publié dans la MR. Basculer d'une
approche à l'autre, c'est `git switch hardening` ou `git switch openhands`,
avec le même `.env` et le même `projects.json`.

**Ce qui ne l'est pas.**

1. **Le nombre d'appels au modèle n'est plus contrôlé.** `REVIEW_PASSES`,
   `REVIEW_PASS_MODE` (`independent` / `chained` / `exclusion`), l'arbitre de
   fin de revue : tout ça vit sur `hardening` et n'a aucun pendant ici.
   OpenHands mène sa boucle agentique comme il l'entend, avec un nombre
   d'itérations qu'il décide. Comparer « une passe de `hardening` » à « une
   conversation OpenHands » compare deux quantités de calcul différentes, et
   le résultat mesuré de la campagne du 1er août — que l'union de trois tirages
   indépendants couvrait plus de défauts qu'un seul — dit précisément que ce
   paramètre-là compte beaucoup.

2. **Le filtre de sévérité disparaît.** `MIN_SEVERITY`, sur `hardening`, s'applique aux
   remarques extraites du JSON de l'agent, avant publication. Ici OpenHands
   publie directement : il n'y a plus rien à filtrer. Or la campagne a montré que ce
   filtre portait le signal le plus net (les cinq `error` tous justes, les faux
   positifs tous `info`). Les résultats OpenHands sont donc à comparer au
   `hardening` **non filtré** (`MIN_SEVERITY=info`), pas au réglage par
   défaut.

3. **La granularité du résultat.** `hardening` distingue huit statuts
   (`pushed`, `tests-failing`, `review-flagged`, `tests-broken`, `no-change`…),
   dont deux — `tests-failing` et `review-flagged` — ont été introduits parce
   que la campagne a montré qu'ils n'appartenaient ni aux succès ni aux pannes.
   Cette branche en connaît cinq (`finished`, `waiting`, `stuck`,
   `timeout`, `error`), et `finished` ne dit **pas** si le travail était bon :
   il dit que l'agent s'est arrêté. Sur ce backend, il faut lire la MR pour
   savoir ce qui s'est passé — le statut ne suffit plus.

**Ce que je recommanderais.** Faire tourner la comparaison en revue seulement
(`review: true` sans capacité d'écriture) sur MR !5. C'est là que la mesure est
la plus propre : le résultat est entièrement visible dans les commentaires
publiés, le protocole existant s'applique tel quel, et rien n'est poussé — donc
la perte des garde-fous d'écriture ne fausse rien. Les tâches d'écriture
demanderaient, elles, un protocole différent : sans les tests rejoués côté hôte
ni le contrôle de périmètre, « a livré » ne veut plus dire la même chose des
deux côtés.
