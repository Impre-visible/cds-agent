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

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  process.env.OPENHANDS_URL ??= "http://openhands.local:3000";
  ({ buildConfig, config } = await import("../src/config.ts"));
});

/** Environnement minimal valide : les trois variables obligatoires. */
function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITLAB_TOKEN: "glpat-xxx",
    BOT_USERNAME: "test-bot",
    // Obligatoire depuis que toute exécution est déléguée : le daemon n'a
    // aucun autre moyen de traiter une demande (voir src/config.ts).
    OPENHANDS_URL: "http://openhands.local:3000",
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

  test("GITLAB_REQUEST_TIMEOUT_MS hors plafond est rejeté", () => {
    assert.throws(
      () => buildConfig(baseEnv({ GITLAB_REQUEST_TIMEOUT_MS: "999999" })),
      /GITLAB_REQUEST_TIMEOUT_MS/,
    );
  });
});

describe("buildConfig — configuration valide complète", () => {
  test("une configuration entièrement renseignée et valide est lue telle quelle", () => {
    const config = buildConfig(
      baseEnv({
        POLL_INTERVAL_MS: "15000",
        LOOKBACK_MINUTES: "5",
        OPENHANDS_TIMEOUT_MINUTES: "15",
        MAX_ATTEMPTS: "5",
        GITLAB_URL: "https://gitlab.interne/",
      }),
    );

    assert.equal(config.pollIntervalMs, 15_000);
    assert.equal(config.lookbackMs, 5 * 60_000);
    assert.equal(config.openhandsTimeoutMs, 15 * 60_000);
    assert.equal(config.maxAttempts, 5);
    // Les "/" de fin sont retirés : sans ça, chaque URL construite en
    // contiendrait un en double.
    assert.equal(config.gitlabUrl, "https://gitlab.interne");
  });
});

describe("buildConfig — projectsFile (chantier « projects.json »)", () => {
  test("absent, retombe sur le défaut documenté (./projects.json)", () => {
    const config = buildConfig(baseEnv());
    assert.equal(config.projectsFile, "./projects.json");
  });

  test("PROJECTS_FILE personnalisé est repris tel quel", () => {
    const config = buildConfig(baseEnv({ PROJECTS_FILE: "/etc/cds-agent/projects.json" }));
    assert.equal(config.projectsFile, "/etc/cds-agent/projects.json");
  });
});

// Chantier "projects.json" — coupure franche avec l'environnement : sept
// variables ont migré vers ce fichier (voir src/projects.ts) et leur seule
// présence (même vide) fait échouer le démarrage, avec un message qui nomme
// la variable ET dit où le réglage a migré — jamais un simple avertissement.
describe("buildConfig — variables d'environnement périmées (chantier « projects.json »)", () => {
  const legacyVars = [
    "ALLOWED_PROJECTS",
    "ALLOWED_USERS",
    "AGENT_CAPABILITIES",
    "DOCKER_IMAGES",
    "TEST_COMMANDS",
    "INSTALL_COMMANDS",
    "TEST_DIRECTORY_OVERRIDES",
  ];

  for (const name of legacyVars) {
    test(`${name} encore présente fait échouer le démarrage, message nommant la variable et "projects.json"`, () => {
      assert.throws(
        () => buildConfig(baseEnv({ [name]: "quelque-chose" })),
        (error: Error) => {
          assert.match(error.message, new RegExp(name));
          assert.match(error.message, /projects\.json/);
          return true;
        },
      );
    });

    test(`${name} présente mais VIDE fait aussi échouer (la présence de la clé compte, pas sa valeur)`, () => {
      assert.throws(() => buildConfig(baseEnv({ [name]: "" })), new RegExp(name));
    });
  }

  test("aucune variable périmée : le démarrage n'est pas affecté", () => {
    assert.doesNotThrow(() => buildConfig(baseEnv()));
  });
});

describe("buildConfig — testCommand / installCommand (défauts globaux, inchangés)", () => {
  test("absents, retombent sur les défauts documentés", () => {
    const config = buildConfig(baseEnv());
    assert.equal(config.testCommand, "npm test");
    assert.equal(config.installCommand, "npm install");
  });

  test("personnalisables comme avant ce chantier", () => {
    const config = buildConfig(
      baseEnv({ TEST_COMMAND: "pytest -q", INSTALL_COMMAND: "pip install -r requirements.txt" }),
    );
    assert.equal(config.testCommand, "pytest -q");
    assert.equal(config.installCommand, "pip install -r requirements.txt");
  });
});

