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
let computeContainerProxyEnv: (
  hostEnv: NodeJS.ProcessEnv,
  overrides?: { httpProxy?: string; httpsProxy?: string; noProxy?: string },
) => { env: Record<string, string>; hostGateway: boolean };

before(async () => {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";
  ({ buildConfig, config, gitCredentialEnv, sanitizedEnv, computeContainerProxyEnv } =
    await import("../src/config.ts"));
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

describe("buildConfig — PLANNER_TIMEOUT_MINUTES (chantier « planificateur »)", () => {
  test("absent retombe sur le défaut documenté (3 min → 180000 ms)", () => {
    const config = buildConfig(baseEnv());
    assert.equal(config.plannerTimeoutMs, 3 * 60_000);
  });

  test("valeur valide est convertie en millisecondes", () => {
    const config = buildConfig(baseEnv({ PLANNER_TIMEOUT_MINUTES: "5" }));
    assert.equal(config.plannerTimeoutMs, 5 * 60_000);
  });

  test("non numérique est rejeté", () => {
    assert.throws(
      () => buildConfig(baseEnv({ PLANNER_TIMEOUT_MINUTES: "vite" })),
      /PLANNER_TIMEOUT_MINUTES/,
    );
  });

  test("distinct d'AGENT_TIMEOUT_MINUTES : changer l'un ne change pas l'autre", () => {
    const config = buildConfig(baseEnv({ AGENT_TIMEOUT_MINUTES: "20" }));
    assert.equal(config.agentTimeoutMs, 20 * 60_000);
    assert.equal(config.plannerTimeoutMs, 3 * 60_000);
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

/**
 * Chantier « passes multiples » §1 : le plafond demandé au modèle et le
 * plafond publié dans la MR étaient la même variable. Mesuré sur la MR !5 —
 * à MAX_REMARKS=5, les trois modèles ont rendu exactement 5 remarques (donc
 * plafond contraignant) ; à 12, gpt-oss-120b en a rendu 6, dont la seule
 * détection du défaut D4 de toute la campagne. Le plafond ne coupait pas du
 * bruit.
 */
describe("buildConfig — REVIEW_BUDGET vs MAX_REMARKS (chantier « passes multiples »)", () => {
  test("les deux plafonds ont des défauts DISTINCTS, et le second est une simple borne", () => {
    const config = buildConfig(baseEnv());
    assert.equal(config.reviewBudget, 12);
    assert.equal(
      config.maxRemarks,
      15,
      "au-dessus de ce qu'une revue produit en pratique : une borne, pas un sélecteur",
    );
  });

  test("les deux se règlent indépendamment", () => {
    const config = buildConfig(
      baseEnv({ REVIEW_BUDGET: "20", MAX_REMARKS: "3" }),
    );
    assert.equal(config.reviewBudget, 20);
    assert.equal(config.maxRemarks, 3);
  });

  test("MAX_REMARKS n'est PAS plafonné par REVIEW_BUDGET : l'union de N passes le dépasse légitimement", () => {
    // Mesuré : 15 remarques distinctes pour un budget de 12 PAR PASSE, sur
    // 3 passes en mode exclusion. Le plafonnement d'avant supposait une passe
    // unique et aurait ramené le garde-fou sous le volume réel.
    const config = buildConfig(baseEnv({ REVIEW_BUDGET: "12", MAX_REMARKS: "20" }));
    assert.equal(config.maxRemarks, 20);
  });

  test("REVIEW_BUDGET=0 est rejeté (un budget nul demanderait zéro remarque)", () => {
    assert.throws(
      () => buildConfig(baseEnv({ REVIEW_BUDGET: "0" })),
      /REVIEW_BUDGET/,
    );
  });
});

/**
 * Le filtre par NATURE remplace le filtre par QUANTITÉ. Mesuré le 1er août
 * 2026 (MR !5, 3 passes en mode exclusion, 15 remarques distinctes) : les
 * cinq "error" étaient tous justes, les trois faux positifs identifiables
 * étaient tous des "info".
 */
describe("buildConfig — MIN_SEVERITY (filtre par nature)", () => {
  test("défaut « warning » : publie error + warning, écarte info", () => {
    assert.equal(buildConfig(baseEnv()).minSeverity, "warning");
  });

  test("les trois niveaux du barème sont acceptés, casse et espaces indifférents", () => {
    assert.equal(buildConfig(baseEnv({ MIN_SEVERITY: "info" })).minSeverity, "info");
    assert.equal(buildConfig(baseEnv({ MIN_SEVERITY: "ERROR" })).minSeverity, "error");
    assert.equal(
      buildConfig(baseEnv({ MIN_SEVERITY: " warning " })).minSeverity,
      "warning",
    );
  });

  test("un synonyme du barème est REFUSÉ ici, en le disant", () => {
    // SEVERITY_ALIASES traduit ce que rend le MODÈLE ; un seuil de
    // publication, lui, doit être écrit sans ambiguïté par un humain.
    assert.throws(
      () => buildConfig(baseEnv({ MIN_SEVERITY: "bug" })),
      (error: Error) => {
        assert.match(error.message, /MIN_SEVERITY/);
        assert.match(error.message, /info, warning, error/);
        return true;
      },
    );
  });

  test("une valeur inconnue est refusée AU DÉMARRAGE, pas ignorée en silence", () => {
    assert.throws(
      () => buildConfig(baseEnv({ MIN_SEVERITY: "critique" })),
      /MIN_SEVERITY/,
    );
  });
});

describe("buildConfig — REVIEW_PASS_MODE / REVIEW_VOTE (banc d'essai des passes)", () => {
  test("le défaut reproduit le comportement d'avant le chantier", () => {
    const config = buildConfig(baseEnv());
    assert.equal(config.reviewPassMode, "independent");
    assert.equal(config.reviewVote, true);
    assert.equal(config.reviewPasses, 1);
  });

  test("les trois modes du banc d'essai sont acceptés", () => {
    for (const mode of ["independent", "chained", "exclusion"]) {
      assert.equal(
        buildConfig(baseEnv({ REVIEW_PASS_MODE: mode })).reviewPassMode,
        mode,
      );
    }
  });

  test("un mode inconnu est refusé AU DÉMARRAGE, en nommant les valeurs acceptées", () => {
    assert.throws(
      () => buildConfig(baseEnv({ REVIEW_PASS_MODE: "indépendant" })),
      (error: Error) => {
        assert.match(error.message, /REVIEW_PASS_MODE/);
        // Sans cette liste, une faute de frappe ferait tourner neuf runs de
        // campagne dans un mode qu'on croit être un autre.
        assert.match(error.message, /independent, chained, exclusion/);
        return true;
      },
    );
  });

  test("REVIEW_VOTE=0 bascule sur l'union ; toute autre valeur laisse le vote", () => {
    assert.equal(buildConfig(baseEnv({ REVIEW_VOTE: "0" })).reviewVote, false);
    assert.equal(buildConfig(baseEnv({ REVIEW_VOTE: "1" })).reviewVote, true);
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

// Chantier "projects.json" — remplace les tests ci-dessus (testDirectoryOverrides,
// agentCapabilities, testCommands/installCommands) : la résolution par dépôt
// vit désormais dans src/projects.ts (voir tests/projects.test.ts). Ce qui
// reste ici, propre à config.ts, c'est le chemin du fichier et le refus des
// variables d'environnement périmées.
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

// Chantier "projects.json" : les anciennes capacités par dépôt
// (AGENT_CAPABILITIES) et les commandes par dépôt (TEST_COMMANDS/
// INSTALL_COMMANDS) sont désormais dans projects.json, testées dans
// tests/projects.test.ts. testCommand/installCommand (globaux, inchangés)
// restent couverts ci-dessous en tant que simples valeurs par défaut.
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
describe("computeContainerProxyEnv (§B : proxy transmis au conteneur d'install/test)", () => {
  test("rien dans l'environnement hôte : aucune variable produite, pas de host-gateway", () => {
    const result = computeContainerProxyEnv({});
    assert.deepEqual(result.env, {});
    assert.equal(result.hostGateway, false);
  });

  test("HTTP_PROXY/HTTPS_PROXY/NO_PROXY sur une adresse réseau normale (pas loopback) : repris tels quels", () => {
    const result = computeContainerProxyEnv({
      HTTP_PROXY: "http://proxy.corp.example:3128",
      HTTPS_PROXY: "http://proxy.corp.example:3128",
      NO_PROXY: "localhost,127.0.0.1,.corp.example",
    });
    assert.equal(result.env.HTTP_PROXY, "http://proxy.corp.example:3128");
    assert.equal(result.env.HTTPS_PROXY, "http://proxy.corp.example:3128");
    assert.equal(result.env.NO_PROXY, "localhost,127.0.0.1,.corp.example");
    // Variantes minuscules également transmises : certains outils du dépôt
    // cible (pip, curl...) ne lisent que la forme minuscule.
    assert.equal(result.env.http_proxy, "http://proxy.corp.example:3128");
    assert.equal(
      result.hostGateway,
      false,
      "une adresse réseau normale ne nécessite pas host.docker.internal",
    );
  });

  test("proxy en loopback (127.0.0.1) : réécrit vers host.docker.internal, host-gateway nécessaire", () => {
    const result = computeContainerProxyEnv({ HTTP_PROXY: "http://127.0.0.1:3128" });
    assert.equal(result.env.HTTP_PROXY, "http://host.docker.internal:3128/");
    assert.equal(result.hostGateway, true);
  });

  test("proxy en loopback (localhost) : même réécriture", () => {
    const result = computeContainerProxyEnv({ HTTPS_PROXY: "http://localhost:3129" });
    assert.equal(result.env.HTTPS_PROXY, "http://host.docker.internal:3129/");
    assert.equal(result.hostGateway, true);
  });

  test("NO_PROXY n'est jamais réécrit (une entrée loopback y devient simplement sans effet côté conteneur)", () => {
    const result = computeContainerProxyEnv({
      HTTP_PROXY: "http://127.0.0.1:3128",
      NO_PROXY: "127.0.0.1,corp.example",
    });
    assert.equal(result.env.NO_PROXY, "127.0.0.1,corp.example");
  });

  test("les overrides CONTAINER_HTTP_PROXY/CONTAINER_HTTPS_PROXY/CONTAINER_NO_PROXY court-circuitent l'hôte ET la réécriture automatique", () => {
    const result = computeContainerProxyEnv(
      { HTTP_PROXY: "http://127.0.0.1:3128" },
      {
        httpProxy: "http://un-alias-special:9999",
        httpsProxy: "http://un-autre-alias:9998",
        noProxy: "special.invalid",
      },
    );
    assert.equal(result.env.HTTP_PROXY, "http://un-alias-special:9999");
    assert.equal(result.env.HTTPS_PROXY, "http://un-autre-alias:9998");
    assert.equal(result.env.NO_PROXY, "special.invalid");
    assert.equal(
      result.hostGateway,
      false,
      "un override explicite n'est jamais réécrit, donc ne déclenche jamais host-gateway",
    );
  });
});
