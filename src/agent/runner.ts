import { spawn } from "node:child_process";
import { config, sanitizedEnv } from "../config.ts";
import { createBoundedOutput } from "./bounded-output.ts";

export interface AgentResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * `timeoutMs` : par défaut config.agentTimeoutMs (comportement historique,
 * inchangé pour tous les appels existants). Chantier "planificateur" :
 * tasks/planner.ts passe explicitement config.plannerTimeoutMs — un budget de
 * temps DISTINCT de celui de l'agent exécutant, plus petit (le planificateur
 * ne fait que rédiger un plan JSON, pas écrire ni faire tourner une suite de
 * tests). Paramètre optionnel plutôt qu'une nouvelle fonction : même
 * mécanisme d'exécution (opencode, sortie bornée, SIGKILL au dépassement),
 * seul le budget change.
 */
export function runAgent(
  cwd: string,
  prompt: string,
  timeoutMs: number = config.agentTimeoutMs,
): Promise<AgentResult> {
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

    // Bornées (§4.8) : sans limite, un agent bavard (ou une boucle qui
    // spamme stdout) ferait grossir ces chaînes sans borne jusqu'à l'OOM du
    // daemon — voir bounded-output.ts pour la justification du choix de
    // tronquer le début plutôt que la fin.
    const stdout = createBoundedOutput();
    const stderr = createBoundedOutput();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: stdout.value(),
        stderr: stderr.value(),
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}
