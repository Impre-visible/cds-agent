import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts jette au chargement du module si GITLAB_TOKEN ou BOT_USERNAME
// sont absents (cf. required()). Même parade que les autres tests du
// projet (review.test.ts, request.test.ts, ...) : on renseigne
// l'environnement avant l'import dynamique, pour rester reproductible sans
// .env local (CI). Une fois importée, buildConfig() est une fonction pure :
// les tests ci-dessous lui passent des environnements fabriqués et ne
// touchent plus jamais process.env, donc pas besoin de sous-processus.
let buildConfig: (env: NodeJS.ProcessEnv) => Record<string, unknown>;
let config: { gitlabUrl: string; token: string };
let gitCredentialEnv: () => NodeJS.ProcessEnv;
let sanitizedEnv: () => NodeJS.ProcessEnv;

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  ({ buildConfig, config, gitCredentialEnv, sanitizedEnv } = await import(
    "./config.ts"
  ));
});

/** Environnement minimal valide : seules les deux variables obligatoires. */
function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITLAB_TOKEN: "glpat-xxx",
    BOT_USERNAME: "test-bot",
    ...overrides,
  };
}

describe("buildConfig — valeurs requises", () => {
  test("jette si GITLAB_TOKEN est absent", () => {
    assert.throws(
      () => buildConfig({ BOT_USERNAME: "test-bot" }),
      /GITLAB_TOKEN/,
    );
  });

  test("jette si BOT_USERNAME est absent", () => {
    assert.throws(
      () => buildConfig({ GITLAB_TOKEN: "glpat-xxx" }),
      /BOT_USERNAME/,
    );
  });
});

describe("buildConfig — finiteNumber : le scénario qui motive tout ça", () => {
  test("POLL_INTERVAL_MS mal saisi (\"30s\") est rejeté, jamais silencieusement ramené à 0", () => {
    assert.throws(
      () => buildConfig(baseEnv({ POLL_INTERVAL_MS: "30s" })),
      (error: Error) => {
        assert.match(error.message, /POLL_INTERVAL_MS/);
        assert.match(error.message, /30s/);
        return true;
      },
    );
  });

  test("POLL_INTERVAL_MS=0 est rejeté (en dessous du plancher, pas un intervalle exploitable)", () => {
    assert.throws(
      () => buildConfig(baseEnv({ POLL_INTERVAL_MS: "0" })),
      /POLL_INTERVAL_MS/,
    );
  });

  test("POLL_INTERVAL_MS négatif est rejeté", () => {
    assert.throws(
      () => buildConfig(baseEnv({ POLL_INTERVAL_MS: "-1000" })),
      /POLL_INTERVAL_MS/,
    );
  });

  test("POLL_INTERVAL_MS absent retombe sur le défaut documenté (30000)", () => {
    const config = buildConfig(baseEnv());
    assert.equal(config.pollIntervalMs, 30_000);
  });

  test("POLL_INTERVAL_MS valide est lu correctement", () => {
    const config = buildConfig(baseEnv({ POLL_INTERVAL_MS: "45000" }));
    assert.equal(config.pollIntervalMs, 45_000);
  });

  test("POLL_INTERVAL_MS au-delà du plafond (1h) est rejeté", () => {
    assert.throws(
      () => buildConfig(baseEnv({ POLL_INTERVAL_MS: "999999999" })),
      /POLL_INTERVAL_MS/,
    );
  });
});

