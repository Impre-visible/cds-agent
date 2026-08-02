# ADR 0001 — Polling plutôt que webhook

> **Branche `openhands`** : toujours d'actualité, intégralement. Le polling
> des to-dos et la fenêtre de rattrapage sont exactement ce que cette branche
> conserve — c'est l'aval (l'exécution) qui a été délégué, pas l'amont.

## Statut

Acceptée (comportement en place depuis la première version du POC,
non remise en cause pendant le chantier de durcissement).

## Contexte

Le daemon doit savoir quand quelqu'un mentionne `@bot` dans un commentaire
ou une description GitLab. GitLab propose deux façons d'en être informé :
un webhook (GitLab pousse un événement HTTP vers une URL exposée par le
daemon), ou l'API des to-dos (le daemon interroge périodiquement
`/todos`, qui liste déjà, côté GitLab, les mentions de l'utilisateur du
token — ici le compte bot).

`src/daemon/index.ts` retient la seconde option : `poll()` appelle
`gitlab.pendingTodos()` et `gitlab.doneTodos()` toutes les
`POLL_INTERVAL_MS` (30 s par défaut), et rattrape en plus les to-dos passés
`done` récemment (`LOOKBACK_MINUTES`, 10 min par défaut) — voir
`collectTodos()`.

## Décision

Faire du polling, pas un webhook.

Un webhook GitLab exige un point d'entrée HTTP joignable depuis l'instance
GitLab : une IP publique (ou un tunnel), du TLS, un serveur HTTP dans le
daemon, la gestion d'un secret partagé pour authentifier les requêtes
entrantes. Pour un POC qui tourne en local (`npm run dev` sur le poste d'un
développeur, sans IP publique — voir `docs/deployment.md`), rien de tout
cela n'est disponible sans infrastructure supplémentaire. Le polling ne
demande que ce que le daemon a déjà : un PAT capable d'appeler l'API
GitLab en sortant.

L'API `/todos` a par ailleurs un avantage direct : GitLab y agrège déjà les
mentions, indépendamment du type de ressource (issue, MR) et du type de
mention (commentaire, description) — le daemon n'a pas à interroger chaque
projet ni chaque MR individuellement pour détecter une mention.

## Conséquences

- **Deux appels API par cycle, par instance** (`pendingTodos()` +
  `doneTodos()`), toutes les 30 s par défaut : sur un PAT partagé avec
  d'autres usages, ça consomme un budget de rate-limit en continu, que la
  demande arrive ou non.
- **Latence structurelle** : une mention n'est vue qu'au prochain cycle de
  polling, jusqu'à `POLL_INTERVAL_MS` après coup (30 s par défaut, borné à
  [1 s, 1 h] par `config.ts`). Pas un problème pour un usage asynchrone
  (revue de code, tests), mais à ne jamais présenter comme temps réel.
- **Fenêtre de rattrapage nécessaire, et imparfaite.** Un to-do peut être
  auto-résolu par le bot lui-même (voir le commentaire de `collectTodos()`,
  `src/daemon/todos.ts`) avant que le daemon ait eu l'occasion de le lire
  comme `pending` — d'où le rattrapage des `done` récents. **Corrigé** (ce
  chantier de hardening) : ce filtre s'appuyait à l'origine sur
  `todo.created_at`, alors que l'événement réellement pertinent est le
  moment où le to-do **passe** à `done`. GitLab n'expose pas de `completed_at`
  séparé, mais l'objet to-do porte bien un champ `updated_at` distinct de
  `created_at` (confirmé dans la documentation de l'API GitLab, exemples de
  réponse de `GET /todos`) — mis à jour par GitLab lors du passage
  pending → done comme pour toute autre modification du to-do. Le filtre
  utilise désormais `Date.parse(todo.updated_at) >= cutoff` (voir
  `collectTodos()` dans `todos.ts`, couvert par `todos.test.ts`) ; le tri FIFO
  reste, lui, basé sur `created_at` — c'est l'ordre d'arrivée de la demande
  qui doit gouverner l'ordre de traitement, pas celui, indépendant, de sa
  résolution.
- **Aucune notion de « je n'ai rien manqué »** : contrairement à un webhook
  (qui garantit, sous réserve de disponibilité, la livraison de chaque
  événement), le polling ne fournit qu'une approximation « ce qui existe
  encore côté GitLab au moment où j'interroge, dans telle fenêtre » — voir
  aussi `docs/adr/0004-contrat-fiabilite-file-memoire.md` pour ce que ça
  implique côté fiabilité de bout en bout.

## Alternatives écartées

- **Webhook GitLab** : écarté faute d'infrastructure exposable pour un POC
  local (voir Contexte). Resterait le choix le plus robuste si ce projet
  devait un jour tourner sur une instance GitLab avec une IP joignable et un
  budget d'exploitation pour l'exposition HTTP (TLS, secret partagé,
  surveillance de la disponibilité du endpoint).
- **Webhook en repli sur polling** (les deux en parallèle, polling comme
  filet de sécurité) : plus robuste, mais double la complexité pour un
  bénéfice qui ne se justifie pas tant que le webhook lui-même n'est pas
  déployable.
- **Réduire `POLL_INTERVAL_MS` très bas** pour réduire la latence perçue :
  écarté par construction (borne basse à 1 s dans `config.ts`, avec un
  commentaire explicite sur le risque de bannissement du PAT si on descend
  trop bas) — la latence est un compromis assumé du choix « polling »,
  pas un réglage à optimiser isolément.
