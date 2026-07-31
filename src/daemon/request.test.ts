import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

// request.ts importe (transitivement, via gitlab/client.ts) src/config.ts,
// qui jette au chargement si GITLAB_TOKEN ou BOT_USERNAME sont absents de
// l'environnement. On les injecte avant l'import dynamique pour rester
// reproductible sans .env local (cf. review.test.ts pour la même astuce).
let defuseMentions: (text: string) => string;

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  ({ defuseMentions } = await import("./request.ts"));
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

  // Comportement actuel, non corrigé par cette tâche : la regex ne vérifie
  // pas qu'un « @ » est en début de mention (précédé d'un espace ou d'un
  // début de chaîne) — un fragment d'adresse mail est donc lui aussi défusé.
  test("un fragment d'adresse mail est aussi entouré de backticks", () => {
    assert.equal(
      defuseMentions("contact : foo@bar.com"),
      "contact : foo`@bar.com`",
    );
  });
});
