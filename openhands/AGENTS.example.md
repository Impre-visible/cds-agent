# AGENTS.md — exemple de référence

> **À copier dans le dépôt RELU, pas ici.** Ce fichier est un modèle. Placez-le
> à la racine du dépôt que le bot relit, sous le nom `AGENTS.md`, et adaptez-le.
> Il est versionné avec ce projet-là, relu par ses mainteneurs, et son contenu
> entre dans le prompt système de chaque conversation OpenHands sur ce dépôt.
>
> Gardez-le **court**. Il est chargé en entier, à chaque fois. Ce qui n'est
> utile qu'à certaines tâches va dans une compétence sous `.agents/skills/`,
> chargée à la demande — voir `docs/openhands.md`.

---

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

---

# À compléter par projet

Ce qui suit change d'un dépôt à l'autre. Remplacez ces exemples.

## Ce que fait ce dépôt

<!-- Deux ou trois phrases. À quoi sert ce code, qui l'utilise. -->

## Comment le faire tourner

```bash
npm ci
npm test
```

## Structure

<!-- Les trois ou quatre répertoires qui comptent, une ligne chacun. -->

## Conventions maison qu'un relecteur ne devinerait pas

<!-- Ex. : « les erreurs métier passent par AppError, jamais par throw brut »,
     « toute route publique doit passer par requireAuth ». C'est ici que ce
     fichier vaut vraiment quelque chose : le reste, un bon modèle le sait
     déjà. -->
