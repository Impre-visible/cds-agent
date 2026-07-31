import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, gitCredentialEnv, sanitizedEnv } from "../config.ts";
import { imageFor, runInSandbox } from "./sandbox.ts";

export interface Workspace {
  root: string;
  repo: string;
  dispose: () => void;
}

export function createWorkspace(
  projectPath: string,
  branch: string,
  options: { depth?: number } = {},
): Workspace {
  const root = mkdtempSync(join(tmpdir(), "cds-agent-"));
  const repo = join(root, "repo");
  const host = new URL(config.gitlabUrl).host;
  // Aucun credential dans l'URL : il ne doit jamais atterrir dans .git/config.
  const url = `https://${host}/${projectPath}.git`;
  const depthArgs =
    options.depth && options.depth > 0
      ? ["--depth", String(options.depth)]
      : [];

  try {
    execFileSync(
      "git",
      ["clone", "--quiet", ...depthArgs, "--branch", branch, url, repo],
      {
        stdio: "pipe",
        env: { ...sanitizedEnv(), ...gitCredentialEnv() },
      },
    );
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `clone impossible : ${(error as Error).message.replaceAll(config.token, "***")}`,
    );
  }

  assertNoSecret(repo);
  return {
    root,
    repo,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Ceinture et bretelles : on vérifie plutôt que de supposer. */
function assertNoSecret(repo: string): void {
  const gitConfig = readFileSync(join(repo, ".git", "config"), "utf8");
  if (gitConfig.includes(config.token)) {
    throw new Error(
      "SÉCURITÉ : le token a fui dans .git/config, clone abandonné",
    );
  }
}

/** authenticated=true uniquement pour les opérations réseau (clone, push, fetch). */
export function git(
  repo: string,
  args: string[],
  authenticated = false,
): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: authenticated
      ? { ...sanitizedEnv(), ...gitCredentialEnv() }
      : sanitizedEnv(),
  });
}

export interface CommandResult {
  ok: boolean;
  output: string;
}

export interface RunOptions {
  projectPath: string;
  network?: boolean;
  mounts?: { host: string; container: string }[];
}

export async function runCommand(
  repo: string,
  command: string,
  options: RunOptions,
): Promise<CommandResult> {
  if (config.useDocker) {
    return runInSandbox(repo, imageFor(options.projectPath), command, {
      network: options.network,
      mounts: options.mounts,
    });
  }

  // Exécution directe : conservée pour le POC local, à proscrire en production.
  try {
    const output = execFileSync("bash", ["-lc", command], {
      cwd: repo,
      encoding: "utf8",
      timeout: config.commandTimeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...sanitizedEnv(), CI: "1", FORCE_COLOR: "0" },
    });
    return { ok: true, output };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      message: string;
    };
    return {
      ok: false,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message}`,
    };
  }
}
