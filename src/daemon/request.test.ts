import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

// request.ts importe (transitivement, via gitlab/client.ts) src/config.ts,
// qui jette au chargement si GITLAB_TOKEN ou BOT_USERNAME sont absents de
// l'environnement. On les injecte avant l'import dynamique pour rester
// reproductible sans .env local (cf. review.test.ts pour la même astuce).
let defuseMentions: (text: string) => string;
let ZERO_WIDTH_SPACE: string;

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  ({ defuseMentions, ZERO_WIDTH_SPACE } = await import("./request.ts"));
});

describe("defuseMentions", () => {
  test("entoure une mention unique de backticks", () => {
    assert.equal(
      defuseMentions("salut @bot comment ça va"),
      "salut `@bot` comment ça va",
    );
  });

  test("traite plusieurs mentions dans le même texte", () => {
    assert.equal(
      defuseMentions("@alice et @bob discutent"),
      "`@alice` et `@bob` discutent",
    );
  });

  test("accepte les points, tirets et underscores dans le nom d'utilisateur", () => {
    assert.equal(
      defuseMentions("cc @foo.bar-baz_qux"),
      "cc `@foo.bar-baz_qux`",
    );
  });

  test("mention en tout début et toute fin de chaîne", () => {
    assert.equal(defuseMentions("@bot merci @bot"), "`@bot` merci `@bot`");
  });

  test("la ponctuation qui suit n'est pas incluse dans la mention", () => {
    assert.equal(defuseMentions("hé @bot, ça va ?"), "hé `@bot`, ça va ?");
  });

  test("texte sans mention reste inchangé", () => {
    assert.equal(defuseMentions("rien à signaler ici"), "rien à signaler ici");
  });

  test("chaîne vide reste vide", () => {
    assert.equal(defuseMentions(""), "");
  });

  // Corrigé (§5.6) : le « @ » doit démarrer la mention, pas suivre un
  // caractère alphanumérique — sans ce garde-fou, un fragment d'adresse mail
  // était lui aussi défusé ("foo@bar.com" → "foo`@bar.com`").
  test("une adresse mail n'est plus défigurée", () => {
    assert.equal(
      defuseMentions("contact : foo@bar.com"),
      "contact : foo@bar.com",
    );
  });

  test("une vraie mention juste après une adresse mail reste défusée", () => {
    assert.equal(
      defuseMentions("contact : foo@bar.com, cc @bob"),
      "contact : foo@bar.com, cc `@bob`",
    );
  });
});

describe("defuseMentions — quick actions", () => {
  test("une ligne qui commence par une quick action est neutralisée", () => {
    const result = defuseMentions("/close");
    // Le texte visible (une fois l'espace invisible ôté) est inchangé...
    assert.equal(result.replace(new RegExp(ZERO_WIDTH_SPACE, "g"), ""), "/close");
    // ...mais la ligne ne commence plus littéralement par "/".
    assert.ok(!result.startsWith("/"));
  });

  test("quick action précédée d'espaces (indentation) : toujours neutralisée", () => {
    const result = defuseMentions("  /assign bob");
    assert.equal(result.replace(new RegExp(ZERO_WIDTH_SPACE, "g"), ""), "  /assign bob");
    assert.ok(!/^\s*\//.test(result));
  });

  test("une seule ligne d'un message multi-lignes est concernée", () => {
    const input = "Bonne remarque.\n/merge\nSuite du message.";
    const result = defuseMentions(input);
    const lines = result.split("\n");
    assert.equal(lines[0], "Bonne remarque.");
    assert.ok(!lines[1]!.startsWith("/"));
    assert.equal(lines[1]!.replace(new RegExp(ZERO_WIDTH_SPACE, "g"), ""), "/merge");
    assert.equal(lines[2], "Suite du message.");
  });

  test("une mention au milieu d'une phrase, comme /api/users, reste intacte", () => {
    assert.equal(
      defuseMentions("Le point d'entrée /api/users renvoie 404 sans body."),
      "Le point d'entrée /api/users renvoie 404 sans body.",
    );
  });

  test("texte sans quick action ni mention reste inchangé", () => {
    assert.equal(
      defuseMentions("rien de spécial, juste du texte normal."),
      "rien de spécial, juste du texte normal.",
    );
  });
});