describe("buildConfig — autres valeurs numériques", () => {
  test("MAX_ATTEMPTS=0 est rejeté (désactiverait silencieusement les réessais)", () => {
    assert.throws(
      () => buildConfig(baseEnv({ MAX_ATTEMPTS: "0" })),
      /MAX_ATTEMPTS/,
    );
  });

  test("MAX_ATTEMPTS non numérique est rejeté", () => {
    assert.throws(
      () => buildConfig(baseEnv({ MAX_ATTEMPTS: "trois" })),
      /MAX_ATTEMPTS/,
    );
  });

  test("MAX_ATTEMPTS absent retombe sur le défaut documenté (3)", () => {
    const config = buildConfig(baseEnv());
    assert.equal(config.maxAttempts, 3);
  });

  test("MAX_REMARKS=-1 est rejeté (slice(0, -1) aurait un comportement inattendu)", () => {
    assert.throws(
      () => buildConfig(baseEnv({ MAX_REMARKS: "-1" })),
      /MAX_REMARKS/,
    );
  });

  test("LOOKBACK_MINUTES non numérique est rejeté", () => {
    assert.throws(
      () => buildConfig(baseEnv({ LOOKBACK_MINUTES: "dix" })),
      /LOOKBACK_MINUTES/,
    );
  });

  test("LOOKBACK_MINUTES absent retombe sur le défaut documenté (10 min → 600000 ms)", () => {
    const config = buildConfig(baseEnv());
    assert.equal(config.lookbackMs, 10 * 60_000);
  });

  test("LOOKBACK_MINUTES valide est converti en millisecondes", () => {
    const config = buildConfig(baseEnv({ LOOKBACK_MINUTES: "20" }));
    assert.equal(config.lookbackMs, 20 * 60_000);
  });

  test("AGENT_TIMEOUT_MINUTES=0 est rejeté (un timeout de 0 est aussi absurde qu'un NaN)", () => {
    assert.throws(
      () => buildConfig(baseEnv({ AGENT_TIMEOUT_MINUTES: "0" })),
      /AGENT_TIMEOUT_MINUTES/,
    );
  });

  test("COMMAND_TIMEOUT_MINUTES hors plafond est rejeté", () => {
    assert.throws(
      () => buildConfig(baseEnv({ COMMAND_TIMEOUT_MINUTES: "9999" })),
      /COMMAND_TIMEOUT_MINUTES/,
    );
  });
});

describe("buildConfig — configuration valide complète", () => {
  test("une configuration entièrement renseignée et valide est lue telle quelle", () => {
    const config = buildConfig(
      baseEnv({
        POLL_INTERVAL_MS: "15000",
        LOOKBACK_MINUTES: "5",
        AGENT_TIMEOUT_MINUTES: "15",
        MAX_REMARKS: "8",
        COMMAND_TIMEOUT_MINUTES: "3",
        MAX_ATTEMPTS: "5",
        DOCKER_MEMORY: "2g",
        DOCKER_CPUS: "2.5",
      }),
    );

    assert.equal(config.pollIntervalMs, 15_000);
    assert.equal(config.lookbackMs, 5 * 60_000);
    assert.equal(config.agentTimeoutMs, 15 * 60_000);
    assert.equal(config.maxRemarks, 8);
    assert.equal(config.commandTimeoutMs, 3 * 60_000);
    assert.equal(config.maxAttempts, 5);
    assert.equal(config.dockerMemory, "2g");
    assert.equal(config.dockerCpus, "2.5");
  });

  test("reproduit le .env réel du projet sans lever (bornes compatibles)", () => {
    const config = buildConfig(
      baseEnv({
        GITLAB_URL: "https://gitlab.com",
        POLL_INTERVAL_MS: "30000",
        USE_DOCKER: "1",
        DOCKER_DEFAULT_IMAGE: "node:22-bookworm-slim",
      }),
    );
    assert.equal(config.pollIntervalMs, 30_000);
    assert.equal(config.useDocker, true);
  });
});

describe("buildConfig — installIgnoreScripts (§1.6)", () => {
  test("activé par défaut : --ignore-scripts protège l'installation tant qu'on ne l'a pas désactivé explicitement", () => {
    const config = buildConfig(baseEnv());
    assert.equal(config.installIgnoreScripts, true);
  });

  test("désactivable via INSTALL_IGNORE_SCRIPTS=0", () => {
    const config = buildConfig(baseEnv({ INSTALL_IGNORE_SCRIPTS: "0" }));
    assert.equal(config.installIgnoreScripts, false);
  });
});

