# cds-agent

POC : un daemon qui surveille les to-dos GitLab d'un compte bot, détecte une
mention `@bot` dans un commentaire ou une description, et délègue à un agent
LLM local (via [opencode](https://opencode.ai) + un serveur d'inférence
compatible OpenAI, typiquement LM Studio) soit une revue de merge request,
soit l'écriture de tests sur la branche source de la MR. L'agent tourne dans
un conteneur Docker isolé ; ce que produit une exécution est revérifié côté
hôte avant toute publication ou tout push.

**C'est un POC**, pas un service prêt pour la production : la file de tâches
est en mémoire (perte au redémarrage), un seul daemon traite un seul PAT
GitLab, il n'y a pas de webhook (uniquement du polling), et une grande partie
des protections documentées ici réduisent un risque sans l'éliminer. La
section [Limites connues](#limites-connues) liste ce qui est vraiment
couvert et ce qui ne l'est pas — à lire avant de faire confiance à cet outil
sur un dépôt qui compte.

## Sommaire

- [Fonctionnement](#fonctionnement)
- [Prérequis](#prérequis)
- [Installation](#installation)
- [Configuration](#configuration)
- [Répondre dans un fil](#répondre-dans-un-fil)
- [Capacités de l'agent](#capacités-de-lagent)
- [Lancement](#lancement)
- [Déploiement (docker compose)](#déploiement-docker-compose)
- [Scripts npm](#scripts-npm)
- [Images Docker](#images-docker)
- [Modèle (local ou distant)](#modèle-local-ou-distant)
- [Proxy d'entreprise](#proxy-dentreprise)
- [Journalisation](#journalisation)
- [Observabilité](#observabilité)
- [Garde-fous de sécurité](#garde-fous-de-sécurité)
- [Limites connues](#limites-connues)
- [Tests](#tests)
- [Documentation complémentaire](#documentation-complémentaire)
- [Licence](#licence)

## Fonctionnement

```mermaid
flowchart TD
    A[Polling GitLab toutes les POLL_INTERVAL_MS] --> B{to-do pending ou\ndone récent, non vu}
    B -->|mention @bot valide| C[authorize: projects.json]
    C -->|autorisé, pas déjà traité| D[claimed: réservation dans le store]
    D --> E[file en mémoire, FIFO, 1 worker]
    E --> F[note d'accusé de réception + réaction 👀, to-do marqué done]
    F --> G[worker: construction du contexte MR]
    G --> H{intention}
    H -->|review| I[clone superficiel, prompt + diff numéroté, agent en sandbox]
    I --> J[extraction JSON, validation, publication ligne / fichier / général]
    H -->|implémente les tests| K[clone superficiel, install, tests de référence, agent en sandbox]
    K --> L[contrôle HEAD + .git, garde-fou de chemin, tests rejoués, push si vert]
    L -->|suite rouge sur une assertion juste| N[tests-failing : MR dédiée en Draft, à trancher humainement]
    N --> M
    J --> M[la note d'accusé de réception est éditée : résultat + 👀 → ✅/🔍/❌]
    L --> M
```

Déroulé, dans l'ordre :

1. **Polling** — toutes les `POLL_INTERVAL_MS` (30 s par défaut), le daemon
   récupère les to-dos GitLab `pending` du compte bot, plus les `done`
   récents (fenêtre `LOOKBACK_MINUTES`) pour rattraper un to-do que le bot
   aurait lui-même résolu avant de l'avoir lu.
2. **Détection de la demande** — un to-do n'est retenu que si l'action est
   `mentioned`/`directly_addressed`, la cible une issue ou une MR, et le
   texte (commentaire ou description) contient littéralement `@BOT_USERNAME`.
   Une note système, ou écrite par le bot lui-même, est ignorée.
3. **Autorisation** — un dépôt doit avoir sa propre entrée dans `projects.json`
   (voir [Configuration des projets](#configuration-des-projets)), avec
   l'auteur dans sa liste `users` : *fail-closed* (dépôt absent ou `users`
   vide ⇒ rien n'est autorisé). Un dépôt hors périmètre est refusé
   silencieusement (pas de commentaire, pour ne pas révéler l'existence du
   bot) ; un auteur refusé sur un dépôt présent dans le fichier reçoit une
   réponse explicite.
4. **Réservation** — la demande est enregistrée `claimed` dans un journal
   append-only (`STATE_FILE`) avant toute autre écriture, pour qu'un crash à
   ce stade ne rejoue jamais une demande déjà accusée.
5. **File** — poussée dans une file en mémoire strictement séquentielle (un
   seul worker à la fois, quel que soit le dépôt).
6. **Accusé de réception** — réaction `:eyes:` puis une note citant la
   demande et sa position dans la file ; le to-do est marqué `done` côté
   GitLab à ce stade, avant même que le worker ait commencé. Cette note est
   la seule que le bot postera : elle sera **éditée** en fin de traitement
   (étape 11) plutôt que suivie d'un second commentaire.
7. **Contexte** — le worker récupère la MR, son diff, et le ticket qu'elle
   ferme (derniers commentaires humains inclus).
8. **Intention** — trois chemins, dans cet ordre. Une commande explicite
   placée juste après la mention (`@bot review` ou `@bot implement-tests`)
   l'emporte toujours et ne coûte aucun appel au modèle. À défaut, un repli
   par mots-clés reconnaît « review/revue/relis » ou
   « tests… implémente/écris/ajoute/crée » ; il teste `review` en premier,
   car en cas d'ambiguïté mieux vaut se tromper du côté qui n'écrit rien
   dans le dépôt. Si l'intention reste indéterminée — « @bot fais une MR »,
   par exemple — un **planificateur** est appelé : un premier passage du
   modèle qui reçoit une charte décrivant ce que ce dépôt autorise, lit la
   demande et le contexte, et rend un plan structuré (intention, prompt
   destiné à l'agent exécutant, capacités réclamées). S'il échoue, dépasse
   son budget (`PLANNER_TIMEOUT_MINUTES`) ou rend un plan hors schéma, la
   demande est refusée avec le message d'aide — jamais un retour au repli
   par mots-clés, qui rejouerait la fragilité que le planificateur corrige.

   La charte est **générée** à partir de `projects.json`, jamais écrite en
   parallèle : ce qu'on annonce au modèle ne peut donc pas diverger de ce
   que le daemon applique. Et le plan **n'accorde rien** — l'intention et
   chaque capacité réclamée sont vérifiées contre `projects.json`
   (`mergeRequest.review`, `mergeRequest.writeTests`, `writeBusinessCode`),
   jamais contre le texte du plan. Un ticket qui prétendrait élargir les
   droits du bot peut influencer ce que le modèle écrit ; il ne peut pas
   changer ce contre quoi la vérification est faite. Une capacité non
   accordée est refusée avec un message qui la nomme, avant tout clone.
9. **Exécution en sandbox** — clone superficiel du dépôt, prompt construit
   avec délimiteurs explicites autour de tout texte non fiable (demande,
   ticket, diff), agent lancé dans un conteneur Docker durci (réseau limité à
   un proxy d'inférence local, système de fichiers en lecture seule sauf
   `/repo` et un tmpfs borné, capacités Linux réduites).
10. **Contrôle et publication** — pour une review : extraction et validation
    stricte du JSON produit, publication idempotente (une remarque déjà
    postée n'est jamais republiée) avec repli ligne → fichier → commentaire
    général. Pour une implémentation de tests : vérification que le
    daemon reste seul committeur (`checkHeadIntegrity`), que seuls des
    chemins autorisés ont été touchés (`tasks/guard.ts` — tests uniquement
    par défaut, élargissable dépôt par dépôt via `projects.json`, voir
    [Capacités de l'agent](#capacités-de-lagent)), que la suite est verte, et
    que la branche n'est pas protégée — alors seulement, push direct sur la
    branche source (défaut) ou ouverture d'une merge request dédiée du bot
    (`pushToSourceBranch: false`).
11. **Rapport** — la note d'accusé de réception (étape 6) est éditée pour
    porter le résultat, et sa réaction passe de 👀 à l'une de **trois**
    issues : ✅ livré (suite verte), 🔍 rien n'est livré mais il y a une
    décision humaine à prendre (`tests-failing` — voir
    [Garde-fous](#garde-fous-de-sécurité)), ❌ échec réel (installation
    cassée, suite déjà rouge, refus). Trois et non deux délibérément : ranger
    `tests-failing` avec ✅ le confondrait avec un run livré, le ranger avec ❌
    avec une panne — c'est le seul cas où le bot a peut-être trouvé un défaut.
    Le demandeur est toujours informé, y compris en cas d'échec. Si l'édition
    échoue — note supprimée entre-temps — le résultat est publié dans une note
    neuve plutôt que perdu.

Le seul flux réellement câblé aujourd'hui est celui des **merge requests** :
`src/tasks/router.ts` répond poliment sur toute autre cible (« Seules les
merge requests sont gérées pour l'instant »).

## Prérequis

- **Node.js 26** (le projet exécute directement les `.ts` via le
  type-stripping natif de Node, sans étape de build — `node --test
  'tests/**/*.test.ts'` et `tsx` en dépendent). Testé avec Node 26.3.0.
- **Docker** en état de marche, avec un utilisateur autorisé à lancer
  `docker run` — la sandbox est activée par défaut (voir
  [Configuration](#configuration)).
- **Un serveur d'inférence compatible OpenAI** joignable depuis l'hôte
  (LM Studio en pratique ; voir [Modèle (local ou distant)](#modèle-local-ou-distant)).
- **`opencode`** : pas requis sur l'hôte pour l'usage normal (il est installé
  *dans* l'image `docker/agent.Dockerfile`) ; requis en revanche si vous
  utilisez `ALLOW_UNSANDBOXED=1` (exécution hors Docker), qui appelle le
  binaire `opencode` directement sur l'hôte (`src/agent/runner.ts`).
- **Un compte GitLab bot** avec un token d'accès personnel (PAT), et le nom
  d'utilisateur de ce compte.

## Installation

```bash
git clone <ce dépôt>
cd cds-agent
npm install
cp .env.example .env
# éditer .env : au minimum GITLAB_URL, GITLAB_TOKEN, BOT_USERNAME
cp projects.example.json projects.json
# éditer projects.json : au moins un dépôt sous "projects", avec sa liste
# "users" — un dépôt absent de ce fichier est refusé (voir Configuration
# des projets ci-dessous)
```

`npm install` n'installe que les `devDependencies` du projet lui-même
(`typescript`, `tsx`, `@types/node`) : le daemon n'a aucune dépendance de
production, tout est écrit avec les modules natifs de Node.

## Configuration

Toutes les variables sont documentées, une par une, dans
[`.env.example`](./.env.example) — nom exact, valeur par défaut, bornes de
validation, comportement si absente. `src/config.ts` charge `.env` lui-même
(mini-parseur maison, sans dépendance) puis valide chaque variable au
démarrage : une valeur hors bornes ou mal formée fait échouer le daemon
immédiatement, avec un message qui nomme la variable fautive plutôt que de
laisser une valeur absurde se propager silencieusement (timeout à 0,
`AGENT_MODEL` sans `/`, etc.).

Quelques variables méritent une lecture attentive avant de démarrer :

- **`ALLOW_UNSANDBOXED`** — coupe-circuit vers l'exécution hôte (pas de
  Docker) : *à réserver au développement local*. L'agent (du code
  potentiellement écrit par le LLM) tourne alors directement avec le profil
  de connexion de l'utilisateur qui lance le daemon. `USE_DOCKER=0` **ne
  suffit plus, à lui seul**, à désactiver la sandbox depuis le durcissement
  de ce projet : le voir seul dans `.env` fait échouer le démarrage avec un
  message explicite, précisément pour éviter qu'un réglage hérité d'avant ce
  changement ne redésactive silencieusement la sandbox. Il faut soit ajouter
  `ALLOW_UNSANDBOXED=1` en toute connaissance de cause, soit retirer
  `USE_DOCKER=0`.
- **`SANITIZED_ENV_EXTRA_KEYS`** — les processus enfants non fiables (git,
  l'agent, `bash -lc` en mode non sandboxé) ne reçoivent qu'un environnement
  expurgé (liste blanche : `PATH`, `HOME`, locale, `TMPDIR`, proxies HTTP —
  voir `sanitizedEnv()` dans `src/config.ts`). Si un dépôt cible a besoin
  d'une variable de plus (un proxy interne sous un nom maison, par exemple),
  cette variable l'ajoute à la liste blanche — jamais l'inverse, il n'y a pas
  de mécanisme pour retirer une clé de base.
- **`PROJECTS_FILE`** — chemin du fichier de configuration par projet
  (défaut : `./projects.json`), qui remplace `ALLOWED_PROJECTS`,
  `ALLOWED_USERS`, `AGENT_CAPABILITIES`, `DOCKER_IMAGES`, `TEST_COMMANDS`,
  `INSTALL_COMMANDS` et `TEST_DIRECTORY_OVERRIDES` — toutes des variables
  d'environnement avant ce chantier, aujourd'hui refusées bruyamment au
  démarrage si l'une d'elles traîne encore dans `.env` (message qui dit où
  le réglage a migré). Voir [Capacités de l'agent](#capacités-de-lagent)
  ci-dessous, qui documente désormais l'intégralité de ce fichier — dépôts
  et auteurs autorisés, capacités, commandes, image Docker, répertoires de
  test.
- **`CLONE_DEPTH`** — clone superficiel par défaut (20 commits) pour éviter
  de recloner tout l'historique d'un dépôt d'entreprise à chaque review ou
  implémentation. `0` désactive la limite (clone complet). Une valeur faible
  n'est pas dangereuse pour le contrôle de sécurité HEAD : `implement.ts`
  approfondit à la demande (`git fetch --unshallow`) si `merge-base` échoue
  faute d'ancêtre commun connu localement.
- **`INSTALL_IGNORE_SCRIPTS`** — à `1` par défaut (implicite : toute valeur
  différente de `"0"`) : l'installation du dépôt cible tourne avec
  `--ignore-scripts`, pour qu'un `postinstall` hostile ne s'exécute pas avec
  un accès réseau complet avant que quoi que ce soit n'ait été vérifié.
  `INSTALL_IGNORE_SCRIPTS=0` revient au comportement historique — nécessaire
  pour certains dépôts qui ne s'installent pas correctement sans leurs
  scripts (binaires natifs, génération de fichiers).
- **`GITLAB_REQUEST_TIMEOUT_MS`** — timeout HTTP appliqué à *toute* requête
  GitLab, écritures comprises (20 s par défaut) : sans lui, une instance
  GitLab qui pend bloquerait le worker indéfiniment. Les requêtes GET/HEAD
  bénéficient en plus d'un réessai automatique avec backoff exponentiel à
  jitter (`GITLAB_MAX_RETRIES`, `GITLAB_RETRY_BASE_MS`,
  `GITLAB_RETRY_MAX_DELAY_MS`) sur 429/5xx/erreur réseau ; jamais les
  écritures (POST), pour ne jamais risquer de publier deux fois le même
  commentaire à cause d'un simple timeout réseau.
- **`DOCKER_PIDS_LIMIT`** / **`DOCKER_ULIMIT_NOFILE`** / **`DOCKER_TMPFS_SIZE`**
  (§5.8) — mêmes réglages de ressources sandbox que `DOCKER_MEMORY`/
  `DOCKER_CPUS`, jusqu'ici en dur dans `agent/sandbox.ts` : un dépôt cible
  dont l'installation ou la suite de tests lance beaucoup de processus en
  parallèle, ou produit beaucoup de fichiers temporaires, peut légitimement
  avoir besoin de plus que les défauts (512 processus, 4096:8192
  descripteurs, 1 Go de `/tmp`).

- **`REVIEW_BUDGET`** / **`MIN_SEVERITY`** / **`MAX_REMARKS`** — trois rôles
  distincts, là où une seule variable les tenait tous. `REVIEW_BUDGET` (12) est
  ce qu'on **demande** au modèle dans le prompt ; `MIN_SEVERITY` (`warning`)
  **sélectionne** ce qui est publié, par nature du défaut ; `MAX_REMARKS` (15)
  n'est plus qu'une **borne de volume** contre un emballement. Mesuré sur la
  MR !5 : à `MAX_REMARKS=5`, le plafond coupait deux défauts réels et
  difficiles et publiait un faux positif `info` en tête — alors que les cinq
  `error` du run étaient tous justes et les trois faux positifs identifiables
  tous des `info`. Le signal porte sur la **nature**, pas sur le nombre. Ce que
  `MIN_SEVERITY` écarte n'est jamais perdu : `npm run review` l'affiche dans
  une section à part et le daemon le journalise.
- **`REVIEW_ARBITER`** — passe d'arbitrage finale (voir `src/tasks/arbiter.ts`),
  après l'agrégation et avant la publication : un dernier passage du modèle, en
  lecture seule, qui **ouvre les fichiers cités** pour écarter les remarques que
  le code contredit. Le tri par sévérité ne peut pas faire ça — il classe des
  remarques prises isolément. L'arbitre **sélectionne, ordonne et reclasse ; il
  ne reformule jamais** : son verdict ne porte que sur des numéros, le texte
  publié reste mot pour mot celui de la passe qui l'a trouvé. Sans effet à
  `REVIEW_PASSES=1`. Un échec de sa part n'enlève rien : la revue publie ce
  qu'elle aurait publié sans lui.
- **`REVIEW_PASSES`** / **`REVIEW_PASS_MODE`** / **`REVIEW_VOTE`** — banc
  d'essai des passes multiples, désactivé par défaut (`REVIEW_PASSES=1`
  reproduit le comportement d'avant, au caractère près dans le prompt). Le
  mode ne change que le prompt des passes ≥ 2 : `independent` (défaut, chaque
  passe ignore les précédentes), `chained` (les remarques précédentes sont un
  contexte à confirmer ou approfondir), `exclusion` (elles sont une liste de
  ce qui est déjà couvert, avec consigne de chercher ailleurs). Voir
  [Comparer les stratégies de passes](#comparer-les-stratégies-de-passes)
  ci-dessous pour le protocole et la lecture des logs.
- **`HEALTH_ENABLED`** / **`HEALTH_PORT`** / **`HEALTH_HOST`** (§6.5) —
  serveur HTTP minimal d'observabilité (`/healthz`, `/metrics`, voir
  `src/daemon/health.ts`). Activé par défaut sur `127.0.0.1:8090` ;
  `HEALTH_ENABLED=0` le désactive complètement (aucun port n'est alors
  ouvert). Voir la section [Observabilité](#observabilité) ci-dessous.
- **`CONTAINER_HTTP_PROXY`** / **`CONTAINER_HTTPS_PROXY`** /
  **`CONTAINER_NO_PROXY`** — échappatoires explicites pour le proxy
  transmis au conteneur d'installation/tests du dépôt cible (voir
  [Proxy d'entreprise](#proxy-dentreprise) ci-dessous) : absentes par défaut,
  auquel cas `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` de l'hôte sont repris
  automatiquement, avec réécriture vers `host.docker.internal` si le proxy
  écoute sur le loopback de l'hôte.
- **`LOG_LEVEL`** / **`LOG_PRETTY`** (§6.4) — ne passent pas par
  `buildConfig()` (lus directement par `src/log.ts`, à chaque appel, pour
  qu'un test puisse les faire varier sans réimporter le module) : niveau
  minimal des lignes émises (`debug`/`info`/`warn`/`error`, défaut `info`) et
  bascule vers une sortie condensée lisible en développement
  (`LOG_PRETTY=1`) au lieu du JSON par ligne par défaut.
- **`HTTP_PROXY`** / **`HTTPS_PROXY`** / **`NO_PROXY`** (variantes
  minuscules aussi reconnues) — ne passent pas non plus par `buildConfig()`
  (lues à chaque requête par `src/gitlab/proxy-fetch.ts` et
  `src/config.ts::containerProxyEnv()`, comme `LOG_LEVEL`/`LOG_PRETTY`
  ci-dessus) : voir [Proxy d'entreprise](#proxy-dentreprise) ci-dessous,
  section à part entière vu l'ampleur du sujet.

Le fichier réel `.env` de ce dépôt (non versionné, voir `.gitignore`) ne
renseigne aujourd'hui qu'une poignée de ces variables — tout le reste
tourne sur les valeurs par défaut de `src/config.ts`. `.env.example` liste
les cinquante-trois variables lues par `buildConfig()`, plus `LOG_LEVEL`/
`LOG_PRETTY`/`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` lues indépendamment.

### Comparer les stratégies de passes

Une passe de revue unique laisse passer des défauts qu'une autre passe, même
prompt, aurait trouvés. Mesuré sur la MR !2 : trois tirages **indépendants**
de `qwen3.6-35b-a3b` ont rendu 3, 4 puis 4 défauts sur 5 — mais des ensembles
**différents**, dont l'union couvrait 4/5. Aucune passe seule n'a dépassé 4.

Trois façons de construire le prompt des passes ≥ 2 sont disponibles. Le banc
d'essai a tourné le 1er août 2026 (3 revues à 3 passes sur la MR !5,
`qwen3.6-35b-a3b`, `REVIEW_VOTE=0`) :

| mode | nouvelles par passe | distinctes | doublons | durée |
|---|---|---|---|---|
| `independent` | 6 + 3 + 1 | 10 | 7 | 120 s |
| `chained` | 5 + 1 + 1 | 7 | 10 | 150 s |
| **`exclusion`** | **6 + 5 + 4** | **15** | **3** | 151 s |

`exclusion` gagne sur la métrique centrale — 4 remarques nouvelles en passe 3,
contre 1 pour les deux autres. Le risque redouté a été mesuré, mais sur
`chained` : sa passe 3 a répondu « les 6 remarques précédentes sont
confirmées, aucun nouveau défaut » — l'ancrage exact qu'on craignait (déjà
observé ailleurs : `qwen3.5-397b` a lu le dépôt, constaté que les tests
demandés existaient, et rendu `no-change`). Le défaut du dépôt reste
`independent`, le plus conservateur ; `exclusion` est le réglage retenu pour
une recherche exhaustive.

```bash
for mode in independent chained exclusion; do
  REVIEW_PASSES=3 REVIEW_PASS_MODE=$mode REVIEW_VOTE=0 REVIEW_BUDGET=12 \
  LOG_PRETTY=1 AGENT_MODEL=scaleway/qwen3.6-35b-a3b \
  npm run review -- 5 2>&1 | tee "revue-$mode.log"
done
```

`REVIEW_VOTE=0` n'est pas décoratif : `chained` et `exclusion` **forcent**
l'union (ils demandent à la passe N de ne pas répéter les précédentes, donc
aucune remarque n'y obtient deux voix et un vote majoritaire y publierait zéro
remarque). Sans ce `REVIEW_VOTE=0`, le bras `independent` serait le seul à
voter et la comparaison mélangerait deux variables.

Chaque passe émet une ligne, puis la revue en émet une récapitulative :

```
[revue] passe 2/3 (mode=exclusion)
[revue] aucun JSON dans la sortie — 7 remarque(s) reconstruite(s) depuis la prose
        par l'extracteur de secours
[revue] passe 2/3 : 6 remarque(s) (2 nouvelle(s), 4 doublon(s)), 15 s, canal=secours
[revue] canaux : 2 × json-stdout, 1 × secours — 1 passe(s) récupérée(s) par
        l'extracteur de secours, perdue(s) avant ce correctif
[revue] 3 passe(s) (mode=exclusion, agrégation=union) : 6 + 5 + 4 remarque(s)
        nouvelle(s), 3 doublon(s), 151 s → 15 distincte(s), 15 retenue(s), 10 publiée(s)
[revue] arbitre appliqué : 3 remarque(s) écartée(s), 1 reclassée(s) sur 15 arbitrée(s)
[revue] non publiées : 5 sous le seuil de sévérité (MIN_SEVERITY=warning),
        0 au-delà du plafond (MAX_REMARKS=15)
```

- **`canal=`** / **`canaux :`** — par où les remarques ont été lues :
  `fichier` (l'agent a écrit `.cds-review.json` — jamais en revue sandboxée),
  `json-stdout` (le cas normal), `secours` (aucun JSON, remarques reconstruites
  depuis la prose par `salvageRemarks`). Une passe `secours` est une passe qui
  **aurait été perdue** : mesuré le 1er août 2026, 4 passes sur 9 finissaient
  en « aucun JSON exploitable » alors que le modèle avait produit sept
  remarques correctes en markdown. La ligne `canaux :` compte ces
  récupérations pour que leur fréquence se mesure au lieu de se subir.
- **`N nouvelle(s)`** — remarques dont la clé `fichier:ligne` n'était apparue
  dans **aucune** passe précédente. C'est la métrique centrale : si la passe 3
  n'apporte jamais rien, le protocole est à deux passes, pas trois.
- **`N doublon(s)`** — remarques déjà vues dans une passe antérieure. Élevé en
  `chained` (attendu, le mode invite à confirmer), il indique en `exclusion`
  que la consigne n'a pas été suivie.
- **`N distincte(s)`** — l'union des clés sur toutes les passes ; **`retenue(s)`**
  ce qui survit à l'agrégation (identique à `distincte` sous union, inférieur
  sous vote) ; **`publiée(s)`** ce qui atteint réellement la MR.
- La ligne **`non publiées :`** n'apparaît que si quelque chose a été écarté,
  et sépare les **deux causes** parce qu'elles n'appellent pas la même
  réaction : `sous le seuil de sévérité` est un choix de politique (abaisser
  `MIN_SEVERITY` pour les voir), `au-delà du plafond` est un symptôme — des
  remarques recevables ont été coupées pour une raison de volume, ce qui ne
  devrait pratiquement jamais arriver aux valeurs par défaut.
- **`arbitre appliqué :`** — l'arbitre a rendu un verdict exploitable. C'est la
  seule ligne qui le prouve. En cas d'échec, deux lignes apparaissent à la
  place : un `WARN [revue] arbitre en échec (<cause>)` puis un `INFO [revue]
  arbitre non appliqué — repli sur le tri par sévérité`. Une revue sans aucune
  des trois lignes signifie que l'arbitre n'a jamais été sollicité
  (`REVIEW_PASSES=1` ou `REVIEW_ARBITER=0`).
- Un **`WARN` « AUCUNE remarque publiable »** signale une revue vide alors que
  le modèle a bien trouvé quelque chose (tout est passé sous le seuil). Une
  revue vide parce que le code est sain et une revue vide parce que tout a été
  filtré ne doivent jamais se ressembler.

`npm run review` (`src/tools/dry-review.ts`) affiche les remarques publiées,
puis **deux sections séparées** : celles écartées par le seuil de sévérité et
celles écartées par le plafond. Compter les défauts trouvés à travers ces
filtres reviendrait à mesurer les filtres, pas le modèle. Le suffixe **`×N`**
sur une remarque indique le nombre de passes qui l'ont signalée — sous `union`
plus rien ne *filtre* sur la corroboration, mais elle reste le meilleur signal
de certitude disponible, et l'afficher est ce qui évite de la perdre.

Ce qui se compare d'un mode à l'autre : le nombre de **défauts distincts
réellement trouvés** (à recouper à la main avec le jeu de bugs, sur la liste
complète — publiées *et* coupées) et le nombre de **faux positifs** — pas le
nombre brut de remarques, qu'un mode bavard gonfle sans rien apporter.

Une réserve de méthode, la même que pour les autres campagnes de ce projet :
un run par mode est un tirage unique, et le non-déterminisme mesuré ici est
précisément ce que ces passes cherchent à corriger. Trois runs par mode
donnent une comparaison ; un seul donne une anecdote.

## Répondre dans un fil

Chaque remarque de revue est publiée en tant que **fil** sur la ligne
concernée. On peut y répondre pour demander des précisions :

```
cds-agent  src/todoStore.js:28
  warning — `needle` n'est pas passé en minuscules avant la comparaison.

  romeo
    @mon-bot j'ai pas compris, tu peux m'expliquer plus en détail ?

  cds-agent
    `needle` reçoit `q` tel quel, alors que `todo.title` est mis en
    minuscules ligne 31. Chercher « PAIN » ne trouve donc pas « Acheter du
    pain ». Le correctif tient en un `.toLowerCase()` ligne 28.
```

Le modèle reçoit **le fil entier** (pas seulement la dernière question — « j'ai
pas compris » ne veut rien dire sans ce qu'il commente), le fichier et la ligne
visés, et le dépôt cloné pour aller lire ce qu'il lui faut. Il tourne en
**lecture seule** : le seul effet possible est une réponse ajoutée au fil.

La consigne l'autorise explicitement à **contredire la remarque d'origine** :
sur une campagne mesurée, trois faux positifs sur trois étaient vérifiables en
ouvrant le fichier cité. Une explication qui justifie une remarque fausse est
pire qu'une absence de réponse.

La réponse arrive **dans le fil**, et rien n'est ajouté au niveau de la merge
request : l'accusé de réception est supprimé une fois la réponse publiée. Ce
qui reste comme signal de fin de traitement, c'est la **réaction** (✅ / ❌)
posée sur votre propre message — elle ne crée aucune note. Sur une MR relue
plusieurs fois, c'est ce qui évite de noyer la conversation sous des accusés.

Trois points à connaître :

- **Il faut mentionner le bot.** Le daemon est piloté par les to-dos GitLab
  (voir [`docs/adr/0001`](./docs/adr/0001-polling-plutot-que-webhook.md)), et
  GitLab n'en crée que sur mention ou interpellation directe — jamais sur
  « quelqu'un a répondu dans un fil ». S'en affranchir demanderait de sonder
  périodiquement les discussions de chaque MR déjà touchée, soit un modèle de
  polling entièrement différent.
- **Une commande explicite l'emporte toujours.** `@bot review` écrit dans un
  fil demande une revue, pas une explication : le contexte ne détourne jamais
  une intention dite en toutes lettres.
- **Le fil doit contenir au moins une note du bot.** Un fil entre humains, même
  s'il pose une question, n'est pas une relance. Peu importe en revanche qui a
  ouvert le fil.

Capacité requise : `review` sur le type de cible — répondre à une question sur
une remarque est la même nature d'acte que produire cette remarque.

## Capacités de l'agent

Chantier "projects.json" : la configuration par projet — dépôts et auteurs
autorisés, capacités de l'agent, commandes d'installation/de test, image
Docker, répertoires de test maison — a quitté les variables d'environnement
pour un fichier JSON : `projects.json` (chemin configurable via
`PROJECTS_FILE`, voir [Configuration](#configuration)).
`projects.example.json` en donne un modèle complet ; **le fichier ne contient
jamais de secret** — le token GitLab reste exclusivement dans
l'environnement (`GITLAB_TOKEN`).

`projects.json` est **gitignoré**, comme `.env` : il ne porte pas de secret,
mais il nomme des dépôts internes et des utilisateurs, qu'on ne souhaite pas
voir entrer dans l'historique git. Conséquence assumée : un changement de
permissions ne laisse aucune trace révisable, et deux machines peuvent
diverger sans que rien ne le signale — c'est à l'exploitant de tenir ce
fichier à jour là où le daemon tourne.

```json
{
  "defaults": {
    "capabilities": {
      "issue":        { "review": false, "createMergeRequest": false,
                        "writeTests": false, "writeBusinessCode": false },
      "mergeRequest": { "review": true,  "writeTests": false,
                        "writeBusinessCode": false, "pushToSourceBranch": false }
    },
    "commands": { "install": "npm install", "test": "npm test" },
    "docker":   { "image": "node:22-bookworm-slim" }
  },
  "projects": {
    "groupe/depot-a": {
      "users": ["alice", "bob"],
      "capabilities": {
        "issue":        { "createMergeRequest": true, "writeBusinessCode": true,
                          "writeTests": true },
        "mergeRequest": { "review": true, "writeTests": true }
      },
      "commands": { "test": "pytest -q" },
      "docker":   { "image": "python:3.12-slim" },
      "testDirectories": ["e2e", "acceptance"]
    },
    "groupe/depot-c": {
      "users": ["alice"],
      "capabilities": {
        "mergeRequest": {
          "review": true, "writeTests": true,
          "writablePaths": ["src/generated/**", "docs/*.md"]
        }
      }
    }
  }
}
```

**Résolution** (`src/projects.ts::resolveProject`) — `projects.<chemin>`
surcharge `defaults`, **champ par champ** (fusion en profondeur sur les
capacités : un projet qui ne redéclare que `mergeRequest.writeTests` garde
le `mergeRequest.review`/`pushToSourceBranch` de `defaults`, pas un
`false` implicite) ; `defaults` lui-même surcharge, champ par champ, un
socle interne "tout refusé" pour les capacités, et `INSTALL_COMMAND`/
`TEST_COMMAND`/`DOCKER_DEFAULT_IMAGE` (variables d'environnement globales,
elles, inchangées) pour les commandes et l'image. Un dépôt **absent** de
`"projects"` est refusé — silencieusement, comme l'ancien `ALLOWED_PROJECTS`
vide ; un auteur absent de `"users"` reçoit une réponse explicite, comme
l'ancien `ALLOWED_USERS`.

**Capacités** (`issue`/`mergeRequest`, chacune avec les mêmes noms de champ
que dans l'exemple ci-dessus) :

- **`review`** — la revue est-elle permise sur ce type de cible ?
- **`writeTests`** — l'agent peut écrire des tests (chemins reconnus par
  `src/tasks/guard.ts::isTestPath`, plus `testDirectories`).
- **`writeBusinessCode`** — l'agent peut modifier tout le dépôt, code source
  compris (implique `writeTests`).
- **`writablePaths`** (`mergeRequest` uniquement) — motifs glob (`**`/`*`
  seulement, voir `src/tasks/guard.ts::globToRegExp`) élargissant
  *précisément* l'accès en écriture à un sous-ensemble du dépôt, en plus des
  chemins de test : l'entre-deux entre `writeTests` seul (tests uniquement)
  et `writeBusinessCode` (dépôt entier) que l'ancien `AGENT_CAPABILITIES`
  exprimait via `write:src/**|lib/**` et que la migration vers ce fichier
  avait perdu. Absent ou vide : comportement inchangé. Trois façons de dire
  "quels chemins sont modifiables" ne s'empilent pas sans règle — combinaison
  invalide, rejetée **au démarrage** en nommant le dépôt fautif :
  - `writeBusinessCode: true` accorde déjà tout le dépôt ; des motifs non
    vides à côté n'auraient aucun effet observable.
  - un motif élargit *toujours* aussi l'accès aux chemins de test (voir
    `isWritablePath`, qui vérifie `isTestPath` avant les motifs, quel que
    soit leur contenu) ; `writeTests: false` à côté de motifs non vides
    serait donc trompeur. `writeTests: true` est obligatoire dès qu'un motif
    est déclaré.

  Un motif mal formé (absolu, composant `.`/`..`, ou caractère hors du
  sous-ensemble glob supporté) échoue lui aussi au démarrage en le citant.
- **`pushToSourceBranch`** (`mergeRequest` uniquement) — `true` : push direct
  sur la branche source une fois tous les contrôles passés (comportement
  historique). `false` (défaut du bloc `defaults` ci-dessus) : le bot pousse
  sur une branche `cds-agent/...` dédiée et ouvre une merge request qui
  cible la branche source, à faire relire par un humain avant fusion — c'est
  cette option qui rend acceptable d'accorder `writeBusinessCode`.
- **`issue.createMergeRequest`** — anticipée dans le schéma pour une future
  prise en charge des issues, non câblée à ce jour : `src/tasks/router.ts`
  refuse encore toute cible qui n'est pas une merge request avant même de
  regarder une capacité (voir [Limites connues](#limites-connues)).

Une intention détectée (`review`/`implement-tests`) dont la capacité
correspondante n'est pas accordée POUR LE TYPE DE CIBLE de la demande est
refusée avant même de cloner le dépôt, avec un message qui le dit
(`src/tasks/router.ts::intentRefusalReason`). Une clé de capacité inconnue
ou mal orthographiée (`"writeTest"` au lieu de `"writeTests"`, par exemple),
à n'importe quel niveau du fichier, fait échouer le **démarrage** du daemon
en la nommant — jamais un `false` silencieux : c'est toute la différence
entre « j'ai désactivé » et « j'ai fait une faute de frappe ». Un seul point
du code répond à « l'agent avait-il le droit de modifier ce chemin ? » :
`src/tasks/guard.ts::isWritablePath` (alimenté par
`src/projects.ts::repoCapabilitiesFor`), utilisé à la fois par le garde-fou
de chemin (`collectChanges`) et par le prompt de l'agent (`implement.ts::
buildPrompt`).

**Ce qui reste inconditionnel, quelle que soit la capacité accordée** — une
capacité élargit ce que l'agent a le droit de *produire*, jamais ce que le
daemon accepte de ne pas *vérifier* :

- `fingerprintGitMeta` / `checkHeadIntegrity` : le daemon reste seul
  committeur légitime, quelle que soit l'étendue des chemins modifiables.
- Le rejet des chemins contenant un composant `.` ou `..` (tentative de
  contournement du garde-fou par un chemin qui, une fois résolu, ne pointe
  plus vers l'endroit qu'il prétend).
- Le refus de pousser sur une branche protégée, quand `pushToSourceBranch`
  vaut `true`. Sinon (branche dédiée), ce contrôle ne s'applique pas à la
  branche neuve créée par le bot (elle ne peut, par construction, pas être
  déjà protégée) : le risque qu'il couvre — écraser une branche protégée
  existante — ne se pose structurellement pas dans ce mode.
- **Aucune capacité de fusion (`merge`)** : le bot ne dispose d'aucun moyen
  de fusionner une merge request, à aucun niveau de configuration —
  `src/gitlab/client.ts` n'expose aucun appel à l'API GitLab de fusion, et
  aucun appelant n'en fabrique un. La garantie n'est pas un booléen qu'on
  pourrait mettre à `false` par erreur : c'est l'absence pure et simple de
  ce chemin de code.

Quand les capacités effectivement accordées à une demande dépassent le
défaut (`src/tasks/guard.ts::DEFAULT_CAPABILITIES`, tests uniquement / push
direct), le rapport posté sur GitLab le mentionne explicitement (`🔓
Capacités élargies pour ce dépôt : ...`) : quelqu'un qui relit la MR sait que
l'agent avait le droit de toucher au code source, pas seulement le déduire
en constatant qu'un fichier source a changé.

**Rechargement à chaud** : `projects.json` est relu à chaque cycle de
polling, juste avant la lecture des to-dos — mais seulement si son contenu a
changé (empreinte, pas seulement l'horodatage). Les capacités applicables à
une demande sont figées au tout début de son traitement
(`daemon/index.ts::handle()`) : une tâche déjà en file ou en cours d'exécution
ne voit jamais sa configuration changer sous ses pieds, même si le fichier
est modifié entre-temps. Un fichier devenu invalide en cours de route
**ne fait pas tomber le daemon** : l'erreur est journalisée bruyamment et la
dernière configuration valide reste en vigueur — à la différence du
démarrage, où l'absence de configuration valide est fatale (voir
`src/projects.ts::ProjectsRegistry`).

**Non implémenté, place réservée** : une capacité "appliquer le résultat dans
un clone frais isolé plutôt que dans le clone manipulé par l'agent" (défense
en profondeur supplémentaire contre un clone dont l'agent aurait pu altérer
autre chose que ce qui est vérifié) est anticipée dans la forme du modèle
(`RepoCapabilities` dans `src/tasks/guard.ts`) mais n'a pas de champ dans le
schéma `projects.json` aujourd'hui — une tentative de l'utiliser (une clé
inconnue) échoue donc bruyamment plutôt que d'être silencieusement ignorée.
Écartée pour l'instant : les vecteurs identifiés sont déjà couverts par les
contrôles inconditionnels ci-dessus (hooks git, empreinte de `.git`,
`checkHeadIntegrity`), et un second clone ajouterait une classe de cas
tordus (patchs qui ne s'appliquent pas, binaires, renommages) pour un gain
marginal — voir
`docs/adr/0006-frontiere-confiance-patch-vs-clone.md`. Voir aussi
`docs/adr/0005-capacites-agent-par-depot.md` pour le modèle d'origine (dont
`projects.json` reprend la substance en changeant la source de
configuration).

## Lancement

```bash
npm run dev
```

Démarre le daemon (`src/daemon/index.ts` via `tsx`, sans étape de build). Au
démarrage : pose d'un verrou d'instance (`state/daemon.lock` par défaut, à
côté de `STATE_FILE`), vérification que le PAT appartient bien à
`BOT_USERNAME`, amorçage silencieux si l'état est vierge (tout ce qui existe
déjà côté GitLab est marqué vu sans notification, pour ne pas déverser des
mois de to-dos historiques au premier lancement), puis boucle de polling.

`Ctrl-C` (SIGINT) ou `SIGTERM` déclenchent un arrêt gracieux : la file cesse
d'accepter de nouvelles tâches, jusqu'à 30 s sont laissées à la tâche en
cours pour se terminer, puis le daemon sort. Un second signal force la
sortie immédiate (les conteneurs Docker déjà lancés ne sont alors pas
attendus).

## Déploiement (docker compose)

Pour faire tourner le daemon en service plutôt que dans un terminal ouvert :

```bash
# 1. .env et projects.json renseignés (voir Configuration ci-dessus), plus :
#    CDS_WORK_DIR=<chemin ABSOLU d'un répertoire de travail sur l'hôte>
mkdir -p "$CDS_WORK_DIR"

# 2. build + lancement, redémarrage automatique compris
docker compose up -d --build

docker compose logs -f          # suivre
curl -s localhost:8090/healthz  # vérifier
docker compose down             # arrêter
```

`restart: unless-stopped` couvre le crash et le redémarrage de la machine
(sur macOS, à condition que Docker Desktop se lance à l'ouverture de session).

Trois choses à savoir avant de l'utiliser, détaillées dans
[`docs/deployment.md`](./docs/deployment.md) et en tête de
[`docker-compose.yml`](./docker-compose.yml) :

- le service monte `/var/run/docker.sock` — un accès **équivalent à root sur
  l'hôte**. C'est inévitable : le daemon a pour rôle de lancer des conteneurs.
  Le code écrit par le modèle, lui, ne tourne jamais là : il tourne dans les
  conteneurs agent, dont le durcissement est intact ;
- `CDS_WORK_DIR` est monté **au même chemin absolu des deux côtés**. Les
  espaces de travail que le daemon crée dessous sont montés dans les
  conteneurs agent, et ces montages sont résolus par le moteur Docker de
  l'hôte — un chemin interne au conteneur donnerait un montage vide, sans
  erreur ;
- le proxy d'inférence est joint par le **nom du conteneur** du daemon sur un
  réseau Docker partagé, pas par `host.docker.internal` qui désignerait
  l'hôte. Aucun port n'est publié : ce proxy détient `INFERENCE_API_KEY`.

## Scripts npm

| Script | Commande | Rôle |
|---|---|---|
| `npm run dev` | `tsx src/daemon/index.ts` | Lance le daemon (polling + traitement des demandes). |
| `npm test` | `node --test 'tests/**/*.test.ts'` | Suite de tests native Node, 448 tests, aucune dépendance externe, aucun modèle ni token GitLab requis. |
| `npm run test:watch` | `node --test --watch ...` | Idem, en mode watch. |
| `npm run check` | `tsc --noEmit` | Seul filet de typage — voir [CI](#documentation-complémentaire), pas câblé automatiquement avant ce chantier. |
| `npm run context -- <mr\|issue> <iid>` | `tsx src/tools/dump-context.ts` | Construit le `TaskContext` d'une MR ou d'une issue réelle et l'écrit dans `./context-dump.json` — utile pour inspecter ce que le prompt verra, sans lancer l'agent. |
| `npm run review -- <mr-iid>` | `tsx src/tools/dry-review.ts` | Exécute une review réelle (contexte + agent + validation) sur le premier dépôt déclaré dans `projects.json`, affiche les remarques sans les publier sur GitLab. |
| `npm run publish -- <mr-iid>` | `tsx src/tools/dry-publish.ts` | Publie trois remarques écrites à la main (ligne ajoutée, ligne de contexte, ligne hors diff) sur une vraie MR, pour vérifier le comportement de `publishReview` (positions, repli, idempotence) sans dépendre du modèle. |
| `npm run implement -- <mr-iid> <branche>` | `tsx src/tools/dry-implement.ts` | Exécute une implémentation réelle (clone, agent, garde-fous, push) sur la MR et la branche indiquées. |
| `npm run proxy` | `tsx src/tools/proxy.ts` | Démarre isolément le proxy d'inférence filtrant (voir `INFERENCE_UPSTREAM_URL`/`INFERENCE_PROXY_PORT`), pour observer le trafic opencode ↔ LM Studio hors de tout conteneur. |

Les scripts `review`/`publish`/`implement`/`context` appellent tous de
vraies API GitLab, sur le premier dépôt déclaré dans `projects.json` : ils
ne fonctionnent pas sans un `.env` et un `projects.json` valides, avec un
token utilisable — contrairement à `npm test`, qui n'en dépend jamais.

## Images Docker

Deux Dockerfiles, deux usages distincts :

- **`docker/node22.Dockerfile`** — image d'exécution pour l'installation et
  les tests du dépôt cible (`DOCKER_DEFAULT_IMAGE`/`DOCKER_IMAGES`). Ne
  contient qu'un environnement Node 22 + git.
- **`docker/agent.Dockerfile`** — image dans laquelle tourne l'agent
  (`AGENT_IMAGE`) : Node 22 + git + ripgrep + `opencode-ai` installé
  globalement.

```bash
docker build -f docker/node22.Dockerfile -t cds-agent/node22 .
docker build -f docker/agent.Dockerfile  -t cds-agent/agent-node22 .
```

Les deux images tournent sous un utilisateur non root par défaut (`agent`,
uid 1001), **systématiquement écrasé** au lancement par `docker run --user
<uid hôte>:<gid hôte>` (voir `hostUser()` dans `src/agent/sandbox.ts`) : le
`USER` du Dockerfile n'est qu'un filet pour une invocation manuelle sans
`--user`. `HOME` et le cache npm pointent sous `/tmp` (mondialement
inscriptible), justement parce que l'uid réellement utilisé à l'exécution
n'est pas forcément celui baké dans l'image.

Si vos noms d'image diffèrent de ces exemples, ajustez `AGENT_IMAGE` et
`DOCKER_DEFAULT_IMAGE`/`DOCKER_IMAGES` en conséquence dans `.env`.

## Modèle (local ou distant)

Le daemon ne parle pas directement à un modèle : il génère un prompt, le
dépose dans le workspace de la tâche, et lance `opencode run --model
<AGENT_MODEL> "$(cat prompt.txt)"` dans le conteneur agent, avec une config
opencode générée à la volée pointant vers un fournisseur `openai-compatible`.

Ce qu'il faut avoir en place :

1. Un serveur compatible OpenAI qui écoute sur l'hôte (LM Studio par défaut,
   `http://127.0.0.1:1234/v1` — `INFERENCE_UPSTREAM_URL`).
2. Un modèle chargé dont l'identifiant apparaît dans `AGENT_MODEL`, au format
   `fournisseur/modèle` (ex. `lmstudio/qwen2.5-coder-7b-instruct-mlx`) —
   validé au démarrage. Dans la config opencode générée, la partie avant le
   premier `/` nomme le fournisseur déclaré et celle d'après sert de clé de
   modèle : les deux suivent cette variable.
3. Par défaut (sans `CONTAINER_INFERENCE_URL`), le conteneur agent ne connaît
   **que** l'adresse d'un proxy HTTP filtrant démarré localement pour la
   durée de l'exécution (`src/tools/proxy.ts`), qui relaie exclusivement vers
   `INFERENCE_UPSTREAM_URL` — jamais un accès direct et ouvert à
   `host.docker.internal` (donc à tous les ports de l'hôte). Ce proxy ne
   filtre que le trafic d'inférence d'opencode ; il ne bloque pas un appel
   réseau que l'agent lancerait lui-même via un outil shell (voir
   [Limites connues](#limites-connues)).

Aucun modèle n'est fourni ni téléchargé par ce projet : c'est à
l'opérateur de charger un modèle dans LM Studio (ou tout serveur compatible
OpenAI) avant de lancer le daemon.

### Viser un fournisseur distant plutôt que l'inférence locale

Rien n'oblige l'upstream à être local. Il suffit de trois réglages, sans
changement de code :

```dotenv
INFERENCE_UPSTREAM_URL=https://api.scaleway.ai/v1
INFERENCE_API_KEY=<clé du fournisseur>
AGENT_MODEL=scaleway/mistral-nemo-instruct
```

Une URL `https://` est relayée en TLS par le proxy. **La clé ne descend
jamais dans le conteneur agent** : c'est le proxy, côté hôte, qui l'ajoute en
`Authorization: Bearer` au moment de relayer, et il écrase l'en-tête envoyé
par le conteneur (qui ne porte qu'un placeholder inerte). Elle ne figure pas
non plus dans la liste blanche de `sanitizedEnv()`, donc aucun processus
enfant ne la reçoit — même traitement que `GITLAB_TOKEN`.

L'unique exception est `CONTAINER_INFERENCE_URL`, qui court-circuite le
proxy : plus personne n'authentifie alors la requête à la place du conteneur,
et la clé doit y descendre pour que l'appel aboutisse. Une raison de plus de
réserver cette échappatoire à une inférence locale.

Deux points à garder en tête avant de brancher un fournisseur facturé : le
prompt envoyé contient le code du dépôt relu (voir [Limites
connues](#limites-connues) pour ce que le proxy ne filtre pas), et le
`AGENT_TIMEOUT_MINUTES` calibré pour une inférence locale n'a pas la même
signification face à une API distante.

## Proxy d'entreprise

Derrière un proxy d'entreprise, les commandes git côté hôte (clone, push)
fonctionnaient déjà avant ce chantier : `sanitizedEnv()` transmet `HOME`,
donc `git` lit son `~/.gitconfig` (`http.<url>.proxy`, scopé par hôte) comme
sur le poste de l'opérateur. Deux trous restaient ouverts, tous deux comblés
par `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (variantes minuscules également
reconnues) dans l'environnement du daemon :

- **Les appels API GitLab** (`src/gitlab/client.ts`, via `fetch()`).
  Node **n'honore aucune variable de proxy nativement pour `fetch()`** —
  contrairement à `git`. Node 22.21+/24.5+ propose un mécanisme natif
  (`--use-env-proxy` / `NODE_USE_ENV_PROXY`) qui, vérifié empiriquement pour
  ce projet (Node 24.14 et 26.3, via `diagnostics_channel` sur
  `undici:client:connectError` pour observer l'hôte réellement contacté),
  s'est révélé **sans aucun effet sur `fetch()`** — seulement sur
  `node:http`/`node:https`. `src/gitlab/proxy-fetch.ts` réimplémente donc
  lui-même, sur ces primitives natives (`node:http`/`node:https`/`node:tls`,
  tunnel `CONNECT` + TLS pour une cible `https:`), le nécessaire pour que
  `fetch()` reparte bien vers le proxy configuré — **indépendamment de tout
  flag ou variable Node**, donc que le daemon soit lancé via `npm run dev`
  ou `tsx src/daemon/index.ts` directement. Sans `HTTP_PROXY`/`HTTPS_PROXY`
  dans l'environnement, ce mécanisme n'intervient jamais : `fetch()` natif
  est utilisé tel quel, comportement nominal inchangé.
- **Le conteneur d'installation/tests du dépôt cible** (`implement.ts`,
  `network: true` uniquement — un conteneur `--network none` n'a de toute
  façon aucun moyen d'atteindre un proxy). `containerProxyEnv()`
  (`src/config.ts`) transmet `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` au
  conteneur, avec une réécriture automatique : un proxy dont l'hôte est en
  loopback (`127.0.0.1`/`localhost` — un relais local type cntlm/Kerberos,
  par exemple) est réécrit vers `host.docker.internal` (avec `--add-host`
  ajouté automatiquement), sinon injoignable depuis le netns du conteneur.
  Un proxy sur une adresse réseau normale (le cas courant en entreprise) est
  transmis tel quel, déjà joignable par le réseau `bridge` du conteneur.
  `CONTAINER_HTTP_PROXY`/`CONTAINER_HTTPS_PROXY`/`CONTAINER_NO_PROXY`
  court-circuitent entièrement cette résolution automatique, pour le cas
  qu'elle ne saurait pas résoudre (voir `.env.example`).

**Le conteneur agent (`runAgentInSandbox`) ne reçoit jamais ce proxy**,
décision délibérée : son réseau est volontairement restreint au seul proxy
d'inférence local (voir [Modèle (local ou distant)](#modèle-local-ou-distant) ci-dessus) — lui
transmettre en plus le proxy d'entreprise élargirait sa portée réseau, à
l'exact opposé de cette restriction.

**Ce qui reste à la charge de l'opérateur, sans solution automatique** :

- Si le proxy n'est configuré **que** dans `~/.gitconfig` et jamais exporté
  comme variable d'environnement, `git` en profite déjà mais ni `fetch()`
  ni le conteneur ci-dessus n'ont quoi que ce soit à lire — il faut
  explicitement exporter `HTTP_PROXY`/`HTTPS_PROXY` (et `NO_PROXY` si
  besoin) pour le process du daemon. **Le daemon avertit au démarrage dans
  ce cas précis** (`src/daemon/proxy-check.ts` : un proxy git est configuré
  pour `GITLAB_URL` mais aucune variable d'environnement de proxy n'est
  présente), sans jamais journaliser la valeur du proxy configuré — une URL
  de proxy authentifié embarque parfois un identifiant dans son userinfo
  (`http://utilisateur:jeton@proxy`), un secret à part entière.
- La réécriture automatique loopback → `host.docker.internal` ne couvre que
  ce cas précis : un proxy sur une adresse ni loopback ni normalement
  joignable par le réseau `bridge` du conteneur (segmentation réseau
  particulière, alias propre à l'hôte...) reste un cas à résoudre à la main
  via `CONTAINER_HTTP_PROXY`/`CONTAINER_HTTPS_PROXY`.
- Git LFS (`filter.lfs.*`) et `credential.helper`, s'ils sont configurés
  dans `~/.gitconfig`, restent des commandes exécutées par `git` côté hôte,
  hors de la portée de ce chantier : `fingerprintGitMeta` n'empreinte que
  `.git/config` du dépôt **cloné**, jamais la configuration globale de
  l'opérateur, mais l'agent (conteneurisé, réseau restreint) n'a de toute
  façon aucun moyen d'atteindre cette configuration globale pour la
  modifier — angle mort théorique, pas un chemin d'attaque réel dans ce
  modèle de menace.

## Journalisation

§6.4 : `src/log.ts` remplace les `console.log`/`warn`/`error` des modules
principaux (`src/daemon/`, `src/tasks/`, `src/agent/`) par un logger
structuré — une ligne JSON par événement (`ts`, `level`, `msg`), par défaut.
`LOG_LEVEL` filtre les niveaux émis (`debug`/`info`/`warn`/`error`, défaut
`info`) ; `LOG_PRETTY=1` bascule vers une ligne condensée pensée pour un
terminal humain (`12:03:45.123 INFO [note:42 grp/repo!7] message`) — ce
projet se debugue aussi en regardant défiler le terminal en développement,
mais le JSON reste le format par défaut, celui qu'un outil de collecte doit
pouvoir lire sans effort.

**Corrélation** : `node:async_hooks` (`AsyncLocalStorage`) propage
`key`/`projectPath`/`iid` à travers toute la chaîne d'appels asynchrones
d'une demande, sans qu'aucune fonction intermédiaire n'ait à les recevoir en
paramètre. Deux fenêtres de corrélation distinctes couvrent le cycle de vie
complet d'une demande (voir `src/daemon/index.ts`) :

- `handle()` — de la réception du to-do jusqu'à la mise en file (accusé de
  réception compris) ;
- `trackedWorker()` — l'exécution réelle du worker (`runTask()` et tout ce
  qu'elle appelle : `buildContext`, `runReview`/`runImplement`,
  `publishReview`...), potentiellement démarrée plusieurs minutes plus tard,
  une fois la demande dépilée de la file.

Une ligne journalisée en dehors de ces deux fenêtres (démarrage,
fin de cycle de polling, erreurs génériques de la file) ne porte aucun de ces
trois champs — jamais de valeur inventée.

**Flux bruts, pas des logs** : `runAgent()` (`src/agent/runner.ts`) et
`runInSandbox()` (`src/agent/sandbox.ts`) recopient en direct, sur
`process.stdout`, la sortie de l'agent ou du conteneur — une sortie de
build, un JSON de review, la trace d'un test qui échoue. Ce flux n'est
délibérément **pas** transformé en JSON ligne à ligne : il n'a pas de
structure d'événement (une seule commande peut produire des dizaines de
lignes hétérogènes), et le réencapsuler ligne par ligne n'ajouterait aucune
information exploitable, seulement du bruit et un risque de couper une sortie
binaire ou multi-lignes de façon incohérente. Il reste donc affiché tel quel,
sans préfixe ni JSON — à distinguer visuellement, en pratique, des lignes de
log structuré qui l'entourent.

## Observabilité

§6.5 : un serveur HTTP minimal (`node:http`, zéro dépendance), démarré par
`main()` et arrêté avec le reste du daemon (branché sur la séquence de drain
de `src/daemon/shutdown.ts`), expose deux routes :

- **`GET /healthz`** — `200` en fonctionnement nominal, `503` si dégradé
  (deux motifs possibles, combinables : le dernier cycle de polling réussi
  remonte à plus de 3×`POLL_INTERVAL_MS`, ou la tâche en cours dépasse la
  durée légitime maximale d'une tâche — `AGENT_TIMEOUT_MINUTES` + 3×
  `COMMAND_TIMEOUT_MINUTES`, ce qui répond à « bloqué sur un agent depuis
  40 minutes ? » avec les valeurs par défaut du projet). La réponse inclut la
  profondeur de la file, la tâche en cours et depuis combien de temps
  (`key`/`projectPath`/`iid`, jamais le texte de la demande), et les
  compteurs ci-dessous.
- **`GET /metrics`** — exposition texte façon Prometheus (écrite à la main,
  `# HELP`/`# TYPE` par métrique) : profondeur de la file, durée de la tâche
  en cours, et compteurs cumulés depuis le démarrage — demandes traitées,
  refusées (`authorize()`), abandonnées (épuisement de `MAX_ATTEMPTS`).

`HEALTH_ENABLED=0` désactive complètement le serveur (aucun port ouvert) ;
`HEALTH_PORT`/`HEALTH_HOST` en configurent l'écoute (`127.0.0.1:8090` par
défaut — loopback, pas d'exposition involontaire sur le réseau). Aucune des
deux routes n'expose de token, de contenu de dépôt, ni de texte de demande.

## Garde-fous de sécurité

Résumé ; le raisonnement complet de chacun est dans `docs/adr/` et dans les
commentaires du code cité :

- **Sandbox Docker par défaut** (`src/agent/sandbox.ts`) : `--user` (uid
  hôte), `--read-only` + tmpfs borné pour `/tmp`, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, profil seccomp par défaut de Docker
  (obtenu en ne passant aucune option `seccomp`, la seule façon correcte :
  `seccomp=` attend un chemin de fichier de profil, pas un mot-clé),
  `--pids-limit`, `--ulimit nofile`, réseau `none` par défaut (`bridge`
  uniquement pour l'exécution de l'agent, via le proxy d'inférence).
- **Un test rouge sur une assertion juste n'est plus jeté**
  (`tests-failing`, `src/tasks/implement.ts`) : quand la suite de référence
  était verte, que seuls des fichiers autorisés ont changé et que la suite est
  rouge après l'agent, le travail part dans une **merge request dédiée en
  Draft** (branche `cds-agent/…`, jamais la branche source, quelles que
  soient les capacités du dépôt), dont le diff porte les tests écrits et la
  description la sortie d'échec. Un humain tranche entre « l'assertion est
  fausse » (fermer) et « le code a un défaut » (fusionner). Si l'ouverture de
  la MR échoue, repli sur la republication du contenu dans le commentaire —
  jamais une perte sèche.

  Mesuré le 1er août 2026, et c'est ce qui a motivé ce correctif : sur quatre
  modèles, **les deux seuls à avoir attrapé un vrai bug repartaient les mains
  vides** (leur travail détruit avec le workspace), pendant que les deux qui
  n'avaient rien trouvé voyaient le leur publié — dont un qui a gravé un bug
  dans la suite après l'avoir décrit en commentaire. Le pipeline publiait le
  mauvais comportement et jetait le bon. `pushed` n'est pas un succès,
  `tests-failing` n'est pas un échec.
- **Revue réellement en lecture seule** (`permissionsFor`, même fichier) : la
  configuration opencode générée refuse `edit`, `bash` et `webfetch` pour une
  revue comme pour le planificateur ; seule une tâche d'implémentation reçoit
  les outils d'écriture. `read`/`glob`/`grep` restent ouverts dans tous les
  cas — c'est l'exploration qui fait la valeur d'une revue. Mesuré avant ce
  correctif : sur 13 runs de campagne, un modèle a corrigé lui-même le bug
  qu'il devait signaler (et rendu un rapport au lieu du JSON attendu), un
  autre a lancé `npm install && npm test`.
- **Hooks git neutralisés** et **empreinte de `.git/config`/`.git/hooks`**
  avant/après l'exécution de l'agent (`src/agent/workspace.ts`,
  `fingerprintGitMeta`) : toute altération interrompt le flux avant la
  moindre commande git supplémentaire.
- **Contrôle de HEAD contre le serveur authentifié**, pas contre l'état local
  (`checkHeadIntegrity` dans `src/tasks/implement.ts`) : le daemon reste seul
  committeur légitime.
- **Garde-fou de chemin, gouverné par un modèle de capacités** (`src/tasks/
  guard.ts::isWritablePath`) : par défaut, seuls des fichiers reconnus comme
  tests peuvent être modifiés en mode implémentation ; une suppression de
  test existant est distinguée et rejetée explicitement (voir
  `docs/adr/0002-garde-fou-chemin-tests.md`). `projects.json` permet
  d'élargir ce périmètre dépôt par dépôt (voir
  [Capacités de l'agent](#capacités-de-lagent) et
  `docs/adr/0005-capacites-agent-par-depot.md`) — un seul point du code
  répond à « l'agent avait-il le droit de faire ça ? », et les contrôles
  ci-dessus (HEAD, hooks git, branche protégée) restent inconditionnels
  quelle que soit la capacité accordée. **Aucune capacité de fusion** :
  aucun chemin de code, à aucun niveau de configuration, n'appelle l'API
  GitLab de fusion d'une merge request (voir
  [Capacités de l'agent](#capacités-de-lagent) ci-dessus).
- **Environnement expurgé** pour tout processus non fiable (`sanitizedEnv()`
  dans `src/config.ts`) : liste blanche plutôt que liste noire.
- **Sorties bornées en mémoire** (`src/agent/bounded-output.ts`) : une
  commande bavarde ou une boucle qui spamme stdout ne fait pas grossir la
  mémoire du daemon sans limite.
- **Délimitation explicite des données non fiables** dans les prompts
  (demande utilisateur, ticket lié, diff) : réduit la surface d'injection
  sans prétendre l'éliminer — voir `docs/adr/0003-opencode-inference-locale.md`.

## Limites connues

Honnêtement, dans l'ordre où elles comptent le plus :

- **Aucun modèle local n'a pu être exécuté pendant la rédaction de cette
  documentation** (contrainte de l'environnement) : tout ce qui dépend d'un
  vrai modèle (qualité des remarques, taux réel de réponses mal formées,
  respect effectif des délimiteurs anti-injection par un modèle 7B) n'a pas
  pu être vérifié en conditions réelles. Le code le dit lui-même à plusieurs
  endroits (`src/tasks/review.ts`, `src/tools/proxy.ts`). Le 7B configuré par
  défaut (`AGENT_MODEL`) est une contrainte du poste de développement
  (un Mac), pas un choix d'architecture : rien n'empêche de cibler un modèle
  plus grand (70B par exemple) sur une machine dimensionnée pour — voir
  `docs/adr/0003-opencode-inference-locale.md`.
- **File de tâches en mémoire, perte assumée au redémarrage** : une demande
  accusée (`acked`) mais pas encore démarrée est purement et simplement
  perdue si le daemon s'arrête ou crashe avant — le to-do GitLab correspondant
  est déjà marqué `done`, rien ne la rejouera. Une demande `running`
  interrompue n'est jamais rejouée automatiquement au redémarrage (elle
  pourrait être en train de pousser du code) : elle est signalée « à vérifier
  à la main ». Voir `docs/adr/0004-contrat-fiabilite-file-memoire.md`. **Cette
  limite n'est plus annoncée dans le message d'accusé de réception posté sur
  GitLab** (`ackBody()`, `src/daemon/ack.ts`) : décision du propriétaire du
  projet de n'afficher à l'utilisateur aucun contrat de fiabilité, ni faible
  ni fort — l'information reste vraie et documentée ici, mais n'a plus sa
  place dans un message adressé au demandeur.
- **Polling, pas de webhook** : latence de `POLL_INTERVAL_MS` (30 s par
  défaut), deux appels API GitLab par cycle et par instance. `LOOKBACK_MINUTES`
  filtre les to-dos `done` récents sur leur `updated_at` (`src/daemon/todos.ts`)
  — c'est ce champ, et non `created_at`, qui reflète le passage à *done*, un
  to-do pouvant être créé bien avant sa résolution. Voir
  `docs/adr/0001-polling-plutot-que-webhook.md`.
- **Le garde-fou de chemin protège *quels fichiers* sont touchés, pas ce
  qu'ils contiennent** : rien n'empêche un agent d'écrire un fichier de test
  qui ne teste rien d'utile (assertions vides ou triviales) tant qu'il vit
  sous un chemin reconnu comme test.
- **Le proxy d'inférence ne filtre que le trafic d'opencode**, pas un appel
  réseau que l'agent lancerait lui-même via un outil shell dans le
  conteneur : celui-ci reste sur un réseau `bridge` avec accès à
  `host.docker.internal` pendant l'exécution de l'agent (`network: true`
  dans `runAgentInSandbox`).
- **La taille du bind mount `/repo` n'est pas plafonnable par `docker run`**
  (contrairement au tmpfs `/tmp`, borné à 1 Go) : un agent qui écrirait des
  fichiers volumineux dans le dépôt cloné n'est pas contenu par un flag
  Docker.
- **Verrou d'instance non atomique** (`src/daemon/lock.ts`) : fenêtre de
  course théorique entre la lecture et l'écriture du fichier de verrou — non
  couvert par une primitive cross-plateforme sans dépendance
  supplémentaire ; documenté comme suffisant contre le scénario visé (une
  seconde instance oubliée dans un tmux), pas contre deux démarrages
  simultanés à la milliseconde près.
- **`appendFileSync` sans `fsync`** (`src/daemon/store.ts`) : une ligne
  `claimed` peut ne jamais atteindre le disque en cas de crash brutal
  (coupure d'alimentation, `kill -9`), auquel cas la demande est rejouée
  depuis zéro plutôt que simplement perdue — garantie plus faible que ce que
  suggère le commentaire historique du code.
- **Un seul daemon par verrou/PAT, un seul worker à la fois** : pas de
  répartition de charge. Conséquence assumée, pas un effet de bord marginal :
  une implémentation de tests qui prend dix minutes (le budget par défaut)
  bloque toutes les revues et toutes les implémentations de *tous* les
  dépôts surveillés pendant ce temps, sans priorité possible. Voir
  `docs/adr/0007-worker-unique-et-absence-de-quotas.md`.
- **Aucun quota, aucun comptage de coût** : rien ne limite le nombre de
  demandes qu'un utilisateur autorisé peut enfiler dans la file (un même
  utilisateur peut, seul, en poser cinquante et monopoliser le worker
  unique aussi longtemps qu'il faut pour les traiter), et rien ne mesure le
  temps de calcul ou les tokens d'inférence consommés. Décision assumée, pas
  un oubli — voir `docs/adr/0007-worker-unique-et-absence-de-quotas.md`.
- **`ALLOW_UNSANDBOXED=1`** exécute du code potentiellement écrit par le
  LLM directement sur l'hôte, avec le profil de connexion complet de
  l'utilisateur — à ne jamais utiliser hors développement local.
- **Seules les merge requests sont traitées** : le chemin « issue directe »
  existe dans `src/tasks/context.ts` (utilisé par `npm run context`) mais
  `src/tasks/router.ts` refuse explicitement toute autre cible.

## Tests

```bash
npm test
```

703 tests, `node --test` natif, aucune dépendance de test ajoutée. Les tests
qui touchent Docker ou git injectent un faux binaire (voir
`tests/agent/sandbox.test.ts`, `tests/agent/workspace.test.ts`) : la suite ne
nécessite ni Docker réellement lancé, ni modèle d'inférence, ni token GitLab
valide. `npm run check` (`tsc --noEmit`) est le seul contrôle de types.

Les deux sont câblés **deux fois**, volontairement : dans
[`.gitlab-ci.yml`](./.gitlab-ci.yml) parce que le projet cible GitLab, et dans
[`.github/workflows/verify.yml`](./.github/workflows/verify.yml) parce que le
dépôt est publié sur GitHub — une CI qui ne tourne nulle part ne vaut rien.
Les deux fichiers doivent rester alignés : mêmes jobs, mêmes commandes, même
version de Node. Le seul écart est documenté en tête du workflow GitHub (les
images `node:*-slim` ne contiennent pas git, donc `actions/setup-node` plutôt
qu'un `container:`).

## Documentation complémentaire

- [`docs/deployment.md`](./docs/deployment.md) — comment ce POC tourne (ou
  ne tourne pas) ailleurs qu'un terminal ouvert.
- [`docs/adr/`](./docs/adr/) — décisions d'architecture : polling vs
  webhook, garde-fou par chemin, opencode + inférence locale, contrat de
  fiabilité de la file en mémoire, modèle de capacités par dépôt, frontière
  de confiance (patch vs clone), worker unique et absence de quotas.
- [`.env.example`](./.env.example) — les quarante-trois variables lues par
  `buildConfig()`, une par une.
- [`projects.example.json`](./projects.example.json) — modèle complet du
  fichier de configuration par projet (voir
  [Capacités de l'agent](#capacités-de-lagent)).

## Licence

[GNU Affero General Public License v3.0](./LICENSE) (AGPL-3.0-only).

Une conséquence à connaître avant de déployer ce daemon quelque part :
**l'AGPL ajoute une obligation que la GPL n'a pas** (section 13). Il ne suffit
pas de partager les sources quand on *distribue* le logiciel — il faut aussi
les proposer aux utilisateurs qui y accèdent **à travers un réseau**. Or c'est
exactement ce qu'est ce projet : un service qui tourne en continu et avec
lequel on interagit à distance, par des commentaires GitLab. Quiconque en
exploite une version modifiée doit donc en publier le code, même sans jamais
en distribuer une copie.

C'est délibéré pour ce type de logiciel. Si l'objectif était au contraire de
laisser n'importe qui l'intégrer sans contrepartie, MIT ou Apache-2.0 seraient
les choix adaptés — et il faudrait changer à la fois `LICENSE` et le champ
`license` de `package.json`.
