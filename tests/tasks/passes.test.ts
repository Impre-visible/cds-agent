import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildPassAddendum,
  countFresh,
  extractRemarks,
  fileMentionedIn,
  isReviewPassMode,
  locationOf,
  summarizePasses,
  type PublishedRemark,
} from "../../src/tasks/passes.ts";
import { MAX_PREVIOUS_REMARKS_LISTED } from "../../src/limits.ts";
import type { Discussion, Note } from "../../src/types.ts";

const T0 = Date.parse("2026-08-04T10:00:00.000Z");
const AVANT = "2026-08-04T09:00:00.000Z";
const APRES = "2026-08-04T10:05:00.000Z";

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 1,
    body: "Le compteur repart à zéro quand la liste est vide.",
    system: false,
    created_at: APRES,
    author: { id: 9, username: "cds-bot" } as Note["author"],
    ...overrides,
  };
}

function discussion(notes: Note[]): Discussion {
  return { id: `d${notes[0]?.id ?? 0}`, individual_note: false, notes };
}

function anchored(id: number, file: string, line: number, body: string): Discussion {
  return discussion([
    note({ id, body, position: { new_path: file, new_line: line } }),
  ]);
}

function remark(overrides: Partial<PublishedRemark> = {}): PublishedRemark {
  return { file: "src/a.js", line: 10, gist: "défaut", key: "src/a.js:10", ...overrides };
}

describe("extractRemarks — ce que le bot a réellement publié", () => {
  test("ne retient que les notes du BOT", () => {
    // Une remarque d'un humain n'est pas « déjà couvert par une passe » : la
    // mettre dans la liste d'exclusion interdirait à l'agent d'y aller.
    const remarks = extractRemarks(
      [
        anchored(1, "src/a.js", 10, "Fuite de mémoire ici."),
        discussion([
          note({ id: 2, author: { id: 3, username: "alice" } as Note["author"] }),
        ]),
      ],
      "cds-bot",
      T0,
    );
    assert.equal(remarks.length, 1);
    assert.equal(remarks[0]?.file, "src/a.js");
  });

  test("BORNE TEMPORELLE : une revue antérieure est ignorée", () => {
    // Sans ça, la revue d'hier — ou celle d'un autre modèle sur la même MR —
    // entrerait dans l'exclusion et la passe 1 n'aurait plus rien à dire.
    const remarks = extractRemarks(
      [
        discussion([
          note({
            id: 1,
            created_at: AVANT,
            position: { new_path: "src/vieux.js", new_line: 3 },
          }),
        ]),
        anchored(2, "src/neuf.js", 4, "Condition inversée."),
      ],
      "cds-bot",
      T0,
    );
    assert.deepEqual(
      remarks.map((r) => r.file),
      ["src/neuf.js"],
    );
  });

  test("ignore les notes système et les réponses dans un fil", () => {
    // Une réponse n'est pas une remarque distincte : c'est un échange sur une
    // remarque déjà comptée. La compter doublerait le poids d'un fil bavard.
    const remarks = extractRemarks(
      [
        discussion([
          note({ id: 1, position: { new_path: "src/a.js", new_line: 1 } }),
          note({ id: 2, body: "Bien vu, je corrige." }),
        ]),
        discussion([note({ id: 3, system: true, body: "a changé le titre" })]),
      ],
      "cds-bot",
      T0,
    );
    assert.equal(remarks.length, 1);
  });

  test("une remarque sur une ligne SUPPRIMÉE retombe sur old_path/old_line", () => {
    // GitLab laisse new_line à null dans ce cas : sans repli, la remarque
    // perdrait son emplacement et se confondrait avec un commentaire général.
    const remarks = extractRemarks(
      [
        discussion([
          note({
            id: 1,
            position: {
              new_path: undefined,
              old_path: "src/supprime.js",
              new_line: null,
              old_line: 12,
            },
          }),
        ]),
      ],
      "cds-bot",
      T0,
    );
    assert.equal(remarks[0]?.file, "src/supprime.js");
    assert.equal(remarks[0]?.line, 12);
  });

  test("un commentaire GÉNÉRAL récupère le fichier cité dans son texte", () => {
    // Quatre modèles sur sept n'ancrent RIEN. Sans ce repli, leurs remarques
    // n'auraient aucun emplacement et l'exclusion ne vaudrait rien pour eux.
    const remarks = extractRemarks(
      [discussion([note({ id: 1, body: "Dans `src/todoStore.js`, le filtre est faux." })])],
      "cds-bot",
      T0,
    );
    assert.equal(remarks[0]?.file, "src/todoStore.js");
    assert.equal(remarks[0]?.line, null);
    assert.equal(remarks[0]?.key, "src/todoStore.js:?");
  });

  test("un commentaire général SANS fichier retombe sur sa formulation", () => {
    const remarks = extractRemarks(
      [discussion([note({ id: 1, body: "La gestion des erreurs est trop permissive." })])],
      "cds-bot",
      T0,
    );
    assert.equal(remarks[0]?.file, null);
    assert.match(remarks[0]?.key ?? "", /gestion des erreurs/);
  });

  test("deux remarques au même emplacement ne comptent qu'une fois", () => {
    const remarks = extractRemarks(
      [
        anchored(1, "src/a.js", 10, "Premier angle."),
        anchored(2, "src/a.js", 10, "Second angle, même ligne."),
      ],
      "cds-bot",
      T0,
    );
    assert.equal(remarks.length, 1);
  });

  test("une note vide ou purement décorative n'est pas une remarque", () => {
    const remarks = extractRemarks(
      [discussion([note({ id: 1, body: "```\n\n```" })])],
      "cds-bot",
      T0,
    );
    assert.equal(remarks.length, 0);
  });

  test("aucune discussion : liste vide, pas d'exception", () => {
    assert.deepEqual(extractRemarks([], "cds-bot", T0), []);
  });
});