describe("buildConfig — cloneDepth (§4.7)", () => {
  test("profondeur par défaut : clone superficiel plutôt que l'historique complet", () => {
    const config = buildConfig(baseEnv());
    assert.equal(config.cloneDepth, 20);
  });

  test("CLONE_DEPTH=0 redonne un clone complet (comportement précédent)", () => {
    const config = buildConfig(baseEnv({ CLONE_DEPTH: "0" }));
    assert.equal(config.cloneDepth, 0);
  });
});

describe("buildConfig — testDirectoryOverrides (dossiers de test par projet)", () => {
  test("absent, la map est vide (comportement par défaut sûr)", () => {
    const config = buildConfig(baseEnv());
    assert.equal((config.testDirectoryOverrides as Map<string, string[]>).size, 0);
  });

  test("un dépôt peut déclarer plusieurs dossiers séparés par '|'", () => {
    const config = buildConfig(
      baseEnv({
        TEST_DIRECTORY_OVERRIDES: "Groupe/Depot=e2e|acceptance,autre/depot=fixtures",
      }),
    );
    const overrides = config.testDirectoryOverrides as Map<string, string[]>;
    assert.deepEqual(overrides.get("groupe/depot"), ["e2e", "acceptance"]);
    assert.deepEqual(overrides.get("autre/depot"), ["fixtures"]);
  });

  test("une entrée mal formée (sans '=' ou sans valeur) est ignorée", () => {
    const config = buildConfig(
      baseEnv({ TEST_DIRECTORY_OVERRIDES: "sans-egal,groupe/depot=" }),
    );
    assert.equal((config.testDirectoryOverrides as Map<string, string[]>).size, 0);
  });
});

describe("buildConfig — validation de forme (docker)", () => {
  test("DOCKER_MEMORY dans un format inattendu est rejeté", () => {
    assert.throws(
      () => buildConfig(baseEnv({ DOCKER_MEMORY: "beaucoup" })),
      /DOCKER_MEMORY/,
    );
  });

  test("DOCKER_CPUS dans un format inattendu est rejeté", () => {
    assert.throws(
      () => buildConfig(baseEnv({ DOCKER_CPUS: "deux" })),
      /DOCKER_CPUS/,
    );
  });

  test("DOCKER_MEMORY et DOCKER_CPUS absents retombent sur les défauts documentés", () => {
    const config = buildConfig(baseEnv());
    assert.equal(config.dockerMemory, "4g");
    assert.equal(config.dockerCpus, "4");
  });
});

// §1.5 — le mode sandbox est désormais le défaut ; le mode hôte non
// sandboxé exige un opt-in explicite et bruyant (ALLOW_UNSANDBOXED=1).
describe("buildConfig — useDocker (§1.5 : sandbox par défaut)", () => {
  test("sans aucune variable, la sandbox est activée (défaut sûr)", () => {
    const config = buildConfig(baseEnv());
    assert.equal(config.useDocker, true);
  });

  test("USE_DOCKER=1 active la sandbox — inchangé, c'est le .env réel du projet", () => {
    const config = buildConfig(baseEnv({ USE_DOCKER: "1" }));
    assert.equal(config.useDocker, true);
  });

  test("ALLOW_UNSANDBOXED=1 seul suffit à passer en mode hôte", () => {
    const config = buildConfig(baseEnv({ ALLOW_UNSANDBOXED: "1" }));
    assert.equal(config.useDocker, false);
  });

  test("USE_DOCKER=0 seul (sans ALLOW_UNSANDBOXED) est rejeté : ce n'est plus un opt-out valide, " +
    "pour éviter qu'un .env existant retombe silencieusement en mode non sandboxé", () => {
    assert.throws(
      () => buildConfig(baseEnv({ USE_DOCKER: "0" })),
      (error: Error) => {
        assert.match(error.message, /USE_DOCKER=0/);
        assert.match(error.message, /ALLOW_UNSANDBOXED/);
        return true;
      },
    );
  });

  test("USE_DOCKER=0 combiné à ALLOW_UNSANDBOXED=1 : l'opt-in explicite l'emporte, pas d'erreur", () => {
    const config = buildConfig(
      baseEnv({ USE_DOCKER: "0", ALLOW_UNSANDBOXED: "1" }),
    );
    assert.equal(config.useDocker, false);
  });
});

