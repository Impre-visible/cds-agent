import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// sandbox.ts importe (transitivement) config.ts, qui jette au chargement si
// GITLAB_TOKEN/BOT_USERNAME sont absents. Même parade que workspace.test.ts
// et review.test.ts : on renseigne l'environnement avant l'import dynamique
// du module testé.
let buildDockerRunArgs: (
  repo: string,
  image: string,
  command: string,
  containerName: string,
  options?: {
    network?: boolean;
    hostGateway?: boolean;
    env?: Record<string, string>;
    mounts?: { host: string; container: string }[];
  },
) => string[];
let runInSandbox: (
  repo: string,
  image: string,
  command: string,
  options?: {
    network?: boolean;
    hostGateway?: boolean;
    env?: Record<string, string>;
    mounts?: { host: string; container: string }[];
    timeoutMs?: number;
    dockerBin?: string;
  },
) => Promise<{
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
}>;

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  ({ buildDockerRunArgs, runInSandbox } = await import("./sandbox.ts"));
});

describe("buildDockerRunArgs", () => {
  test("porte un --name unique, l'isolation réseau par défaut, et la commande finale", () => {
    const args = buildDockerRunArgs(
      "/repo",
      "node:22",
      "npm test",
      "cds-abc123",
    );

    assert.deepEqual(args.slice(0, 4), ["run", "--rm", "--name", "cds-abc123"]);
    assert.deepEqual(
      args.slice(args.indexOf("--network"), args.indexOf("--network") + 2),
      ["--network", "none"],
    );
    assert.deepEqual(args.slice(-4), ["node:22", "bash", "-c", "npm test"]);
  });

  test("network: true bascule sur le réseau bridge", () => {
    const args = buildDockerRunArgs("/repo", "node:22", "npm test", "cds-x", {
      network: true,
    });
    assert.deepEqual(
      args.slice(args.indexOf("--network"), args.indexOf("--network") + 2),
      ["--network", "bridge"],
    );
  });

  test("les montages supplémentaires sont en lecture seule", () => {
    const args = buildDockerRunArgs("/repo", "node:22", "npm test", "cds-x", {
      mounts: [{ host: "/host/meta", container: "/task" }],
    });
    assert.ok(args.includes("/host/meta:/task:ro"));
  });

  test("les variables d'environnement demandées sont passées en -e", () => {
    const args = buildDockerRunArgs("/repo", "node:22", "npm test", "cds-x", {
      env: { FOO: "bar" },
    });
    assert.ok(args.includes("FOO=bar"));
  });

  test("hostGateway ajoute --add-host uniquement si demandé", () => {
    const without = buildDockerRunArgs("/repo", "node:22", "npm test", "cds-x");
    assert.ok(!without.includes("--add-host"));

    const withGateway = buildDockerRunArgs(
      "/repo",
      "node:22",
      "npm test",
      "cds-x",
      { hostGateway: true },
    );
    const i = withGateway.indexOf("--add-host");
    assert.notEqual(i, -1);
    assert.equal(withGateway[i + 1], "host.docker.internal:host-gateway");
  });
});

/**
 * Faux binaire "docker" pour tester runInSandbox sans docker réel :
 * - `docker kill <name>` dépose un fichier marqueur et sort en succès.
 * - `docker run ... <name> ... bash -c <command>` :
 *   - si la commande contient CDS_TEST_HANG, la simulation d'un conteneur
 *     qui ne se termine jamais tant qu'il n'a pas été tué : elle boucle en
 *     attendant le marqueur déposé par `docker kill`, puis sort avec le code
 *     137 (SIGKILL), comme le ferait un vrai `docker run` sur un conteneur tué.
 *   - sinon elle sort immédiatement avec le code 0.
 * Le répertoire des marqueurs est passé par variable d'environnement (le
 * process docker hérite de process.env, comme le vrai binaire).
 */
function writeFakeDocker(dir: string): string {
  const path = join(dir, "fake-docker.sh");
  writeFileSync(
    path,
    `#!/bin/bash
if [ "$1" = "kill" ]; then
  touch "$FAKE_DOCKER_MARKER_DIR/killed-$2"
  echo "killed $2"
  exit 0
fi

if [ "$1" != "run" ]; then
  echo "sous-commande docker non geree par le faux binaire : $1" >&2
  exit 1
fi

name=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--name" ]; then name="$arg"; fi
  prev="$arg"
done

payload="\${@: -1}"

case "$payload" in
  *CDS_TEST_HANG*)
    marker="$FAKE_DOCKER_MARKER_DIR/killed-$name"
    for i in $(seq 1 200); do
      if [ -f "$marker" ]; then
        echo "container $name tue"
        exit 137
      fi
      sleep 0.05
    done
    exit 0
    ;;
  *)
    echo "ok: $payload"
    exit 0
    ;;
esac
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("runInSandbox", () => {
  let dir: string;
  let dockerBin: string;
  let previousMarkerDir: string | undefined;
  let markerDir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cds-agent-fake-docker-"));
    markerDir = mkdtempSync(join(tmpdir(), "cds-agent-fake-docker-markers-"));
    dockerBin = writeFakeDocker(dir);
    previousMarkerDir = process.env.FAKE_DOCKER_MARKER_DIR;
    process.env.FAKE_DOCKER_MARKER_DIR = markerDir;
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
    if (previousMarkerDir === undefined) delete process.env.FAKE_DOCKER_MARKER_DIR;
    else process.env.FAKE_DOCKER_MARKER_DIR = previousMarkerDir;
  });

  test("cas nominal : le conteneur se termine seul, timedOut reste false et le vrai code de sortie remonte", async () => {
    const result = await runInSandbox("/repo", "node:22", "echo hello", {
      dockerBin,
    });
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0);
    assert.equal(result.ok, true);
    assert.match(result.output, /ok: echo hello/);
  });

  test("au timeout, le conteneur est tué via 'docker kill <nom>' (pas seulement le client) et timedOut remonte à true", async () => {
    const result = await runInSandbox("/repo", "node:22", "CDS_TEST_HANG", {
      dockerBin,
      timeoutMs: 100,
    });
    assert.equal(result.timedOut, true);
    // Le "conteneur" (faux) est sorti avec 137 (SIGKILL) parce qu'il a vu
    // le marqueur déposé par `docker kill <nom>` — la preuve que c'est bien
    // le conteneur qui a été ciblé, pas seulement le client docker run tué
    // en aveugle.
    assert.equal(result.code, 137);
    assert.equal(result.ok, false);
  });
});
