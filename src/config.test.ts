import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

// config.ts jette au chargement du module si GITLAB_TOKEN ou BOT_USERNAME
// sont absents (cf. required()). Même parade que les autres tests du
// projet (review.test.ts, request.test.ts, ...) : on renseigne
// l'environnement avant l'import dynamique, pour rester reproductible sans
// .env local (CI). Une fois importée, buildConfig() est une fonction pure :
// les tests ci-dessous lui passent des environnements fabriqués et ne
// touchent plus jamais process.env, donc pas besoin de sous-processus.
let buildConfig: (env: NodeJS.ProcessEnv) => Record<string, unknown>;

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  ({ buildConfig } = await import("./config.ts"));
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

  test("TASK_STUB_MS négatif est rejeté", () => {
    assert.throws(
      () => buildConfig(baseEnv({ TASK_STUB_MS: "-1" })),
      /TASK_STUB_MS/,
    );
  });
});

describe("buildConfig — configuration valide complète", () => {
  test("une configuration entièrement renseignée et valide est lue telle quelle", () => {
    const config = buildConfig(
      baseEnv({
        POLL_INTERVAL_MS: "15000",
        TASK_STUB_MS: "1000",
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
    assert.equal(config.taskStubMs, 1_000);
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
