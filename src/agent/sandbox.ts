import { spawn } from "node:child_process";
import { config } from "../config.ts";

export interface SandboxResult {
  ok: boolean;
  output: string;
}

export function imageFor(projectPath: string): string {
  return (
    config.dockerImages.get(projectPath.toLowerCase()) ??
    config.dockerDefaultImage
  );
}

export interface SandboxOptions {
  network?: boolean;
  env?: Record<string, string>;
  mounts?: { host: string; container: string }[];
}

export function runInSandbox(
  repo: string,
  image: string,
  command: string,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const args = [
      "run",
      "--rm",
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

    args.push(image, "bash", "-c", command);

    console.log(
      `    [docker ${options.network ? "réseau" : "isolé"}] ${command.slice(0, 80)}`,
    );
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });

    let output = "";
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      config.commandTimeoutMs,
    );
    const capture = (chunk: Buffer) => {
      output += chunk;
      process.stdout.write(chunk);
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `docker introuvable : ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
  });
}
