import { spawn } from "node:child_process";
import { config, sanitizedEnv } from "./env.ts";

export interface AgentResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export function runAgent(cwd: string, prompt: string): Promise<AgentResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      "opencode",
      ["run", "--model", config.agentModel, prompt],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedEnv(),
      },
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, config.agentTimeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}
