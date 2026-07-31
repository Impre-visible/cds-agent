import { config } from "./env.ts";
import { gitlab, GitLabError } from "./gitlab.ts";
import { RequestStore } from "./store.ts";
import type { AgentRequest, GitLabUser, Todo } from "./types.ts";
import { buildRequest, defuseMentions } from "./request.ts";
import { authorize } from "./authorize.ts";
import { TaskQueue } from "./queue.ts";
import { runTask } from "./task.ts";

const store = new RequestStore(config.stateFile);
let bot: GitLabUser;
const queue = new TaskQueue(runTask);
const examined = new Set<number>();

function ackBody(request: AgentRequest, position: number): string {
  const quoted = defuseMentions(request.text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  const status =
    position <= 1
      ? "traitement en cours."
      : `mise en file d'attente, position ${position}.`;

  return [
    `🤖 Demande reçue de @${request.requester}, ${status}`,
    "",
    quoted,
    "",
    `<sub>cds-agent · POC local · clé \`${request.key}\`</sub>`,
  ].join("\n");
}

async function finishTodo(todoId: number): Promise<void> {
  if (config.skipMarkDone) {
    console.log(`    to-do laissé pending (SKIP_MARK_DONE=1)`);
    return;
  }
  const outcome = await gitlab.markTodoDone(todoId);
  console.log(`    to-do ${outcome === "done" ? "marqué done" : "déjà done côté GitLab"}`);
}

async function acknowledge(request: AgentRequest, position: number): Promise<void> {
  const { projectId, kind, iid, noteId } = request;

  try {
    if (noteId === null) {
      await gitlab.awardOnResource(projectId, kind, iid, "eyes");
    } else {
      await gitlab.awardOnNote(projectId, kind, iid, noteId, "eyes");
    }
  } catch (error) {
    console.warn(`    réaction emoji impossible : ${(error as Error).message}`);
  }

  await gitlab.createNote(projectId, kind, iid, ackBody(request, position));
}

async function handle(todo: Todo): Promise<void> {
  const result = await buildRequest(todo, bot);

  if (!result.ok) {
    console.log(`  to-do #${todo.id} ignoré : ${result.reason}`);
    await finishTodo(todo.id);
    return;
  }

  const request = result.request;

  const auth = authorize(request);
  if (!auth.allowed) {
    console.log(`  to-do #${todo.id} REFUSÉ : ${auth.reason}`);
    await finishTodo(todo.id);
    return;
  }

  if (store.has(request.key)) {
    console.log(
      `  to-do #${todo.id} → ${request.key} DÉJÀ TRAITÉ (${store.statusOf(request.key)}), aucun repost`,
    );
    await finishTodo(todo.id);
    return;
  }

  // Réservation AVANT toute écriture : en cas de crash, on préfère perdre
  // une demande plutôt que de la traiter deux fois.
  store.record(request.key, todo.id, "claimed");
  console.log(`  to-do #${todo.id} → ${request.key} de @${request.requester}`);
  const marker = request.kind === "merge_requests" ? "!" : "#";
  console.log(`    ${request.projectPath} ${marker}${request.iid}`);
  console.log(`    « ${request.text.replace(/\n/g, " ").slice(0, 100)} »`);

  const position = queue.push(request);
  console.log(`    position dans la file : ${position}`);

  await acknowledge(request, position);
  store.record(request.key, todo.id, "acked");
  console.log(`    accusé de réception posté`);

  await finishTodo(todo.id);
}

async function collectTodos(): Promise<Todo[]> {
  const [pending, done] = await Promise.all([gitlab.pendingTodos(), gitlab.doneTodos()]);

  // Un to-do peut avoir été auto-résolu par une écriture du bot avant
  // qu'on l'ait lu. On rattrape donc les « done » récents.
  const cutoff = Date.now() - config.lookbackMs;
  const recentDone = done.filter((todo) => Date.parse(todo.created_at) >= cutoff);

  const byId = new Map<number, Todo>();
  for (const todo of [...pending, ...recentDone]) byId.set(todo.id, todo);

  // FIFO par date de création de la demande, pas par ordre de découverte.
  return [...byId.values()].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}

async function poll(): Promise<void> {
  const todos = (await collectTodos()).filter((todo) => !examined.has(todo.id));
  const stamp = new Date().toLocaleTimeString("fr-FR");

  if (todos.length === 0) {
    console.log(`[${stamp}] rien de neuf.`);
    return;
  }

  console.log(`[${stamp}] ${todos.length} to-do(s) à examiner :`);
  for (const todo of todos) {
    try {
      await handle(todo);
      examined.add(todo.id);
    } catch (error) {
      // Pas de marquage : la demande sera réessayée au prochain cycle.
      console.error(`  to-do #${todo.id} en échec : ${(error as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  bot = await gitlab.currentUser();
  console.log(`Compte du PAT : @${bot.username} (id ${bot.id})`);

  if (bot.username.toLowerCase() !== config.botUsername.toLowerCase()) {
    console.error(`ARRÊT : le PAT n'appartient pas à @${config.botUsername}.`);
    process.exit(1);
  }

  const interrupted = store.interrupted();
  if (interrupted.length > 0) {
    console.warn(
      `⚠︎ ${interrupted.length} demande(s) interrompue(s) par un arrêt brutal, non rejouée(s) :`,
    );
    for (const key of interrupted) console.warn(`   ${key}`);
  }

  console.log(`Journal : ${config.stateFile}`);
  console.log(`Polling toutes les ${config.pollIntervalMs / 1000} s.\n`);

  for (;;) {
    try {
      await poll();
    } catch (error) {
      if (error instanceof GitLabError && error.status === 401) {
        console.error("Token invalide ou expiré. Arrêt.");
        process.exit(1);
      }
      console.error(`[erreur] ${(error as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

void main();
