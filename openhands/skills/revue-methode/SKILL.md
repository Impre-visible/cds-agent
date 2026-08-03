---
name: revue-methode
description: La méthode de revue de code de ce déploiement — lire les fichiers en entier, ne rien affirmer sur du code non lu, signaler des défauts et non des préférences. À appliquer pour toute revue de merge request ou de pull request.
triggers:
- revue
- review
- code review
- relire
---
<!-- Note d'implémentation.
  Compétence SANS frontmatter et SANS déclencheur : elle est donc chargée EN
  ENTIER dans chaque conversation, comme le serait un AGENTS.md.

  POURQUOI ICI ET PAS DANS LE DÉPÔT RELU. AGENTS.md serait l'emplacement
  documenté — mais il vivrait dans le dépôt de mesure, donc dans le DIFF des
  merge requests, sauf à le poser aussi sur la branche cible. Impossible sur
  ce dépôt : `master` est protégée en push Mainteneur et le compte du bot est
  Développeur. Monté ici, le contenu vaut pour tous les dépôts et n'apparaît
  dans aucun diff.

  Reste court : il est chargé à CHAQUE tâche. Ce qui n'est utile qu'à
  certaines tâches va dans une compétence à déclencheurs.

  openhands/AGENTS.example.md porte la même méthode, en version « à copier
  dans le dépôt relu » — avec en plus les sections propres au projet
  (structure, commandes, conventions maison) qui, elles, n'ont de sens que
  versionnées avec le code.
-->

# Méthode de revue

## Lire avant de juger

Lis **en entier** les fichiers que la merge request modifie, pas seulement le
diff. Une partie des défauts n'existe pas dans le diff : ils naissent de la
rencontre entre le code ajouté et du code qui n'a pas bougé — une fonction
appelée plus haut, une constante définie ailleurs, un invariant maintenu par
un autre chemin.

Quand une remarque porte sur l'usage d'une fonction, ouvre aussi cette
fonction.

## Ne rien affirmer sur du code non lu

C'est la règle la plus importante de ce fichier, et la seule dont l'oubli
coûte plus cher qu'un défaut raté.

Dire « cette vérification est correcte » d'une fonction que tu n'as pas
ouverte transforme une faille passée inaperçue en faille **validée**. Le
lecteur te croit et arrête de chercher. Une revue qui rate un défaut le laisse
au moins trouvable ; une revue qui l'approuve le referme.

Si tu n'as pas lu, ne conclus pas. « Je n'ai pas examiné X » est une phrase
parfaitement acceptable dans une revue.

## Signaler des défauts, pas des préférences

Une remarque décrit ce que le code fait **de faux** : une entrée qui produit
un mauvais résultat, un cas qui plante, une donnée qui fuit, une garantie
annoncée qui n'est pas tenue.

Ce n'est pas :

- ce que tu aurais écrit autrement à qualité égale ;
- un renommage, un formatage, un `const` au lieu d'un `let` ;
- ce qu'un linter voit déjà — il le voit mieux, et sans discuter.

Pour chaque remarque, demande-toi : *quelle entrée précise produit quel
mauvais comportement ?* Si tu ne sais pas répondre, ce n'est probablement pas
une remarque.

## Une remarque = un défaut = une ligne

Une remarque porte sur **un** défaut, ancré sur **la** ligne qui le contient.
Pas un paragraphe qui en couvre trois, pas un défaut étalé sur cinq
commentaires.

Formule d'abord ce qui casse, ensuite pourquoi. Le lecteur doit comprendre
l'enjeu en une phrase.

## Ce qui compte le plus, dans l'ordre

1. **Sécurité** — authentification qui ne vérifie rien, autorisation absente,
   injection, donnée sensible exposée ou journalisée.
2. **Correction** — cas limite faux, comparaison qui ne compare pas ce qu'on
   croit, condition inversée, effet de bord non voulu.
3. **Perte ou corruption de données** — écriture non atomique, état partagé
   muté, migration sans retour arrière.
4. **Robustesse** — erreur avalée, promesse non attendue, ressource non
   libérée.

Ce qui n'est dans aucune de ces quatre catégories est probablement un détail.

## Tests

Un test qui épouse le comportement buggé est pire qu'une absence de test : il
grave le défaut et interdit de le corriger sans « casser » la suite.

Si tu écris un test dont l'assertion est juste mais qui échoue, **ne l'adapte
pas pour le faire passer** : tu viens de trouver un défaut du code. Dis-le et
arrête-toi là.
