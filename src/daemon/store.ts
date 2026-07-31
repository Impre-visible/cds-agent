import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type RequestStatus = "claimed" | "acked";

interface Entry {
  key: string;
  todoId: number;
  status: RequestStatus;
  at: string;
}

export class RequestStore {
  private readonly states = new Map<string, RequestStatus>();

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;

    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Entry;
        this.states.set(entry.key, entry.status);
      } catch {
        console.warn(`[store] ligne illisible ignorée : ${line.slice(0, 80)}`);
      }
    }
  }

  has(key: string): boolean {
    return this.states.has(key);
  }

  statusOf(key: string): RequestStatus | undefined {
    return this.states.get(key);
  }

  record(key: string, todoId: number, status: RequestStatus): void {
    const entry: Entry = { key, todoId, status, at: new Date().toISOString() };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    this.states.set(key, status);
  }

  /** Demandes réclamées mais jamais menées au bout : signe d'un crash. */
  interrupted(): string[] {
    return [...this.states.entries()]
      .filter(([, status]) => status === "claimed")
      .map(([key]) => key);
  }
}
