import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// implement.ts importe (transitivement) config.ts, qui jette au chargement
// si GITLAB_TOKEN/BOT_USERNAME sont absents. Même parade que
// workspace.test.ts : on renseigne l'environnement avant l'import dynamique
// du module testé.
let git: (repo: string, args: string[], authenticated?: boolean) => string;
let checkHeadIntegrity: (
  repo: string,
  branch: string,
) => { ok: true } | { ok: false; detail: string; files: string[] };

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  ({ git } = await import("../agent/workspace.ts"));
  ({ checkHeadIntegrity } = await import("./implement.ts"));
});

/** Un vrai dépôt git jetable, avec une remote "origin" bare locale — même
 * fixture que workspace.test.ts, dupliquée ici pour ne pas faire dépendre
 * ce fichier de test d'un autre fichier de test. */
function makeRepoWithOrigin(): {
  root: string;
  repo: string;
  origin: string;
} {
  const root = mkdtempSync(join(tmpdir(), "cds-agent-implement-test-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");

  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "seed@test.local"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "seed"]);
  writeFileSync(join(seed, "server.js"), "console.log('seed');\n");
  execFileSync("git", ["-C", seed, "add", "--all"]);
  execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "remote", "add", "origin", origin]);
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"]);

  const repo = join(root, "repo");
  execFileSync("git", ["clone", "--quiet", "--branch", "main", origin, repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "bot@test.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "bot"]);

  return { root, repo, origin };
}

function originCommitCount(origin: string): number {
  return Number(
    execFileSync("git", ["--git-dir", origin, "rev-list", "--count", "main"])
      .toString()
      .trim(),
  );
}

/** Simule ce que fait runImplement une fois checkHeadIntegrity passé :
 * add --all, commit du bot, push. */
function commitAndPushAsBot(repo: string, branch: string): void {
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "-m", "test: ajout de tests"]);
  git(repo, ["push", "origin", `HEAD:${branch}`], true);
}