// §B (durcissement proxy d'entreprise) — computeContainerProxyEnv : fonction
// pure séparée de containerProxyEnv() (qui, elle, lit process.env/config
// réels — voir agent/workspace.test.ts pour la couverture de ce fil-là,
// via runCommand).
describe("buildConfig — OPENHANDS_URL (le daemon ne fait que dispatcher)", () => {
  test("absente : le daemon refuse de démarrer — il n'a aucun autre exécutant", () => {
    // Le découvrir au démarrage, pas à la première demande : un daemon qui
    // accuse réception puis constate qu'il n'a personne à qui déléguer laisse
    // le demandeur sans réponse.
    const env = baseEnv();
    delete env.OPENHANDS_URL;
    assert.throws(() => buildConfig(env), /OPENHANDS_URL/);
  });

  test("vide : traitée comme absente, pas comme une URL valide", () => {
    assert.throws(() => buildConfig(baseEnv({ OPENHANDS_URL: "" })), /OPENHANDS_URL/);
  });

  test('"localhost:3000" est refusée — new URL l\'accepte, le contrôle de protocole non', () => {
    // Le piège : `new URL("localhost:3000")` réussit, en lisant "localhost:"
    // comme un schéma. Sans le contrôle de protocole, cette valeur passerait
    // la validation pour échouer bien plus loin, au premier fetch.
    assert.throws(
      () => buildConfig(baseEnv({ OPENHANDS_URL: "localhost:3000" })),
      /OPENHANDS_URL="localhost:3000".*http ou https/s,
    );
  });

  test("une valeur qui n'est pas une URL du tout est refusée en nommant la variable", () => {
    assert.throws(
      () => buildConfig(baseEnv({ OPENHANDS_URL: "://x" })),
      /OPENHANDS_URL=":\/\/x".*URL absolue/s,
    );
  });

  test("un schéma autre que http/https est refusé", () => {
    assert.throws(
      () => buildConfig(baseEnv({ OPENHANDS_URL: "ftp://oh.local" })),
      /http ou https/,
    );
  });

  test("les / de fin sont retirés (le client ajoute /api/v1)", () => {
    const config = buildConfig(
      baseEnv({ OPENHANDS_URL: "http://openhands.local:3000///" }),
    );
    assert.equal(config.openhandsUrl, "http://openhands.local:3000");
  });

  test("OPENHANDS_API_KEY est reprise telle quelle, et reste facultative", () => {
    assert.equal(buildConfig(baseEnv()).openhandsApiKey, undefined);
    assert.equal(
      buildConfig(baseEnv({ OPENHANDS_API_KEY: "clé" })).openhandsApiKey,
      "clé",
    );
  });

  test("OPENHANDS_TIMEOUT_MINUTES : défaut 10 min (comme l'ancien budget d'agent), bornes [1, 240]", () => {
    // Même défaut que l'AGENT_TIMEOUT_MINUTES de la branche `hardening` :
    // c'est ce qui fait partir les deux backends du même budget sur le banc
    // de mesure.
    assert.equal(buildConfig(baseEnv()).openhandsTimeoutMs, 10 * 60_000);
    assert.equal(
      buildConfig(baseEnv({ OPENHANDS_TIMEOUT_MINUTES: "45" })).openhandsTimeoutMs,
      45 * 60_000,
    );
    assert.throws(
      () => buildConfig(baseEnv({ OPENHANDS_TIMEOUT_MINUTES: "0" })),
      /OPENHANDS_TIMEOUT_MINUTES/,
    );
    assert.throws(
      () => buildConfig(baseEnv({ OPENHANDS_TIMEOUT_MINUTES: "241" })),
      /OPENHANDS_TIMEOUT_MINUTES/,
    );
  });
});

describe("loadDotEnv — la suite de tests ne dépend pas du .env de l'opérateur", () => {
  test("le drapeau est bien posé pendant cette suite", () => {
    assert.equal(
      process.env.CDS_SKIP_DOTENV,
      "1",
      "npm test doit poser CDS_SKIP_DOTENV=1 (voir package.json)",
    );
  });

  test("aucune variable d'inférence de l'opérateur n'a fuité dans ce process", () => {
    // Si ces variables apparaissent ici, c'est que .env a été lu : le même
    // test tournerait alors différemment selon la machine.
    for (const name of [
      "CONTAINER_INFERENCE_URL",
      "INFERENCE_API_KEY",
      "INFERENCE_UPSTREAM_URL",
    ]) {
      assert.equal(
        process.env[name],
        undefined,
        `${name} vient du .env local : la suite n'est plus reproductible`,
      );
    }
  });
});

describe("buildConfig — CDS_MAX_TASKS (banc de mesure)", () => {
  test("absent : illimité, comportement historique", () => {
    // Le seul comportement d'exploitation : le daemon tourne jusqu'à SIGINT.
    assert.equal(buildConfig(baseEnv()).maxTasks, 0);
  });

  test("valeur positive : le daemon s'arrêtera après ce nombre de tâches", () => {
    assert.equal(buildConfig(baseEnv({ CDS_MAX_TASKS: "1" })).maxTasks, 1);
  });

  test("négatif rejeté", () => {
    assert.throws(
      () => buildConfig(baseEnv({ CDS_MAX_TASKS: "-1" })),
      /CDS_MAX_TASKS/,
    );
  });

  test("non numérique rejeté", () => {
    assert.throws(
      () => buildConfig(baseEnv({ CDS_MAX_TASKS: "une" })),
      /CDS_MAX_TASKS/,
    );
  });
});
