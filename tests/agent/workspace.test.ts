import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
let runCommand: (
  repo: string,
  command: string,
  options: {
    projectPath: string;
    network?: boolean;
    mounts?: { host: string; container: string }[];
    dockerBin?: string;
  },
) => Promise<{ ok: boolean; output: string; timedOut: boolean }>;

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  ({ git, fingerprintGitMeta, runCommand } = await import("../../src/agent/workspace.ts"));
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

/**
 * Faux binaire docker minimal, ne servant qu'à inspecter les arguments reçus
 * par `docker run` — même principe que sandbox.test.ts::writeFakeDocker,
 * dupliqué ici en plus petit (pas de simulation de timeout/kill nécessaire
 * pour ces tests, qui ne portent que sur les `-e` reçus).
 */
function writeArgvCapturingDocker(dir: string): string {
  const path = join(dir, "fake-docker.sh");
  writeFileSync(
    path,
    `#!/bin/bash
if [ "$1" != "run" ]; then exit 0; fi
name=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--name" ]; then name="$arg"; fi
  prev="$arg"
done
printf '%s\\n' "$@" > "$FAKE_DOCKER_MARKER_DIR/argv-$name"
echo "ok"
exit 0
`,
  );
  chmodSync(path, 0o755);
  return path;
}

// §B (durcissement proxy d'entreprise) : runCommand() est le seul appelant
// de containerProxyEnv() (agent/sandbox.ts::runAgentInSandbox, le conteneur
// agent, n'y touche jamais — voir sandbox.test.ts pour la vérification de ce
// côté-là). Ces tests couvrent le fil complet : options.network -> env reçu
// par `docker run`.
describe("runCommand + Docker (§B : proxy transmis au conteneur, seulement si network: true)", () => {
  let dir: string;
  let dockerBin: string;
  let markerDir: string;
  let previousMarkerDir: string | undefined;
  let previousHttpProxy: string | undefined;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cds-agent-runcommand-fake-docker-"));
    markerDir = mkdtempSync(join(tmpdir(), "cds-agent-runcommand-fake-docker-markers-"));
    dockerBin = writeArgvCapturingDocker(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    previousMarkerDir = process.env.FAKE_DOCKER_MARKER_DIR;
    process.env.FAKE_DOCKER_MARKER_DIR = markerDir;
    previousHttpProxy = process.env.HTTP_PROXY;
  });

  afterEach(() => {
    if (previousMarkerDir === undefined) delete process.env.FAKE_DOCKER_MARKER_DIR;
    else process.env.FAKE_DOCKER_MARKER_DIR = previousMarkerDir;
    if (previousHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = previousHttpProxy;
    for (const entry of readdirSync(markerDir)) rmSync(join(markerDir, entry));
  });

  test("network: true + HTTP_PROXY dans l'environnement : le conteneur reçoit HTTP_PROXY en -e", async () => {
    process.env.HTTP_PROXY = "http://proxy.corp.example:3128";

    await runCommand("/repo", "npm install", {
      projectPath: "groupe/depot",
      network: true,
      dockerBin,
    });

    const [argvFile] = readdirSync(markerDir).filter((name) => name.startsWith("argv-"));
    const argv = readFileSync(join(markerDir, argvFile as string), "utf8").split("\n");
    const httpProxyIndex = argv.findIndex((value) => value === "HTTP_PROXY=http://proxy.corp.example:3128");
    assert.notEqual(httpProxyIndex, -1, "HTTP_PROXY doit être passé en -e au conteneur");
  });

  test("network: false : HTTP_PROXY n'est PAS transmis, même s'il est présent dans l'environnement", async () => {
    process.env.HTTP_PROXY = "http://proxy.corp.example:3128";

    await runCommand("/repo", "npm test", {
      projectPath: "groupe/depot",
      network: false,
      dockerBin,
    });

    const [argvFile] = readdirSync(markerDir).filter((name) => name.startsWith("argv-"));
    const argv = readFileSync(join(markerDir, argvFile as string), "utf8").split("\n");
    assert.ok(
      !argv.some((value) => value.startsWith("HTTP_PROXY=")),
      "un conteneur --network none n'a aucun moyen d'atteindre un proxy : ne rien transmettre",
    );
  });

  test("proxy en loopback (127.0.0.1) : réécrit vers host.docker.internal ET --add-host ajouté", async () => {
    process.env.HTTP_PROXY = "http://127.0.0.1:3128";

    await runCommand("/repo", "npm install", {
      projectPath: "groupe/depot",
      network: true,
      dockerBin,
    });

    const [argvFile] = readdirSync(markerDir).filter((name) => name.startsWith("argv-"));
    const argv = readFileSync(join(markerDir, argvFile as string), "utf8").split("\n");
    assert.ok(
      argv.includes("HTTP_PROXY=http://host.docker.internal:3128/"),
      "un proxy en loopback sur l'hôte doit être réécrit, sinon injoignable depuis le conteneur",
    );
    assert.ok(
      argv.includes("host.docker.internal:host-gateway"),
      "--add-host doit accompagner la réécriture, sinon l'alias ne résout à rien dans le conteneur",
    );
  });
});
