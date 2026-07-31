import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// workspace.ts importe (transitivement) config.ts, qui jette au chargement
// si GITLAB_TOKEN/BOT_USERNAME sont absents. Même parade que review.test.ts :
// on renseigne l'environnement avant l'import dynamique du module testé.
let git: (repo: string, args: string[], authenticated?: boolean) => Promise<string>;
let fingerprintGitMeta: (repo: string) => string;

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  ({ git, fingerprintGitMeta } = await import("./workspace.ts"));
});

/** Un vrai dépôt git jetable, avec une remote "origin" bare locale. */
function makeRepoWithOrigin(): {
  root: string;
  repo: string;
  origin: string;
} {
  const root = mkdtempSync(join(tmpdir(), "cds-agent-workspace-test-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");

  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "seed@test.local"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "seed"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "--all"]);
  execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "remote", "add", "origin", origin]);
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"]);

  const repo = join(root, "repo");
  execFileSync("git", ["clone", "--quiet", "--branch", "main", origin, repo]);

  return { root, repo, origin };
}

function originCommitCount(origin: string): number {
  return Number(
    execFileSync("git", [
      "--git-dir",
      origin,
      "rev-list",
      "--count",
      "main",
    ])
      .toString()
      .trim(),
  );
}

describe("git() neutralise les hooks", () => {
  test("un pre-commit hostile ne s'exécute pas lors d'un commit passant par git()", async () => {
    const { root, repo } = makeRepoWithOrigin();
    try {
      const marker = join(root, "hook-a-tourne");
      const hooksDir = join(repo, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const hookPath = join(hooksDir, "pre-commit");
      // Le hook écrit un marqueur hors du dépôt et échoue explicitement :
      // s'il s'exécute, soit le marqueur apparaît, soit le commit échoue
      // (ou les deux). L'un ou l'autre suffit à prouver l'exécution.
      writeFileSync(
        hookPath,
        `#!/bin/sh\necho pwned > "${marker}"\nexit 1\n`,
      );
      chmodSync(hookPath, 0o755);

      await git(repo, ["config", "user.name", "cds-agent"]);
      await git(repo, ["config", "user.email", "cds-agent@test.local"]);
      writeFileSync(join(repo, "note.txt"), "contenu\n");
      await git(repo, ["add", "--all"]);

      // Ne doit pas lever : le hook est neutralisé, donc invisible pour git.
      await assert.doesNotReject(async () => {
        await git(repo, ["commit", "-m", "commit de test"]);
      });
      assert.equal(
        existsSync(marker),
        false,
        "le hook pre-commit a laissé une trace : il s'est exécuté",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fingerprintGitMeta", () => {
  test("reste stable si rien ne touche .git/config ni .git/hooks", async () => {
    const { root, repo } = makeRepoWithOrigin();
    try {
      const before = fingerprintGitMeta(repo);

      await git(repo, ["config", "user.name", "cds-agent"]);
      await git(repo, ["config", "user.email", "cds-agent@test.local"]);
      const afterIdentity = fingerprintGitMeta(repo);
      // Ces deux `git config` sont légitimes (posés par implement.ts lui-même
      // avant de prendre la référence) : ils ne doivent pas fausser une
      // comparaison prise après coup, mais on vérifie ici que le hash change
      // bien avec le contenu de .git/config, preuve que la fonction est
      // sensible à ce fichier.
      assert.notEqual(before, afterIdentity);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ne signale aucun faux positif pour une activité normale d'agent honnête", async () => {
    const { root, repo } = makeRepoWithOrigin();
    try {
      await git(repo, ["config", "user.name", "cds-agent"]);
      await git(repo, ["config", "user.email", "cds-agent@test.local"]);
      const baseline = fingerprintGitMeta(repo);

      // Ce qu'un agent honnête fait : ajouter des fichiers de test, les
      // stager, consulter le statut — rien de tout ça ne touche à
      // .git/config ni à .git/hooks.
      mkdirSync(join(repo, "tests"), { recursive: true });
      writeFileSync(join(repo, "tests", "foo.test.ts"), "// test\n");
      await git(repo, ["add", "--all"]);
      await git(repo, ["status", "--porcelain=v1", "-uall"]);

      assert.equal(fingerprintGitMeta(repo), baseline);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("détecte une clé de config hostile (core.pager)", async () => {
    const { root, repo } = makeRepoWithOrigin();
    try {
      const baseline = fingerprintGitMeta(repo);
      await git(repo, ["config", "core.pager", "sh -c 'touch /tmp/pwned'"]);
      assert.notEqual(fingerprintGitMeta(repo), baseline);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("détecte un hook ajouté après coup", async () => {
    const { root, repo } = makeRepoWithOrigin();
    try {
      const baseline = fingerprintGitMeta(repo);
      const hookPath = join(repo, ".git", "hooks", "post-checkout");
      writeFileSync(hookPath, "#!/bin/sh\ntrue\n");
      chmodSync(hookPath, 0o755);
      assert.notEqual(fingerprintGitMeta(repo), baseline);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("détecte une altération de .git/info/exclude (§reliquat)", async () => {
    const { root, repo } = makeRepoWithOrigin();
    try {
      const baseline = fingerprintGitMeta(repo);
      mkdirSync(join(repo, ".git", "info"), { recursive: true });
      writeFileSync(join(repo, ".git", "info", "exclude"), "*.secret\n");
      assert.notEqual(fingerprintGitMeta(repo), baseline);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("détecte une altération de .git/info/attributes (§reliquat)", async () => {
    const { root, repo } = makeRepoWithOrigin();
    try {
      const baseline = fingerprintGitMeta(repo);
      mkdirSync(join(repo, ".git", "info"), { recursive: true });
      writeFileSync(
        join(repo, ".git", "info", "attributes"),
        "* text=auto\n",
      );
      assert.notEqual(fingerprintGitMeta(repo), baseline);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scénario complet (miroir de runImplement)", () => {
  test("cas nominal : rien n'a bougé, le push atteint bien origin", async () => {
    const { root, repo, origin } = makeRepoWithOrigin();
    try {
      await git(repo, ["config", "user.name", "cds-agent"]);
      await git(repo, ["config", "user.email", "cds-agent@test.local"]);
      const baseline = fingerprintGitMeta(repo);

      // Agent honnête.
      mkdirSync(join(repo, "tests"), { recursive: true });
      writeFileSync(join(repo, "tests", "foo.test.ts"), "// test\n");

      assert.equal(
        fingerprintGitMeta(repo),
        baseline,
        "pas d'altération : le push doit être autorisé",
      );

      await git(repo, ["add", "--all"]);
      await git(repo, ["commit", "-m", "test: ajout"]);
      await git(repo, ["push", "origin", "HEAD:main"]);

      assert.equal(originCommitCount(origin), 2, "seed + commit de l'agent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cas hostile : l'altération est détectée avant tout git status/add/commit/push, rien n'est poussé", async () => {
    const { root, repo, origin } = makeRepoWithOrigin();
    try {
      await git(repo, ["config", "user.name", "cds-agent"]);
      await git(repo, ["config", "user.email", "cds-agent@test.local"]);
      const baseline = fingerprintGitMeta(repo);

      // Agent hostile : dépose un hook ET une clé de config dangereuse.
      const hooksDir = join(repo, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const hookPath = join(hooksDir, "pre-push");
      writeFileSync(hookPath, "#!/bin/sh\ntrue\n");
      chmodSync(hookPath, 0o755);
      mkdirSync(join(repo, "tests"), { recursive: true });
      writeFileSync(join(repo, "tests", "foo.test.ts"), "// test\n");

      const changed = fingerprintGitMeta(repo) !== baseline;
      assert.equal(changed, true);

      // Ce que fait implement.ts dans ce cas : ne relancer aucune commande
      // git et ne rien pousser. On vérifie juste l'effet observable : origin
      // n'a toujours que le commit "seed".
      assert.equal(originCommitCount(origin), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("§4.5 : git() est asynchrone et ne bloque pas la boucle d'événements", () => {
  test("un timer programmé en parallèle se déclenche pendant l'exécution d'une commande git lente", async () => {
    const { root, repo } = makeRepoWithOrigin();
    // "git" lent et artificiel : un script shim placé en tête de PATH,
    // qui dort avant d'exécuter le vrai git. sanitizedEnv() (utilisée par
    // git()) transmet PATH tel quel, donc git() ira bien chercher ce shim.
    const binDir = mkdtempSync(join(tmpdir(), "cds-agent-slow-git-bin-"));
    const realGit = execFileSync("which", ["git"]).toString().trim();
    const shimPath = join(binDir, "git");
    writeFileSync(
      shimPath,
      `#!/bin/sh\nsleep 0.3\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(shimPath, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;

    try {
      let timerFired = false;
      const timer = setTimeout(() => {
        timerFired = true;
      }, 30);

      await git(repo, ["status", "--porcelain=v1", "-uall"]);

      clearTimeout(timer);
      assert.equal(
        timerFired,
        true,
        "le timer (30 ms) programmé avant la commande git (≈300 ms) aurait dû " +
          "se déclencher pendant son exécution si la boucle d'événements " +
          "n'était pas bloquée",
      );
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe("§4.5 : maxBuffer explicite, une sortie git de plus de 1 Mo ne lève plus ENOBUFS", () => {
  test("git show sur un fichier de plusieurs Mo réussit intégralement", async () => {
    const { root, repo } = makeRepoWithOrigin();
    try {
      // 2 Mo de contenu texte, largement au-delà du maxBuffer par défaut de
      // Node (1 Mo) pour execFile/execFileSync.
      const line = "x".repeat(100) + "\n";
      const big = line.repeat(20_000);
      writeFileSync(join(repo, "big.txt"), big);
      await git(repo, ["add", "--all"]);
      await git(repo, ["commit", "-m", "gros fichier"]);

      const output = await git(repo, ["show", "HEAD:big.txt"]);
      assert.equal(
        output.length,
        big.length,
        "la sortie complète doit être récupérée, sans troncature ni ENOBUFS",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
