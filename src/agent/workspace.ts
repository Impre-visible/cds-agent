import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, gitCredentialEnv, sanitizedEnv } from "../config.ts";
import { imageFor, runInSandbox } from "./sandbox.ts";

/**
 * L'agent tourne dans le clone avec un accès en écriture complet à .git/ :
 * il peut y déposer un hook (pre-commit, post-checkout, prepare-commit-msg…)
 * exécuté par le prochain `git` lancé sur l'hôte. On neutralise ça pour
 * toute invocation, en pointant core.hooksPath vers un répertoire vide.
 *
 * mkdtemp et pas un chemin fixe du type /tmp/cds-agent-no-hooks : un nom
 * prévisible dans un répertoire partagé, c'est justement l'endroit où un
 * autre utilisateur de la machine peut déposer à l'avance les hooks qui
 * seront exécutés. mkdtemp donne un nom aléatoire et un répertoire en 0700
 * dont nous sommes seuls propriétaires.
 */
const NO_HOOKS_DIR = mkdtempSync(join(tmpdir(), "cds-agent-nohooks-"));
const NO_HOOKS_ARGS = ["-c", `core.hooksPath=${NO_HOOKS_DIR}`];

export interface Workspace {
  root: string;
  repo: string;
  /** Métadonnées de la tâche, hors du dépôt : jamais vues par git. */
  meta: string;
  dispose: () => void;
}

/**
 * Workspace actuellement utilisé, s'il y en a un. Comme pour activeContainer
 * dans sandbox.ts, un seul slot suffit tant qu'un seul worker tourne à la
 * fois (voir queue.ts) : ni implement.ts ni review.ts n'en créent plus d'un
 * en parallèle. Sert au nettoyage best-effort à l'arrêt forcé du daemon
 * (voir index.ts) : dispose() est déjà appelé dans un `finally` par
 * implement.ts/review.ts en fonctionnement normal, mais un `process.exit()`
 * après épuisement du délai de grâce n'attend pas ce `finally`.
 */
let active: Workspace | undefined;

export function currentWorkspace(): Workspace | undefined {
  return active;
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
      [
        ...NO_HOOKS_ARGS,
        "clone",
        "--quiet",
        ...depthArgs,
        "--branch",
        branch,
        url,
        repo,
      ],
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

  const meta = join(root, "meta");
  mkdirSync(meta, { recursive: true });

  const workspace: Workspace = {
    root,
    repo,
    meta,
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
      if (active === workspace) active = undefined;
    },
  };
  active = workspace;
  return workspace;
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
  return execFileSync("git", [...NO_HOOKS_ARGS, ...args], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: authenticated
      ? { ...sanitizedEnv(), ...gitCredentialEnv() }
      : sanitizedEnv(),
  });
}

/**
 * Empreinte de .git/config et .git/hooks : les deux portes par lesquelles
 * l'agent peut obtenir une exécution de code sur l'hôte (clés de config
 * comme core.pager/core.fsmonitor/filter.<n>.clean, ou un hook classique
 * une fois core.hooksPath contourné d'une façon qu'on n'aurait pas prévue).
 * Prise juste avant que l'agent ne travaille et revérifiée juste après, elle
 * permet de détecter toute altération — y compris celles que la neutralisation
 * des hooks ci-dessus ne couvre pas (core.fsmonitor déclenche déjà sur un
 * simple `git status`, avant tout add/commit/push).
 *
 * Calculée uniquement via le système de fichiers, jamais en invoquant git :
 * tant qu'on n'a pas confirmé que rien n'a bougé, on ne veut lancer aucune
 * commande git sur un dépôt potentiellement piégé.
 */
export function fingerprintGitMeta(repo: string): string {
  const hash = createHash("sha256");

  hash.update(readTextSafe(join(repo, ".git", "config")));

  const hooksDir = join(repo, ".git", "hooks");
  for (const name of listSafe(hooksDir)) {
    const path = join(hooksDir, name);
    hash.update(name);
    hash.update(readTextSafe(path));
    // Le bit exécutable est ce qui transforme un fichier inerte en hook actif.
    hash.update(isExecutableSafe(path) ? "x" : "-");
  }

  return hash.digest("hex");
}

function readTextSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function listSafe(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isExecutableSafe(path: string): boolean {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export interface CommandResult {
  ok: boolean;
  output: string;
  timedOut: boolean;
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
    return { ok: true, output, timedOut: false };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      message: string;
      // Positionné par execFileSync quand le process est tué après `timeout`.
      killed?: boolean;
    };
    return {
      ok: false,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message}`,
      timedOut: Boolean(failure.killed),
    };
  }
}
