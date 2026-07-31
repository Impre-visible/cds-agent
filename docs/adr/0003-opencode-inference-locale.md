# ADR 0003 — opencode comme runtime d'agent, inférence locale

## Statut

Acceptée (présente depuis `feat: agent conteneurisé` (`9983716`), durcie par
`d6e6448` (prompts, plafonds, délimiteurs), `723245d` (extraction/validation
de la sortie), `fe30ec0` (réseau de la sandbox)).

## Contexte

Le daemon a besoin d'un agent capable de lire un dépôt, raisonner sur un
diff ou une demande, et produire soit du texte structuré (JSON de remarques
de review), soit des modifications de fichiers (tests). Deux décisions
distinctes, prises ensemble ici parce qu'elles se répondent :

1. **Quel runtime fait tourner le modèle contre le dépôt ?** — le projet
   utilise [opencode](https://opencode.ai), lancé en CLI
   (`opencode run --model <AGENT_MODEL> "..."`) dans le conteneur agent
   (`src/agent/runner.ts` hors Docker, `runAgentInSandbox()` dans
   `src/agent/sandbox.ts` en mode Docker, le mode par défaut).
2. **Où tourne le modèle lui-même ?** — en local, via un serveur compatible
   OpenAI (LM Studio dans ce projet), configuré comme fournisseur
   `openai-compatible` d'opencode (`OPENCODE_CONFIG_CONTENT`, généré à la
   volée dans `runAgentInSandbox()`).

## Décision

Utiliser opencode tel quel comme runtime d'agent (pas un appel direct à une
API de complétion, pas un framework d'agent maison), et cibler un modèle
d'inférence local plutôt qu'une API hébergée.

## Conséquences

### Ce que ça coûte

- **Deux canaux de sortie à gérer, aucun garanti.** opencode écrit parfois
  le résultat de la review dans un fichier (`.cds-review.json`), parfois
  seulement sur stdout, mêlé au bruit des appels d'outils qu'il a fait en
  cours de route. `runReview()` essaie le fichier d'abord, retombe sur
  `extractJson(result.stdout)` sinon — et `extractJson()` doit lui-même
  gérer un JSON dans un bloc fenced Markdown, un JSON nu, et un comptage
  d'accolades qui ne se fasse pas piéger par une accolade citée dans le
  texte d'une remarque (voir `findMatchingBrace()`).
- **Validation en profondeur, jamais un simple `as Remark[]`.** `parseRemark()`
  vérifie chaque champ un par un (type, présence, plage de `line`,
  cohérence de `severity`) parce que rien ne garantit que le modèle respecte
  le schéma demandé — un `line` sérialisé en chaîne, une `severity`
  inventée, un champ manquant sont tous des cas réels à absorber pour un
  modèle 7B, pas des cas d'école.
- **Replis en cascade côté publication.** `publishReview()` tente un
  commentaire positionné sur la ligne, puis sur le fichier entier, puis un
  commentaire général groupé — parce qu'une position que le modèle a cru
  valide peut être refusée par l'API GitLab (ligne hors diff après un
  recalcul, par exemple), et qu'un rejet complet de la review serait pire
  qu'un repli moins précis.
- **Un proxy d'inférence maison** (`src/tools/proxy.ts`), plutôt qu'un accès
  réseau direct du conteneur agent vers l'hôte, pour éviter d'exposer tous
  les ports de l'hôte à travers `host.docker.internal` — complexité
  supplémentaire (serveur HTTP, relais, fermeture propre) qui n'existerait
  pas avec une API hébergée jointe directement en HTTPS sortant.
- **Aucune garantie que le modèle respecte les délimiteurs anti-injection**
  du prompt (`DATA_PREAMBLE` dans `review.ts`/`implement.ts`) : un modèle
  7B ne les respecte que parce qu'ils sont nommés dans le prompt, pas par
  une propriété du système — le code le dit lui-même (voir les commentaires
  de `review.ts`).

### Ce que ça achète

- **Aucune donnée du dépôt cible ni des tickets liés ne quitte l'infrastructure
  locale** vers un tiers — pertinent pour un dépôt d'entreprise, même en
  phase de POC.
- **Aucun coût d'API, aucune dépendance à la disponibilité d'un fournisseur
  externe.**
- **opencode encapsule déjà** la boucle outillée (lecture de fichiers,
  exécution de commandes, édition) qu'il aurait fallu réimplémenter pour
  interagir avec un modèle nu par API — le projet n'a pas eu à écrire son
  propre harnais d'agent.

### Limite qu'aucune des deux décisions ne compense

**Aucun modèle local n'a pu être exécuté dans le cadre du chantier de
durcissement dont ce dépôt porte la trace** (contrainte de l'environnement
de travail, pas du projet en usage normal) : la qualité réelle des remarques
de review, le taux effectif de réponses mal formées, le comportement réel
d'un modèle 7B face aux délimiteurs anti-injection n'ont pas pu être
mesurés contre un modèle réel — seulement contre des fixtures et un faux
agent (`FAKE_AGENT_SCRIPT`, voir `fixtures/*.sh`). C'est écrit à plusieurs
endroits du code (`review.ts`, `proxy.ts`) plutôt que caché : cette ADR le
répète pour qu'il ne se perde pas dans un commentaire isolé.

## Alternatives écartées

- **Appel direct à l'API de complétion du modèle**, sans opencode : aurait
  évité la double incertitude sur le canal de sortie (fichier/stdout) et
  simplifié l'extraction, au prix de devoir réimplémenter soi-même tout ce
  qu'opencode fournit déjà (lecture de fichiers, exécution de commandes
  dans le dépôt, boucle d'itération de l'agent sur les tests rouges). Non
  retenue : le POC visait à valider le comportement de bout en bout, pas à
  réécrire un runtime d'agent.
- **API hébergée** (un fournisseur cloud) plutôt qu'inférence locale :
  aurait simplifié le réseau (pas de proxy filtrant à maintenir, pas de
  contrainte sur le déploiement du daemon — voir `docs/deployment.md`) et
  probablement amélioré la qualité des réponses (modèles plus grands
  disponibles), au prix d'envoyer le contenu des dépôts et des tickets à un
  tiers. Écartée pour ce POC, dont l'hypothèse de départ est justement de
  tourner sans dépendance externe.
- **Réseau Docker interne dédié** (le conteneur agent n'aurait accès qu'à ce
  proxy, sans passer par le bridge par défaut avec accès à
  `host.docker.internal`) : envisagée pour fermer complètement l'accès
  réseau direct de l'agent, mais nécessite une bascule vérifiable
  uniquement avec un vrai démon Docker en fonctionnement — non disponible
  dans le cadre de ce chantier (voir la limite correspondante dans le
  README, section Limites connues). Documentée comme amélioration possible,
  pas actée.