// §4.10 — un AGENT_MODEL sans "/" produit une clé de modèle opencode vide
// dans agent/sandbox.ts (config.agentModel.split("/")[1] ?? ""), échec
// silencieux loin de la cause. Validé dès le démarrage.
describe("buildConfig — validation du format d'AGENT_MODEL (§4.10)", () => {
  test("AGENT_MODEL absent retombe sur le défaut documenté", () => {
    const config = buildConfig(baseEnv());
    assert.equal(config.agentModel, "lmstudio/qwen2.5-coder-7b-instruct-mlx");
  });

  test("AGENT_MODEL valide (\"fournisseur/modèle\") est accepté tel quel", () => {
    const config = buildConfig(baseEnv({ AGENT_MODEL: "lmstudio/qwen2.5" }));
    assert.equal(config.agentModel, "lmstudio/qwen2.5");
  });

  test("AGENT_MODEL sans '/' est rejeté, avec un message qui dit le format attendu", () => {
    assert.throws(
      () => buildConfig(baseEnv({ AGENT_MODEL: "qwen2.5-coder" })),
      (error: Error) => {
        assert.match(error.message, /AGENT_MODEL/);
        assert.match(error.message, /qwen2\.5-coder/);
        assert.match(error.message, /fournisseur\/modèle/);
        return true;
      },
    );
  });

  test("AGENT_MODEL avec une partie fournisseur vide (\"/modele\") est rejeté", () => {
    assert.throws(
      () => buildConfig(baseEnv({ AGENT_MODEL: "/qwen2.5" })),
      /AGENT_MODEL/,
    );
  });

  test("AGENT_MODEL avec une partie modèle vide (\"fournisseur/\") est rejeté — c'est exactement le " +
    "cas qui produirait une clé vide dans agent/sandbox.ts", () => {
    assert.throws(
      () => buildConfig(baseEnv({ AGENT_MODEL: "lmstudio/" })),
      /AGENT_MODEL/,
    );
  });
});

