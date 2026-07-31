# ADR 0002 — Garde-fou par chemin pour l'implémentation de tests

## Statut

Acceptée (`src/tasks/guard.ts`, durcie ensuite par les commits
`08a1a1a` et `7f5cd32` — parsing porcelain en `-z`, détection multi-
écosystème).

## Contexte

Pour l'intention « implémente les tests », l'agent LLM tourne dans un clone
du dépôt cible avec un accès en écriture complet au répertoire de travail
(nécessaire : il doit pouvoir créer des fichiers de test, les exécuter,
itérer). Rien, au niveau du conteneur Docker, n'empêche l'agent d'écrire
n'importe où dans `/repo` — la sandbox isole le *système*, pas *le dépôt
qu'on lui a confié*.

Sans contrôle supplémentaire, la seule chose qui distinguerait « l'agent a
ajouté des tests » de « l'agent a modifié le code source pour faire passer
des tests » serait sa propre bonne volonté — or c'est précisément le
scénario qu'on ne veut pas avoir à espérer : un modèle qui cherche à
« réussir » sa tâche peut très bien constater qu'un test échoue et corriger
le code testé plutôt que d'écrire un test correct, ou supprimer un test
gênant plutôt que d'en écrire un qui passe.

## Décision

Après l'exécution de l'agent, `collectChanges()` (`src/tasks/guard.ts`) lit
`git status --porcelain=v1 -uall -z` — l'état réel du dépôt, jamais ce que
l'agent déclare avoir fait — et classe chaque chemin modifié :

- accepté s'il vit sous un répertoire reconnu comme test (`tests/`, `test/`,
  `__tests__/`, `spec/`, à n'importe quel niveau du chemin, plus les
  overrides par dépôt via `TEST_DIRECTORY_OVERRIDES`) ou suit une convention
  de nommage de test connue (JS/TS, Python, Go, Java/Kotlin, Scala, Ruby) ;
- classé `offending` sinon — toute modification hors de ce périmètre ;
- classé `deletedTests` séparément si un fichier de test *existant* a été
  supprimé (ou renommé puis supprimé) : distingué explicitement, parce que
  le chemin final reste, en apparence, dans le périmètre de test — un simple
  filtre sur le chemin ne verrait jamais ce contournement.

`offending.length > 0 || deletedTests.length > 0` déclenche un rollback réel
(`git reset --hard` + `git clean -fdx`, pas seulement `checkout -- .`, qui
laisserait les fichiers non suivis) et un rejet explicite de la tâche : rien
n'est commité, rien n'est poussé.

Un statut `git status` inhabituel (conflit non résolu, changement de type
fichier ↔ lien symbolique, entrée ignorée) est traité comme suspect par
défaut (`isSuspectStatus()`) : le principe retenu est qu'un statut qu'on n'a
pas explicitement décidé d'accepter est refusé, pas qu'il est anodin tant
qu'on n'a pas prouvé le contraire.

## Conséquences

**Ce que ça protège** : le code source de production ne peut pas être
modifié par la voie « implémentation de tests », quelle que soit la façon
dont l'agent s'y prendrait à l'intérieur du conteneur (édition directe,
script, commande shell détournée) — le contrôle porte sur le résultat
observable par git, pas sur la méthode.

**Ce que ça ne protège pas**, honnêtement :

- **Le contenu des tests eux-mêmes.** Le garde-fou vérifie *où* un fichier
  est écrit, jamais *ce qu'il vérifie*. Un test vide, un test dont toutes
  les assertions sont triviales (`expect(true).toBe(true)`), ou un test qui
  ne couvre pas du tout la fonctionnalité demandée passe ce garde-fou aussi
  facilement qu'un test utile — `runImplement()` ne juge que « la suite
  s'exécute et est verte », jamais la pertinence de ce qui a été ajouté.
- **Les tests unitaires Rust inline** (`#[cfg(test)] mod tests { ... }` dans
  le fichier source lui-même) : structurellement, il n'y a pas de chemin
  distinct à reconnaître — hors de portée d'un garde-fou basé sur les
  chemins, documenté comme tel dans `guard.ts`.
- **Les homoglyphes Unicode** dans un nom de répertoire ou de fichier
  (`ｔest/` en largeur pleine, par exemple) : non détectés, jugé hors de
  proportion avec la menace pour ce POC.
- **La convention .NET `MonProjet.Tests/Fichier.cs`** : `Tests` n'y est
  qu'une partie d'un segment plus large, pas le segment entier — l'accepter
  demanderait une comparaison par sous-chaîne qui rouvrirait le risque de
  faux positif que la comparaison par segment entier évite par ailleurs
  (`Latest`, `Contest`...).
- **Un fichier de fixture/config posé hors d'un répertoire de test reconnu**
  (`conftest.py` à la racine, par exemple) : son nom ne suit aucune
  convention de *test*, seule sa présence *dans* un répertoire de test
  déjà reconnu le couvre.

## Alternatives écartées

- **Liste noire de chemins interdits** (`src/`, `lib/`...) plutôt que liste
  blanche de chemins de test : écartée pour la raison structurelle
  habituelle — une liste noire est incomplète par construction (un nouveau
  répertoire de code source dans un dépôt inconnu à l'avance passerait
  au travers), alors qu'une liste blanche de conventions de test, plus
  restreinte, est plus facile à auditer et à faire échouer du bon côté (un
  chemin ambigu est rejeté, pas accepté par défaut).
- **Faire confiance à un commit produit par l'agent** (accepter tout commit
  qui ne touche, dans son diff, que des chemins de test) : écartée en même
  temps que ce garde-fou par `checkHeadIntegrity()` — voir le commentaire de
  cette fonction dans `src/tasks/implement.ts` : le daemon reste seul
  committeur, pour garder un historique auditable et ne jamais avoir à
  faire confiance à un commit fabriqué par l'agent, aussi anodin que son
  contenu puisse sembler.
- **Analyse statique du contenu des tests** (détecter des assertions
  triviales, une couverture insuffisante...) : envisageable en théorie, mais
  hors périmètre de ce garde-fou et non implémentée — voir la limite
  correspondante ci-dessus, assumée plutôt que masquée.
