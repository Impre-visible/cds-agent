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

/**
 * Fixture partagée par inference-remote.test.ts et inference-direct.test.ts.
 * Ces deux scénarios tiennent dans des fichiers séparés (donc des PROCESSUS
 * séparés) parce que config.ts fige la configuration au chargement du module :
 * un import dynamique avec suffixe de cache-busting réévalue bien sandbox.ts,
 * mais pas le config.ts déjà en cache — l'environnement doit donc différer dès
 * le démarrage du processus. Le fichier ne finit pas par ".test.ts" : il n'est
 * pas ramassé par le glob du lanceur de tests.
 */

export interface AgentSandboxFixture {
  dockerBin: string;
  markerDir: string;
  metaDir: string;
  cleanup(): void;
}

export interface OpencodeProvider {
  options: { baseURL: string; apiKey: string };
  models: Record<string, unknown>;
}

export interface OpencodeConfig {
  provider: Record<string, OpencodeProvider>;
}

/** Faux `docker` réduit au strict nécessaire : dépose son argv, puis réussit. */
function writeFakeDocker(dir: string): string {
  const path = join(dir, "fake-docker.sh");
  writeFileSync(
    path,
    `#!/bin/bash
name=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--name" ]; then name="$arg"; fi
  prev="$arg"
done
printf '%s\\n' "$@" > "$FAKE_DOCKER_MARKER_DIR/argv-$name"
exit 0
`,
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * À appeler AVANT d'importer src/agent/sandbox.ts (qui charge config.ts) :
 * renseigne les variables obligatoires sans lesquelles config.ts refuse de se
 * charger, et installe le faux docker.
 */
export function createAgentSandboxFixture(): AgentSandboxFixture {
  process.env.GITLAB_TOKEN ??= "test-token";
  process.env.BOT_USERNAME ??= "test-bot";

  const dir = mkdtempSync(join(tmpdir(), "cds-agent-fake-docker-inference-"));
  const markerDir = mkdtempSync(join(tmpdir(), "cds-agent-inference-markers-"));
  const metaDir = mkdtempSync(join(tmpdir(), "cds-agent-inference-meta-"));
  writeFileSync(join(metaDir, "prompt.txt"), "prompt de test", "utf8");
  process.env.FAKE_DOCKER_MARKER_DIR = markerDir;

  return {
    dockerBin: writeFakeDocker(dir),
    markerDir,
    metaDir,
    cleanup() {
      for (const path of [dir, markerDir, metaDir])
        rmSync(path, { recursive: true, force: true });
      delete process.env.FAKE_DOCKER_MARKER_DIR;
    },
  };
}

type RunAgentInSandbox = (
  repo: string,
  meta: string,
  projectPath: string,
  options?: { dockerBin?: string },
) => Promise<{ code: number | null }>;

/** Lance l'agent avec le faux docker et rend l'argv + la config opencode reçus. */
export async function runAndReadOpencodeConfig(
  runAgentInSandbox: RunAgentInSandbox,
  fixture: AgentSandboxFixture,
): Promise<{ argv: string[]; opencodeConfig: OpencodeConfig }> {
  const result = await runAgentInSandbox("/repo", fixture.metaDir, "groupe/depot", {
    dockerBin: fixture.dockerBin,
  });
  assert.equal(result.code, 0);

  const [argvFile] = readdirSync(fixture.markerDir).filter((name) =>
    name.startsWith("argv-"),
  );
  const argv = readFileSync(
    join(fixture.markerDir, argvFile as string),
    "utf8",
  ).split("\n");

  const prefix = "OPENCODE_CONFIG_CONTENT=";
  const entry = argv.find((value) => value.startsWith(prefix));
  assert.ok(entry, "OPENCODE_CONFIG_CONTENT doit être passé en -e");
  return {
    argv,
    opencodeConfig: JSON.parse(entry.slice(prefix.length)) as OpencodeConfig,
  };
}

/** Accès non-optionnel à un bloc provider, avec un échec parlant s'il manque. */
export function providerOf(
  opencodeConfig: OpencodeConfig,
  id: string,
): OpencodeProvider {
  const provider = opencodeConfig.provider[id];
  assert.ok(provider, `bloc provider "${id}" absent de la config opencode`);
  return provider;
}
