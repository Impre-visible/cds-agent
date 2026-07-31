import { execFile, execFileSync } from "node:child_process";
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
import { promisify } from "node:util";
import { config, containerProxyEnv, gitCredentialEnv, sanitizedEnv } from "../config.ts";
import { imageFor, runInSandbox } from "./sandbox.ts";

const execFileAsync = promisify(execFile);

/**
 * §4.5 : toutes les commandes git passent par `execFile` promisifié plutôt
 * que par `execFileSync`. Un clone ou un push peuvent prendre plusieurs
 * dizaines de secondes ; en synchrone, ils bloquent la boucle d'événements du
 * process entier pendant toute leur durée — le polling GitLab s'arrête, les
 * timeouts programmés ailleurs ne se déclenchent plus, l'arrêt gracieux ne
 * répond plus. `execFileSync` reste utilisé ailleurs dans ce fichier
 * (`runCommand`, pour l'exécution directe hors Docker) : hors périmètre de
 * ce correctif, qui porte spécifiquement sur "la couche git".
 *
 * `maxBuffer` explicite : le défaut de Node (1 Mo) est atteint par un simple
 * `git status --porcelain -uall` sur un dépôt où l'agent a généré beaucoup de
 * fichiers, ou par un `git diff`/`git show` un peu verbeux. Sans ce plafond
 * relevé, l'erreur ENOBUFS remonte comme un échec de clone incompréhensible.
 * 64 Mo couvre tout statut/diff plausible sans autoriser un usage mémoire
 * déraisonnable pour un process qui ne devrait jamais produire plus que ça.
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

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

export async function createWorkspace(
  projectPath: string,
  branch: string,
  options: { depth?: number } = {},
): Promise<Workspace> {
  const root = mkdtempSync(join(tmpdir(), "cds-agent-"));
  const repo = join(root, "repo");
  const host = new URL(config.gitlabUrl).host;
  // Aucun credential dans l'URL : il ne doit jamais atterrir dans .git/config.
  const url = `https://${host}/${projectPath}.git`;
  // §4.7 : sans --depth, chaque review et chaque implémentation reclone tout
  // l'historique du dépôt — plusieurs minutes et des centaines de Mo sur un
  // dépôt d'entreprise, pour un usage qui n'a besoin que de l'état courant
  // de la branche. --single-branch (indépendant de la profondeur) évite en
  // plus de récupérer les autres branches du dépôt, jamais utilisées ici.
  const depthArgs =
    options.depth && options.depth > 0
      ? ["--depth", String(options.depth)]
      : [];

  try {
    await execFileAsync(
      "git",
      [
        ...NO_HOOKS_ARGS,
        "clone",
        "--quiet",
        "--single-branch",
        ...depthArgs,
        "--branch",
        branch,
        url,
        repo,
      ],
      {
        maxBuffer: GIT_MAX_BUFFER,
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

/**
 * authenticated=true uniquement pour les opérations réseau (clone, push,
 * fetch). Asynchrone (§4.5) : voir le commentaire sur GIT_MAX_BUFFER
 * ci-dessus pour les deux raisons de ce choix (non-blocage de la boucle
 * d'événements, maxBuffer explicite). Tous les appelants (implement.ts,
 * les tests) doivent désormais `await` cette fonction.
 */
export async function git(
  repo: string,
  args: string[],
  authenticated = false,
): Promise<string> {
  const { stdout } = await execFileAsync("git", [...NO_HOOKS_ARGS, ...args], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    env: authenticated
      ? { ...sanitizedEnv(), ...gitCredentialEnv() }
      : sanitizedEnv(),
  });
  return stdout;
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
  // .git/info/exclude et .git/info/attributes : risque marginal (un
  // .gitattributes ne définit pas de commande à lui seul, les drivers
  // filter/diff qu'il référence vivent dans .git/config, déjà couvert
  // ci-dessus) mais ça ne coûte qu'une ligne de plus à couvrir.
  hash.update(readTextSafe(join(repo, ".git", "info", "exclude")));
  hash.update(readTextSafe(join(repo, ".git", "info", "attributes")));

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
  /**
   * Image Docker à utiliser pour ce dépôt — résolue par projects.json (voir
   * src/projects.ts::resolveProject, appelé une seule fois par le worker,
   * voir tasks/implement.ts) et transmise ici telle quelle plutôt que
   * redérivée depuis un chemin de dépôt et un registre global : chantier
   * "projects.json", remplace l'ancien `projectPath` + config.dockerImages.
   */
  docker: { image: string };
  network?: boolean;
  mounts?: { host: string; container: string }[];
  /** Nom du binaire docker à invoquer ; injectable pour les tests (faux docker) — voir sandbox.ts::SandboxOptions.dockerBin. */
  dockerBin?: string;
}

export async function runCommand(
  repo: string,
  command: string,
  options: RunOptions,
): Promise<CommandResult> {
  if (config.useDocker) {
    // §B (durcissement proxy d'entreprise) : uniquement quand le réseau est
    // ouvert (options.network) — un conteneur --network none n'a de toute
    // façon aucun moyen d'atteindre un proxy, transmettre ces variables ne
    // ferait rien de plus qu'ajouter du bruit. Ce chemin sert l'installation
    // et les tests du dépôt cible (implement.ts) ; le conteneur agent
    // (runAgentInSandbox, agent/sandbox.ts) ne passe jamais par ici et ne
    // reçoit donc jamais le proxy d'entreprise — son réseau reste restreint
    // au seul proxy d'inférence local, une portée volontairement plus
    // étroite qu'un accès proxifié au réseau de l'entreprise.
    const proxy = options.network
      ? containerProxyEnv()
      : { env: {}, hostGateway: false };
    return runInSandbox(repo, imageFor(options.docker), command, {
      network: options.network,
      mounts: options.mounts,
      env: proxy.env,
      hostGateway: proxy.hostGateway,
      dockerBin: options.dockerBin,
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
