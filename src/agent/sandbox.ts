import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import type { AgentResult } from "./runner.ts";

export interface SandboxResult {
  ok: boolean;
  /** Code de sortie réel du conteneur (null si le processus n'a jamais pu se terminer proprement). */
  code: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Nom du conteneur actuellement en cours d'exécution, s'il y en a un. Un
 * seul worker tourne à la fois (TaskQueue est strictement séquentiel, voir
 * queue.ts), donc un simple slot suffit — pas besoin d'une vraie
 * comptabilité multi-ressources. Sert uniquement au nettoyage best-effort à
 * l'arrêt forcé du daemon (voir index.ts) : si le délai de grâce expire
 * pendant qu'un conteneur tourne encore, on peut le cibler par son nom
 * plutôt que d'abandonner en le laissant tourner indéfiniment.
 */
let activeContainer: string | undefined;

export function currentContainer(): string | undefined {
  return activeContainer;
}

/** Best-effort : ignore toute erreur (docker absent, conteneur déjà parti...). */
export function killContainer(
  name: string,
  dockerBin = "docker",
): Promise<void> {
  return new Promise((resolve) => {
    execFile(dockerBin, ["kill", name], () => resolve());
  });
}

export function imageFor(projectPath: string): string {
  return (
    config.dockerImages.get(projectPath.toLowerCase()) ??
    config.dockerDefaultImage
  );
}

export interface SandboxOptions {
  network?: boolean;
  hostGateway?: boolean;
  env?: Record<string, string>;
  mounts?: { host: string; container: string }[];
  /** Dérogation à config.commandTimeoutMs (voir runAgentInSandbox). */
  timeoutMs?: number;
  /** Nom du binaire docker à invoquer ; injectable pour les tests (faux docker). */
  dockerBin?: string;
}

/**
 * Construction pure des arguments `docker run`. Extraite de runInSandbox pour
 * être testable sans docker : on peut vérifier la présence de --name, du bon
 * réseau, des montages, des variables d'environnement... par simple
 * inspection du tableau retourné.
 */
export function buildDockerRunArgs(
  repo: string,
  image: string,
  command: string,
  containerName: string,
  options: SandboxOptions = {},
): string[] {
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    options.network ? "bridge" : "none",
    "--memory",
    config.dockerMemory,
    "--cpus",
    config.dockerCpus,
    "--pids-limit",
    "512",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${repo}:/repo`,
    "-w",
    "/repo",
    "-e",
    "CI=1",
    "-e",
    "FORCE_COLOR=0",
  ];

  for (const mount of options.mounts ?? []) {
    args.push("-v", `${mount.host}:${mount.container}:ro`);
  }

  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }

  if (options.hostGateway) {
    // Nécessaire sur Linux ; sans effet sur Docker Desktop où l'alias existe déjà.
    args.push("--add-host", "host.docker.internal:host-gateway");
  }

  args.push(image, "bash", "-c", command);

  return args;
}

export function runInSandbox(
  repo: string,
  image: string,
  command: string,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const dockerBin = options.dockerBin ?? "docker";
    // Nom unique : plusieurs conteneurs peuvent coexister (review et
    // implement en parallèle, retries...) et il faut pouvoir cibler CE
    // conteneur précis au moment du kill, sans toucher aux autres.
    const containerName = `cds-${randomUUID()}`;
    activeContainer = containerName;
    const args = buildDockerRunArgs(repo, image, command, containerName, options);

    console.log(
      `    [docker ${options.network ? "réseau" : "isolé"} ${containerName}] ${command.slice(0, 80)}`,
    );
    const child = spawn(dockerBin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let output = "";
    let timedOut = false;
    let killGrace: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(
      () => {
        timedOut = true;
        // `child` est le client `docker run`, pas le conteneur : le tuer ne
        // déclenche pas --rm et laisse le conteneur tourner (mémoire/CPU
        // réservées, montage du workspace tenu). On cible donc le conteneur
        // lui-même par son nom unique via `docker kill` ; le client constate
        // l'arrêt du conteneur et se termine de lui-même juste après, ce qui
        // laisse --rm s'appliquer normalement.
        execFile(dockerBin, ["kill", containerName], () => {
          // Échec ignoré : conteneur déjà terminé entre-temps, ou docker
          // indisponible — le filet de sécurité ci-dessous couvre ce dernier cas.
        });
        // Filet de sécurité : si le client ne se termine pas de lui-même peu
        // après (démon docker qui traîne, kill sans effet...), on ne veut pas
        // bloquer indéfiniment sur ce process. Le conteneur peut alors
        // survivre — dégradation acceptable, imputable à docker et non à ce code.
        killGrace = setTimeout(() => child.kill("SIGKILL"), 5_000);
      },
      options.timeoutMs ?? config.commandTimeoutMs,
    );
    const capture = (chunk: Buffer) => {
      output += chunk;
      process.stdout.write(chunk);
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killGrace);
      if (activeContainer === containerName) activeContainer = undefined;
      resolve({
        ok: false,
        code: null,
        output: `docker introuvable : ${error.message}`,
        timedOut: false,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killGrace);
      if (activeContainer === containerName) activeContainer = undefined;
      resolve({ ok: code === 0, code, output, timedOut });
    });
  });
}

export async function runAgentInSandbox(
  repo: string,
  meta: string,
  _projectPath: string,
): Promise<AgentResult> {
  const started = Date.now();

  const opencodeConfig = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      lmstudio: {
        npm: "@ai-sdk/openai-compatible",
        name: "LM Studio",
        options: { baseURL: config.inferenceUrl, apiKey: "lm-studio" },
        models: { [config.agentModel.split("/")[1] ?? ""]: { name: "agent" } },
      },
    },
  });

  const result = await runInSandbox(
    repo,
    config.agentImage,
    `opencode run --model ${config.agentModel} "$(cat /task/prompt.txt)"`,
    {
      network: true,
      hostGateway: true,
      mounts: [{ host: meta, container: "/task" }],
      env: { OPENCODE_CONFIG_CONTENT: opencodeConfig },
      // L'agent a son propre budget (AGENT_TIMEOUT_MINUTES, 10 min par
      // défaut), distinct du timeout générique des commandes courtes
      // (COMMAND_TIMEOUT_MINUTES, 5 min, pensé pour install/tests). Sans ce
      // paramètre explicite, c'est ce dernier qui s'appliquait ici et
      // AGENT_TIMEOUT_MINUTES n'avait aucun effet en mode Docker.
      timeoutMs: config.agentTimeoutMs,
    },
  );

  return {
    code: result.code,
    stdout: result.output,
    stderr: "",
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
  };
}
