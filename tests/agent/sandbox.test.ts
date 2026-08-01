import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    user?: string;
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
    user?: string;
  },
) => Promise<{
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
}>;
let permissionsFor: (mode: "review" | "implement") => Record<string, string>;
let currentContainer: () => string | undefined;
let killContainer: (name: string, dockerBin?: string) => Promise<void>;
let hostUser: () => string | undefined;
let runAgentInSandbox: (
  repo: string,
  meta: string,
  projectPath: string,
  options?: { dockerBin?: string },
) => Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}>;

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  ({
    buildDockerRunArgs,
    runInSandbox,
    permissionsFor,
    currentContainer,
    killContainer,
    hostUser,
    runAgentInSandbox,
  } = await import("../../src/agent/sandbox.ts"));
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

  // --user <uid hôte> désigne un utilisateur absent de /etc/passwd : Docker
  // pose alors HOME=/, que --read-only rend non inscriptible. `npm install`
  // échouait sur mkdir '/.npm' avant même l'exécution de l'agent — mesuré, et
  // reproduit avec une image amont.
  describe("HOME et caches (contrepartie obligatoire de --user)", () => {
    test("HOME et les caches pointent sous /tmp, seul inscriptible sous --read-only", () => {
      const args = buildDockerRunArgs("/repo", "node:22", "npm test", "cds-x");
      for (const expected of [
        "HOME=/tmp/agent",
        "XDG_CONFIG_HOME=/tmp/agent/.config",
        "XDG_DATA_HOME=/tmp/agent/.local/share",
        "XDG_CACHE_HOME=/tmp/agent/.cache",
        "npm_config_cache=/tmp/.npm",
      ]) {
        assert.ok(args.includes(expected), `${expected} doit être passé en -e`);
      }
    });

    test("ces valeurs valent pour TOUTE image, y compris une image amont sans convention maison", () => {
      // projects.example.json donne "node:22-bookworm-slim" en défaut : une
      // image qui n'aura jamais le bloc ENV des Dockerfiles de ce dépôt.
      const args = buildDockerRunArgs(
        "/repo",
        "node:22-bookworm-slim",
        "npm install",
        "cds-x",
      );
      assert.ok(args.includes("HOME=/tmp/agent"));
      assert.ok(args.includes("npm_config_cache=/tmp/.npm"));
    });

    test("un appelant garde le dernier mot : son -e est passé APRÈS, donc l'emporte pour docker", () => {
      const args = buildDockerRunArgs("/repo", "node:22", "npm test", "cds-x", {
        env: { HOME: "/tmp/ailleurs" },
      });
      assert.ok(
        args.lastIndexOf("HOME=/tmp/ailleurs") > args.indexOf("HOME=/tmp/agent"),
        "la valeur de l'appelant doit venir après celle par défaut",
      );
    });
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

  // §4.3 — le Dockerfile promet un conteneur qui tourne "sous l'uid de
  // l'hôte via --user" ; jusqu'à ce correctif, runInSandbox ne le passait
  // jamais et le conteneur agent tournait donc en root.
  describe("--user (§4.3 : le conteneur ne doit pas tourner en root)", () => {
    test("valeur explicite : passée telle quelle à --user", () => {
      const args = buildDockerRunArgs("/repo", "node:22", "npm test", "cds-x", {
        user: "1234:5678",
      });
      const i = args.indexOf("--user");
      assert.notEqual(i, -1, "--user doit être présent");
      assert.equal(args[i + 1], "1234:5678");
    });

    test("par défaut (pas de user explicite) : l'uid/gid réels du process hôte, pas root", () => {
      const args = buildDockerRunArgs("/repo", "node:22", "npm test", "cds-x");
      const expected = hostUser();
      const i = args.indexOf("--user");
      if (expected === undefined) {
        // Plateforme sans uid POSIX (Windows) : --user est omis, pas de régression.
        assert.equal(i, -1);
      } else {
        assert.notEqual(i, -1, "--user doit être présent par défaut");
        assert.equal(args[i + 1], expected);
        // Jamais 0 (root) sur une machine de dev/CI Unix normale : si ce
        // test tourne en tant que root (rare, mais possible en conteneur CI
        // lui-même), il documente au moins que ce n'est pas silencieux.
      }
    });
  });

  // §4.4 — durcissement du docker run : présents avant ce correctif
  // (--cap-drop, no-new-privileges, --pids-limit, --memory/--cpus,
  // --network none par défaut) mais incomplets. On ajoute --read-only (avec
  // les --tmpfs nécessaires à l'écriture réelle), --ulimit nofile, et un
  // profil seccomp explicite.
  describe("durcissement §4.4", () => {
    test("--read-only est présent", () => {
      const args = buildDockerRunArgs("/repo", "node:22", "npm test", "cds-x");
      assert.ok(args.includes("--read-only"));
    });

    test("--tmpfs monte /tmp en écriture avec une limite de taille (rw + size=)", () => {
      const args = buildDockerRunArgs("/repo", "node:22", "npm test", "cds-x");
      const i = args.indexOf("--tmpfs");
      assert.notEqual(i, -1, "--tmpfs doit être présent");
      const value = args[i + 1] ?? "";
      assert.match(value, /^\/tmp:/, "doit monter /tmp, où vivent le cache npm et HOME de l'agent");
      assert.match(value, /[:,]rw(,|$)/, "doit rester inscriptible malgré --read-only");
      assert.match(value, /size=/, "doit borner ce qu'un conteneur peut y écrire");
    });

    test("--ulimit nofile est présent", () => {
      const args = buildDockerRunArgs("/repo", "node:22", "npm test", "cds-x");
      const i = args.indexOf("--ulimit");
      assert.notEqual(i, -1);
      assert.match(args[i + 1] ?? "", /^nofile=\d+:\d+$/);
    });

    test("aucune option seccomp n'est passée : c'est ainsi qu'on obtient le profil par défaut", () => {
      // Régression réelle : une version précédente passait
      // `--security-opt seccomp=default` en croyant « documenter
      // l'intention ». Docker attend après `seccomp=` un CHEMIN de fichier
      // de profil ou le littéral `unconfined` ; « default » n'existe pas, et
      // `docker run` sortait en 125 sans jamais démarrer de conteneur.
      // Le test d'alors vérifiait que l'option était présente — il est resté
      // vert pendant que rien ne fonctionnait, parce qu'il contrôlait la
      // forme de l'argument sans que rien ne vérifie que Docker l'accepte.
      const args = buildDockerRunArgs("/repo", "node:22", "npm test", "cds-x");
      const securityOpts = args
        .map((value, index) => (args[index - 1] === "--security-opt" ? value : undefined))
        .filter((value): value is string => value !== undefined);
      assert.ok(securityOpts.includes("no-new-privileges"));
      assert.equal(
        securityOpts.some((opt) => opt.startsWith("seccomp")),
        false,
        "ne rien passer applique le profil seccomp par défaut ; toute valeur ici doit être un chemin de profil réellement existant",
      );
    });

    test("--read-only + --tmpfs n'empêchent pas le montage du dépôt en écriture (pas de :ro sur /repo)", () => {
      const args = buildDockerRunArgs("/repo", "node:22", "npm test", "cds-x");
      const i = args.indexOf("-v");
      assert.notEqual(i, -1);
      assert.equal(
        args[i + 1],
        "/repo:/repo",
        "le dépôt doit rester monté sans :ro : l'agent et npm install doivent pouvoir y écrire",
      );
    });
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

# Dépose l'intégralité des arguments reçus (un par ligne), pour les tests
# qui doivent inspecter au-delà du seul payload final (ex. les variables
# -e passées, --add-host, --network...) — voir runAgentInSandbox ci-dessous.
printf '%s\\n' "$@" > "$FAKE_DOCKER_MARKER_DIR/argv-$name"

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

  describe("currentContainer() / killContainer() — nettoyage à l'arrêt (voir index.ts)", () => {
    test("currentContainer() suit le conteneur en cours, puis se libère à sa fin", async () => {
      assert.equal(
        currentContainer(),
        undefined,
        "rien ne tourne avant le démarrage du test",
      );

      const run = runInSandbox("/repo", "node:22", "CDS_TEST_HANG", {
        dockerBin,
        timeoutMs: 5_000,
      });

      // Laisse le temps au faux "docker run" de démarrer avant de lire le nom.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const name = currentContainer();
      assert.ok(
        name?.startsWith("cds-"),
        "le nom suit le format cds-<uuid> (commit 2baa0be), qui rend le conteneur identifiable pour un nettoyage ciblé",
      );

      // Reproduit ce que ferait index.ts au nettoyage forcé : tuer par nom
      // plutôt que d'attendre le timeout interne de runInSandbox.
      await killContainer(name as string, dockerBin);
      await run;

      assert.equal(
        currentContainer(),
        undefined,
        "le slot doit être libéré une fois le conteneur terminé, sinon un nettoyage suivant ciblerait un nom périmé",
      );
    });

    test("killContainer() ne lève jamais, même vers un binaire docker inexistant", async () => {
      await assert.doesNotReject(() =>
        killContainer("cds-inexistant", "/chemin/vers/rien"),
      );
    });
  });
});

// Campagne de mesure du 1er août 2026 : le §1.8 annonçait une revue « en
// lecture seule (outils d'écriture bloqués) » alors que rien ne les
// bloquait. Deux modèles sur treize s'en sont servis (un Edit sur le code
// relu, un npm install + npm test).
describe("permissionsFor (la revue doit être réellement en lecture seule)", () => {
  test("mode review : edit, bash et webfetch sont refusés", () => {
    const permissions = permissionsFor("review");
    assert.equal(permissions.edit, "deny");
    assert.equal(permissions.bash, "deny");
    assert.equal(permissions.webfetch, "deny");
  });

  test("mode review : read/glob/grep ne sont jamais refusés — l'exploration reste la valeur d'une revue", () => {
    const permissions = permissionsFor("review");
    for (const tool of ["read", "glob", "grep", "list"]) {
      assert.notEqual(
        permissions[tool],
        "deny",
        `${tool} doit rester autorisé (non nommé = autorisé par défaut côté opencode)`,
      );
    }
  });

  test("mode implement : edit et bash sont accordés (écrire les tests, lancer la suite)", () => {
    const permissions = permissionsFor("implement");
    assert.equal(permissions.edit, "allow");
    assert.equal(permissions.bash, "allow");
    // Le réseau bridge existe déjà pour joindre le proxy d'inférence ; y
    // ajouter un outil de récupération distante n'a aucun usage légitime.
    assert.equal(permissions.webfetch, "deny");
  });
});

// §1.7 — le conteneur agent ne doit connaître qu'un seul endpoint réseau
// utile (l'inférence), pas une route ouverte vers host.docker.internal (donc
// vers tous les ports de l'hôte). runAgentInSandbox démarre désormais un
// proxy filtrant local (voir tools/proxy.ts) et ne configure l'agent
// qu'avec l'adresse de ce proxy.
describe("runAgentInSandbox (§1.7 : réseau restreint à l'inférence)", () => {
  let dir: string;
  let dockerBin: string;
  let markerDir: string;
  let previousMarkerDir: string | undefined;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cds-agent-fake-docker-agent-"));
    markerDir = mkdtempSync(
      join(tmpdir(), "cds-agent-fake-docker-agent-markers-"),
    );
    dockerBin = writeFakeDocker(dir);
    previousMarkerDir = process.env.FAKE_DOCKER_MARKER_DIR;
    process.env.FAKE_DOCKER_MARKER_DIR = markerDir;
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
    if (previousMarkerDir === undefined)
      delete process.env.FAKE_DOCKER_MARKER_DIR;
    else process.env.FAKE_DOCKER_MARKER_DIR = previousMarkerDir;
  });

  test("le conteneur reçoit l'adresse du proxy local (host.docker.internal:<port du proxy>), " +
    "jamais directement l'upstream réel", async () => {
    const metaDir = mkdtempSync(join(tmpdir(), "cds-agent-meta-"));
    writeFileSync(join(metaDir, "prompt.txt"), "prompt de test", "utf8");

    try {
      const result = await runAgentInSandbox("/repo", metaDir, "groupe/depot", {
        dockerBin,
      });
      assert.equal(result.timedOut, false);
      assert.equal(result.code, 0);

      const argvFiles = readdirSync(markerDir).filter((name) =>
        name.startsWith("argv-"),
      );
      assert.equal(
        argvFiles.length,
        1,
        "un seul conteneur docker run attendu pour cette exécution",
      );
      const argv = readFileSync(join(markerDir, argvFiles[0] as string), "utf8").split(
        "\n",
      );

      const envIndex = argv.findIndex((value) =>
        value.startsWith("OPENCODE_CONFIG_CONTENT="),
      );
      assert.notEqual(
        envIndex,
        -1,
        "OPENCODE_CONFIG_CONTENT doit être passé en -e",
      );
      const opencodeConfig = JSON.parse(
        (argv[envIndex] as string).slice("OPENCODE_CONFIG_CONTENT=".length),
      );
      const baseURL: string = opencodeConfig.provider.lmstudio.options.baseURL;

      assert.match(
        baseURL,
        /^http:\/\/host\.docker\.internal:\d+\/v1$/,
        "l'agent ne doit connaître que l'adresse du proxy local",
      );
      assert.ok(
        !baseURL.includes(":1234/"),
        "pas le port par défaut de l'upstream réel (CONTAINER_INFERENCE_URL n'est pas défini dans ce test)",
      );

      // Défaut sans `mode` explicite : le mode le plus restrictif. Un
      // appelant qui oublie de le passer ne doit jamais récupérer
      // silencieusement les outils d'écriture.
      assert.deepEqual(opencodeConfig.permission, {
        edit: "deny",
        bash: "deny",
        webfetch: "deny",
      });

      // --add-host reste nécessaire : le conteneur doit joindre l'hôte pour
      // atteindre CE proxy (qui, lui, tourne sur l'hôte) — voir
      // needsHostGateway().
      assert.ok(argv.includes("host.docker.internal:host-gateway"));
      // --network bridge : toujours nécessaire pour joindre le proxy. Voir
      // le rapport de la tâche pour ce que cela laisse encore ouvert (le
      // conteneur reste capable de joindre autre chose que ce proxy au
      // niveau réseau, un outil shell de l'agent n'est pas bloqué par ce
      // correctif).
      assert.ok(argv.includes("bridge"));
    } finally {
      rmSync(metaDir, { recursive: true, force: true });
    }
  });

  test("le proxy démarré pour l'exécution est bien fermé une fois runAgentInSandbox terminé", async () => {
    const metaDir = mkdtempSync(join(tmpdir(), "cds-agent-meta-"));
    writeFileSync(join(metaDir, "prompt.txt"), "prompt de test", "utf8");

    try {
      const result = await runAgentInSandbox("/repo", metaDir, "groupe/depot", {
        dockerBin,
      });
      const argvFiles = readdirSync(markerDir).filter((name) =>
        name.startsWith("argv-"),
      );
      const argv = readFileSync(
        join(markerDir, argvFiles[argvFiles.length - 1] as string),
        "utf8",
      ).split("\n");
      const envIndex = argv.findIndex((value) =>
        value.startsWith("OPENCODE_CONFIG_CONTENT="),
      );
      const opencodeConfig = JSON.parse(
        (argv[envIndex] as string).slice("OPENCODE_CONFIG_CONTENT=".length),
      );
      const baseURL: string = opencodeConfig.provider.lmstudio.options.baseURL;
      const port = Number(new URL(baseURL).port);

      assert.equal(result.code, 0);
      // Le proxy a été fermé dans le `finally` de runAgentInSandbox : une
      // requête sur ce port doit désormais échouer (rien n'écoute plus).
      await assert.rejects(() =>
        fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          body: "{}",
        }),
      );
    } finally {
      rmSync(metaDir, { recursive: true, force: true });
    }
  });

  // §B (durcissement proxy d'entreprise) : contrairement à runCommand()
  // (agent/workspace.ts, voir workspace.test.ts), runAgentInSandbox()
  // n'appelle jamais containerProxyEnv() — le conteneur agent ne doit
  // connaître que le proxy d'inférence local, jamais le proxy d'entreprise
  // de l'hôte, qui élargirait sa portée réseau à l'exact opposé de
  // l'intention de restriction de ce bloc de tests.
  test("un HTTP_PROXY d'entreprise présent dans l'environnement du daemon n'atteint jamais le conteneur agent", async () => {
    const metaDir = mkdtempSync(join(tmpdir(), "cds-agent-meta-"));
    writeFileSync(join(metaDir, "prompt.txt"), "prompt de test", "utf8");
    const previousHttpProxy = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://proxy.corp.example:3128";

    try {
      await runAgentInSandbox("/repo", metaDir, "groupe/depot", { dockerBin });

      const argvFiles = readdirSync(markerDir).filter((name) => name.startsWith("argv-"));
      const argv = readFileSync(
        join(markerDir, argvFiles[argvFiles.length - 1] as string),
        "utf8",
      ).split("\n");

      assert.ok(
        !argv.some((value) => value.startsWith("HTTP_PROXY=")),
        "le conteneur agent ne doit jamais recevoir le proxy d'entreprise de l'hôte",
      );
    } finally {
      if (previousHttpProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = previousHttpProxy;
      rmSync(metaDir, { recursive: true, force: true });
    }
  });
});