// §4.6 — sanitizedEnv() est désormais une liste blanche : les variables
// sensibles qu'une denylist par regex manquait doivent être absentes, et les
// variables nécessaires à l'exécution de commandes (dont git) doivent rester
// présentes.
describe("sanitizedEnv (§4.6 : liste blanche, pas denylist)", () => {
  const injected = {
    AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKEFAKE",
    AWS_SECRET_ACCESS_KEY: "fake-secret-value",
    GH_PAT: "ghp_fakefakefakefakefake",
    SSH_AUTH_SOCK: "/tmp/fake-ssh-agent.sock",
    KUBECONFIG: "/fake/.kube/config",
    DATABASE_URL: "postgres://user:hunter2@db.internal/app",
    // Les cas que la denylist par regex interceptait déjà : doivent aussi
    // rester absents avec la liste blanche.
    GITLAB_TOKEN_EXTRA: "should-not-leak",
  };
  const previous: Record<string, string | undefined> = {};

  before(() => {
    for (const [key, value] of Object.entries(injected)) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
  });

  after(() => {
    for (const key of Object.keys(injected)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  test("aucune des variables sensibles injectées (au-delà de ce qu'une denylist regex " +
    "attraperait) ne fuite dans l'environnement produit", () => {
    const clean = sanitizedEnv();
    for (const key of Object.keys(injected)) {
      assert.equal(
        key in clean,
        false,
        `${key} n'aurait jamais dû fuiter — c'est précisément ce que la denylist manquait`,
      );
    }
  });

  test("les variables nécessaires à l'exécution de commandes (PATH, HOME) restent présentes", () => {
    const clean = sanitizedEnv();
    assert.ok(clean.PATH, "PATH doit être présent : sans lui, aucun binaire n'est trouvable");
    // HOME n'est garanti que si le process de test lui-même en a un — vrai
    // sur toute machine de dev/CI Unix habituelle.
    if (process.env.HOME) assert.equal(clean.HOME, process.env.HOME);
  });

  test("une vraie commande git tourne avec cet environnement réduit (dépôt jetable, vrai commit)", () => {
    const root = mkdtempSync(join(tmpdir(), "cds-agent-sanitized-env-git-"));
    try {
      const env = sanitizedEnv();
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: root, encoding: "utf8", env });

      run(["init", "--quiet", "-b", "main"]);
      run(["config", "user.name", "cds-agent-test"]);
      run(["config", "user.email", "cds-agent-test@local.invalid"]);
      writeFileSync(join(root, "fichier.txt"), "contenu\n");
      run(["add", "--all"]);

      // Ne doit pas lever : si git ne trouvait pas ce dont il a besoin
      // (identité, HOME pour un éventuel .gitconfig global, PATH...), le
      // commit échouerait ici.
      assert.doesNotThrow(() => run(["commit", "--quiet", "-m", "test"]));

      const log = execFileSync("git", ["log", "--oneline"], {
        cwd: root,
        encoding: "utf8",
        env,
      });
      assert.match(log, /test/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// §4.9 — l'en-tête Authorization doit être restreint à l'instance GitLab
// visée (http.<url>.extraHeader), pas posé globalement (http.extraHeader).
describe("gitCredentialEnv (§4.9 : en-tête restreint à l'instance GitLab)", () => {
  test("la clé de config produite est bien scopée à l'hôte de gitlabUrl, vérifié via " +
    "`git config --get-urlmatch` contre un vrai dépôt", () => {
    const root = mkdtempSync(join(tmpdir(), "cds-agent-git-credential-env-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      const credEnv = { ...process.env, ...gitCredentialEnv() };

      // URL sous l'instance GitLab configurée : doit matcher.
      const matched = execFileSync(
        "git",
        [
          "config",
          "--get-urlmatch",
          "http.extraHeader",
          `${config.gitlabUrl}/some/project.git`,
        ],
        { cwd: root, encoding: "utf8", env: credEnv },
      ).trim();
      assert.match(matched, /^Authorization: Basic /);

      // Un hôte différent (même avec un préfixe de nom proche) ne doit
      // jamais recevoir l'en-tête : sinon le PAT fuiterait vers un tiers au
      // premier détour (redirection, sous-module...).
      assert.throws(() =>
        execFileSync(
          "git",
          [
            "config",
            "--get-urlmatch",
            "http.extraHeader",
            "https://evil.example.com/foo.git",
          ],
          { cwd: root, encoding: "utf8", env: credEnv, stdio: "pipe" },
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Chantier "capacités" (§A) — voir tasks/guard.ts pour RepoCapabilities.
describe("buildConfig — agentCapabilities (AGENT_CAPABILITIES)", () => {
  test("absent, la map est vide : chaque dépôt retombe sur DEFAULT_CAPABILITIES (comportement par défaut sûr)", () => {
    const config = buildConfig(baseEnv());
    assert.equal((config.agentCapabilities as Map<string, unknown>).size, 0);
  });

  test('"write-all" élargit writablePaths à "all" pour le dépôt déclaré, sans toucher aux autres', () => {
    const config = buildConfig(
      baseEnv({ AGENT_CAPABILITIES: "Groupe/Depot=write-all" }),
    );
    const capabilities = config.agentCapabilities as Map<
      string,
      { writablePaths: unknown; publishMode: unknown }
    >;
    assert.deepEqual(capabilities.get("groupe/depot"), {
      writablePaths: "all",
      publishMode: "source-branch",
    });
    assert.equal(capabilities.get("autre/depot"), undefined);
  });

  test('"write:motif1|motif2" déclare une liste de motifs', () => {
    const config = buildConfig(
      baseEnv({ AGENT_CAPABILITIES: "groupe/depot=write:src/generated/**|docs/**" }),
    );
    const capabilities = config.agentCapabilities as Map<
      string,
      { writablePaths: unknown }
    >;
    assert.deepEqual(capabilities.get("groupe/depot")?.writablePaths, [
      "src/generated/**",
      "docs/**",
    ]);
  });

  test('"dedicated-mr" bascule publishMode, indépendamment de writablePaths', () => {
    const config = buildConfig(
      baseEnv({ AGENT_CAPABILITIES: "groupe/depot=dedicated-mr" }),
    );
    const capabilities = config.agentCapabilities as Map<
      string,
      { writablePaths: unknown; publishMode: unknown }
    >;
    assert.deepEqual(capabilities.get("groupe/depot"), {
      writablePaths: "tests-only",
      publishMode: "dedicated-mr",
    });
  });

  test("plusieurs capacités combinées (\";\") sur un même dépôt, plusieurs dépôts (\",\")", () => {
    const config = buildConfig(
      baseEnv({
        AGENT_CAPABILITIES: "groupe/depot-a=write-all;dedicated-mr,groupe/depot-b=write:e2e/**",
      }),
    );
    const capabilities = config.agentCapabilities as Map<
      string,
      { writablePaths: unknown; publishMode: unknown }
    >;
    assert.deepEqual(capabilities.get("groupe/depot-a"), {
      writablePaths: "all",
      publishMode: "dedicated-mr",
    });
    assert.deepEqual(capabilities.get("groupe/depot-b"), {
      writablePaths: ["e2e/**"],
      publishMode: "source-branch",
    });
  });

  test("une capacité inconnue ou mal orthographiée fait échouer le démarrage avec un message clair", () => {
    assert.throws(
      () => buildConfig(baseEnv({ AGENT_CAPABILITIES: "groupe/depot=write-al" })),
      (error: Error) => {
        assert.match(error.message, /AGENT_CAPABILITIES/);
        assert.match(error.message, /write-al/);
        assert.match(error.message, /capacité inconnue/);
        return true;
      },
    );
  });

  test('"write:" sans aucun motif est rejeté', () => {
    assert.throws(
      () => buildConfig(baseEnv({ AGENT_CAPABILITIES: "groupe/depot=write:" })),
      /AGENT_CAPABILITIES/,
    );
  });

  test("une entrée sans '=' fait échouer le démarrage", () => {
    assert.throws(
      () => buildConfig(baseEnv({ AGENT_CAPABILITIES: "sans-egal" })),
      /AGENT_CAPABILITIES/,
    );
  });
});

// Chantier "capacités" (§B) — TEST_COMMANDS/INSTALL_COMMANDS par dépôt, avec
// repli sur le défaut global TEST_COMMAND/INSTALL_COMMAND (résolution testée
// dans tasks/implement.test.ts::resolveCommand, ici seulement le parsing).
describe("buildConfig — testCommands / installCommands par dépôt", () => {
  test("absents, les maps sont vides : tous les dépôts utilisent le défaut global", () => {
    const config = buildConfig(baseEnv());
    assert.equal((config.testCommands as Map<string, string>).size, 0);
    assert.equal((config.installCommands as Map<string, string>).size, 0);
    assert.equal(config.testCommand, "npm test");
    assert.equal(config.installCommand, "npm install");
  });

  test("une commande par dépôt est lue telle quelle, casse préservée", () => {
    const config = buildConfig(
      baseEnv({
        TEST_COMMANDS: "Groupe/Depot=pytest -q,autre/depot=mvn test",
        INSTALL_COMMANDS: "groupe/depot=pip install -r requirements.txt",
      }),
    );
    const testCommands = config.testCommands as Map<string, string>;
    const installCommands = config.installCommands as Map<string, string>;
    assert.equal(testCommands.get("groupe/depot"), "pytest -q");
    assert.equal(testCommands.get("autre/depot"), "mvn test");
    assert.equal(installCommands.get("groupe/depot"), "pip install -r requirements.txt");
  });

  test("une valeur de commande contenant elle-même un '=' n'est pas tronquée (splitOnce, pas split)", () => {
    const config = buildConfig(
      baseEnv({ TEST_COMMANDS: "groupe/depot=CI=1 npm test" }),
    );
    const testCommands = config.testCommands as Map<string, string>;
    assert.equal(testCommands.get("groupe/depot"), "CI=1 npm test");
  });
});