describe("fileMentionedIn — le repli des remarques non ancrées", () => {
  test("reconnaît un chemin dans un code span comme en texte brut", () => {
    assert.equal(fileMentionedIn("voir `src/a/b.test.js` ligne 3"), "src/a/b.test.js");
    assert.equal(fileMentionedIn("le fichier index.html est faux"), "index.html");
  });

  test("ne fabrique pas un chemin là où il n'y en a pas", () => {
    // Un faux positif ajouterait à l'exclusion un fichier que rien ne couvre,
    // ce qui INTERDIRAIT à la passe suivante d'y chercher. Le silence est le
    // bon défaut.
    assert.equal(fileMentionedIn("La logique métier est fragile."), null);
    assert.equal(fileMentionedIn("Version 2.5 du protocole."), null);
  });
});

describe("buildPassAddendum — la formulation EST le mécanisme", () => {
  const previous = [
    remark({ file: "src/a.js", line: 10, gist: "condition inversée", key: "src/a.js:10" }),
    remark({ file: "src/b.js", line: 4, gist: "erreur avalée", key: "src/b.js:4" }),
  ];

  test("independent ne transmet RIEN — c'est le témoin", () => {
    // Différent de N tirages : les conversations publient sur la même MR.
    assert.equal(buildPassAddendum("independent", previous), "");
  });

  test("liste vide : rien non plus, quel que soit le mode", () => {
    // C'est ce qui garantit qu'une passe 1 — et toute revue à passes:1 —
    // envoie le message d'avant ce chantier au caractère près.
    assert.equal(buildPassAddendum("exclusion", []), "");
    assert.equal(buildPassAddendum("chained", []), "");
  });

  test("exclusion dit « cherche ailleurs », JAMAIS « vérifie »", () => {
    // Mesuré : chained produit l'ancrage (passe 3 = 1 nouvelle remarque),
    // exclusion l'évite (passe 3 = 4). Toute la différence est ici.
    const text = buildPassAddendum("exclusion", previous);
    assert.match(text, /Ne les republie pas/);
    assert.match(text, /ne te contente pas de les vérifier/);
    assert.match(text, /AUTRE NATURE/);
    assert.doesNotMatch(text, /confirme celles qui tiennent/);
  });

  test("chained dit l'inverse — et reste disponible pour la comparaison", () => {
    const text = buildPassAddendum("chained", previous);
    assert.match(text, /confirme celles qui tiennent/);
    assert.doesNotMatch(text, /cherche des défauts d'une AUTRE NATURE/);
  });

  test("une ligne par remarque : emplacement + formulation courte", () => {
    const text = buildPassAddendum("exclusion", previous);
    assert.match(text, /- src\/a\.js:10 — condition inversée/);
    assert.match(text, /- src\/b\.js:4 — erreur avalée/);
  });

  test("la liste est PLAFONNÉE, et le dit", () => {
    // Un addendum long fait perdre des passes (2 utiles sur 3 contre 3 sur 3).
    const many = Array.from({ length: MAX_PREVIOUS_REMARKS_LISTED + 7 }, (_, i) =>
      remark({ file: `src/f${i}.js`, line: i, key: `src/f${i}.js:${i}` }),
    );
    const text = buildPassAddendum("exclusion", many);
    assert.match(text, /7 remarque\(s\) supplémentaire\(s\) non listée\(s\)/);
    const listed = text.split("\n").filter((line) => /^- src\//.test(line));
    assert.equal(listed.length, MAX_PREVIOUS_REMARKS_LISTED);
  });

  test("ne nomme aucun défaut du jeu mesuré — la consigne porte sur la stratégie", () => {
    // Sinon la mesure apprendrait le corrigé au lieu de mesurer la méthode.
    const text = buildPassAddendum("exclusion", []);
    assert.equal(text, "");
  });
});

describe("locationOf — comment une remarque se désigne", () => {
  test("ancrée, au fichier, ou sans emplacement", () => {
    assert.equal(locationOf(remark()), "src/a.js:10");
    assert.equal(locationOf(remark({ line: null })), "src/a.js");
    assert.equal(locationOf(remark({ file: null, line: null })), "sans emplacement");
  });
});

describe("countFresh — la métrique centrale du chantier", () => {
  test("compte le neuf et enrichit l'ensemble vu", () => {
    const seen = new Set<string>();
    assert.equal(countFresh([remark({ key: "a:1" }), remark({ key: "b:2" })], seen), 2);
    assert.equal(countFresh([remark({ key: "b:2" }), remark({ key: "c:3" })], seen), 1);
    assert.deepEqual([...seen].sort(), ["a:1", "b:2", "c:3"]);
  });

  test("une passe qui ne publie rien rend 0, sans planter", () => {
    // Le cas qui décide si le protocole doit être à deux passes.
    assert.equal(countFresh([], new Set(["a:1"])), 0);
  });

  test("une passe qui ne republie QUE du déjà-vu rend 0", () => {
    const seen = new Set(["a:1"]);
    assert.equal(countFresh([remark({ key: "a:1" })], seen), 0);
  });
});

describe("summarizePasses — la ligne qu'on lit en fin de revue", () => {
  test("donne les nouvelles par passe, dans l'ordre, et le total de temps", () => {
    const line = summarizePasses(
      [
        { pass: 1, published: 6, fresh: 6, seconds: 12, result: "finished" },
        { pass: 2, published: 11, fresh: 5, seconds: 15, result: "finished" },
        { pass: 3, published: 15, fresh: 4, seconds: 14, result: "finished" },
      ],
      "exclusion",
    );
    assert.equal(line, "3 passe(s) (mode=exclusion) : 6 + 5 + 4 remarque(s) nouvelle(s), 41 s");
  });

  test("une passe stérile se lit comme un 0 — c'est le signal cherché", () => {
    const line = summarizePasses(
      [
        { pass: 1, published: 6, fresh: 6, seconds: 10, result: "finished" },
        { pass: 2, published: 6, fresh: 0, seconds: 20, result: "finished" },
      ],
      "exclusion",
    );
    assert.match(line, /6 \+ 0 remarque\(s\) nouvelle\(s\)/);
  });

  test("aucune passe : pas de ligne vide trompeuse", () => {
    assert.equal(summarizePasses([], "chained"), "0 passe (mode=chained)");
  });
});

describe("isReviewPassMode — la validation de projects.json", () => {
  test("accepte les trois modes et rien d'autre", () => {
    for (const mode of ["independent", "chained", "exclusion"]) {
      assert.ok(isReviewPassMode(mode));
    }
    // Un mode inconnu ferait silencieusement autre chose que ce qui est
    // écrit — or c'est exactement le choix chained/exclusion qui décide du
    // résultat.
    assert.equal(isReviewPassMode("exclude"), false);
    assert.equal(isReviewPassMode(""), false);
    assert.equal(isReviewPassMode(3), false);
  });
});