describe("checkHeadIntegrity", () => {
  test("cas nominal : l'agent modifie sans commiter, le contrôle passe et le push atteint origin", () => {
    const { root, repo, origin } = makeRepoWithOrigin();
    try {
      // Agent honnête : fichier de test ajouté, rien commité.
      mkdirSync(join(repo, "tests"), { recursive: true });
      writeFileSync(join(repo, "tests", "foo.test.js"), "// test\n");

      const verdict = checkHeadIntegrity(repo, "main");
      assert.equal(verdict.ok, true);

      commitAndPushAsBot(repo, "main");
      assert.equal(originCommitCount(origin), 2, "seed + commit du bot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("le trou visé : l'agent modifie server.js ET commite lui-même — porcelain propre, mais rejet", () => {
    const { root, repo, origin } = makeRepoWithOrigin();
    try {
      // L'agent modifie le code source puis fait le commit lui-même :
      // exactement le contournement décrit dans la revue d'architecture.
      writeFileSync(join(repo, "server.js"), "console.log('pwned');\n");
      git(repo, ["add", "--all"]);
      git(repo, ["commit", "-m", "fix"]);

      // Le porcelain, lui, ne voit plus rien : c'est tout le problème.
      const porcelain = git(repo, ["status", "--porcelain=v1", "-uall"]);
      assert.equal(porcelain.trim(), "");

      const verdict = checkHeadIntegrity(repo, "main");
      assert.equal(verdict.ok, false);
      if (!verdict.ok) {
        assert.match(verdict.detail, /historique a été modifié/);
        assert.deepEqual(verdict.files, ["server.js"]);
      }

      // Rien ne doit avoir été poussé : la remote reste à son état initial.
      assert.equal(originCommitCount(origin), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("l'agent commite un fichier de test légitime : rejeté quand même — le daemon reste seul committeur", () => {
    const { root, repo, origin } = makeRepoWithOrigin();
    try {
      // Contenu parfaitement dans le périmètre (tests/ uniquement), mais
      // c'est l'agent qui a créé le commit, pas le daemon.
      mkdirSync(join(repo, "tests"), { recursive: true });
      writeFileSync(join(repo, "tests", "foo.test.js"), "// test\n");
      git(repo, ["add", "--all"]);
      git(repo, ["commit", "-m", "ajout de tests"]);

      const verdict = checkHeadIntegrity(repo, "main");
      assert.equal(
        verdict.ok,
        false,
        "même un commit inoffensif dans son contenu doit être rejeté : seul le daemon commite",
      );
      if (!verdict.ok) {
        assert.deepEqual(verdict.files, ["tests/foo.test.js"]);
      }

      assert.equal(originCommitCount(origin), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("HEAD déplacé (reset --hard sur un ancêtre) : rejeté", () => {
    const { root, repo, origin } = makeRepoWithOrigin();
    try {
      // Un deuxième commit légitime existe déjà sur origin/main (poussé
      // avant que l'agent n'entre en scène) ; l'agent revient en arrière.
      mkdirSync(join(repo, "tests"), { recursive: true });
      writeFileSync(join(repo, "tests", "existing.test.js"), "// x\n");
      git(repo, ["add", "--all"]);
      git(repo, ["commit", "-m", "test: préexistant"]);
      git(repo, ["push", "origin", "HEAD:main"], true);
      git(repo, ["fetch", "origin", "main"], true);

      // L'agent, une fois dans le conteneur, revient au commit "seed".
      git(repo, ["reset", "--hard", "HEAD~1"]);

      const verdict = checkHeadIntegrity(repo, "main");
      assert.equal(verdict.ok, false);

      assert.equal(
        originCommitCount(origin),
        2,
        "le commit préexistant a bien été poussé, rien de plus ne doit l'être",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("origin/<branch> local falsifié (update-ref) ne trompe pas le contrôle : le fetch fait foi", () => {
    const { root, repo, origin } = makeRepoWithOrigin();
    try {
      writeFileSync(join(repo, "server.js"), "console.log('pwned');\n");
      git(repo, ["add", "--all"]);
      git(repo, ["commit", "-m", "fix"]);

      // L'agent essaie de maquiller la référence locale pour qu'elle
      // pointe déjà sur son propre HEAD truqué.
      const forgedHead = git(repo, ["rev-parse", "HEAD"]).trim();
      git(repo, ["update-ref", "refs/remotes/origin/main", forgedHead]);

      // Sans re-fetch, la comparaison locale serait trompée. Le contrôle
      // re-fetche depuis la vraie remote et n'est donc pas dupe.
      const verdict = checkHeadIntegrity(repo, "main");
      assert.equal(verdict.ok, false);

      assert.equal(originCommitCount(origin), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("un push concurrent d'un tiers est rejeté, mais sans accuser l'agent d'avoir réécrit l'historique", () => {
    const { root, repo, origin } = makeRepoWithOrigin();
    try {
      // Agent honnête : il ne commite rien.
      mkdirSync(join(repo, "tests"), { recursive: true });
      writeFileSync(join(repo, "tests", "foo.test.js"), "// test\n");

      // Pendant ce temps, un collègue pousse sur la branche source. HEAD
      // n'a pas bougé mais devient un ancêtre de la référence distante.
      const other = join(root, "other");
      execFileSync("git", ["clone", "--quiet", "--branch", "main", origin, other]);
      execFileSync("git", ["-C", other, "config", "user.email", "dev@test.local"]);
      execFileSync("git", ["-C", other, "config", "user.name", "dev"]);
      writeFileSync(join(other, "server.js"), "console.log('collegue');\n");
      execFileSync("git", ["-C", other, "commit", "--quiet", "-am", "wip"]);
      execFileSync("git", ["-C", other, "push", "--quiet", "origin", "main"]);

      const verdict = checkHeadIntegrity(repo, "main");
      assert.equal(verdict.ok, false, "rien ne doit être poussé sur un HEAD périmé");

      // Le fond du test : le message doit parler d'une branche mise à jour,
      // pas d'une manipulation d'historique.
      assert.ok(verdict.ok === false && /mise à jour pendant le traitement/.test(verdict.detail));
      assert.ok(verdict.ok === false && !/historique a été modifié/.test(verdict.detail));

      assert.equal(originCommitCount(origin), 2, "seed + commit du collègue, rien du bot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
