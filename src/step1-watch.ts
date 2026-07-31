import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./env.ts";
import { api, GitLabError } from "./gitlab.ts";
import type { GitLabUser, Todo } from "./types.ts";

const RELEVANT_ACTIONS = new Set(["mentioned", "directly_addressed"]);
const alreadyDisplayed = new Set<number>();

async function preflight(): Promise<void> {
  const me = await api<GitLabUser>("/user");
  console.log(`Instance : ${config.gitlabUrl}`);
  console.log(`Compte du PAT : @${me.username} (id ${me.id}, « ${me.name} »)`);

  if (me.username.toLowerCase() !== config.botUsername.toLowerCase()) {
    console.error(
      `\nARRÊT. Le PAT appartient à @${me.username}, mais BOT_USERNAME vaut « ${config.botUsername} ».\n` +
        `GitLab ne crée jamais de to-do pour l'auteur d'un commentaire. Si tu mentionnes\n` +
        `@${config.botUsername} depuis le compte propriétaire de ce PAT, la boucle ne verra\n` +
        `jamais rien. Utilise le PAT du compte bot.`,
    );
    process.exit(1);
  }

  mkdirSync(config.dumpDir, { recursive: true });
  console.log(`Polling toutes les ${config.pollIntervalMs / 1000} s. Ctrl-C pour arrêter.\n`);
}

function report(todo: Todo): void {
  const target =
    todo.target_type === "MergeRequest"
      ? `MR !${todo.target?.iid ?? "?"}`
      : todo.target_type === "Issue"
        ? `issue #${todo.target?.iid ?? "?"}`
        : todo.target_type;

  const relevant = RELEVANT_ACTIONS.has(todo.action_name);
  const mentionsBot = todo.body.includes(`@${config.botUsername}`);

  console.log(`  ${relevant ? "✓" : "·"} to-do #${todo.id}  [${todo.action_name}]  ${target}`);
  console.log(`      projet    : ${todo.project?.path_with_namespace ?? "—"} (id ${todo.project?.id ?? "—"})`);
  console.log(`      auteur    : @${todo.author.username}`);
  console.log(`      créé le   : ${todo.created_at}`);
  console.log(`      url       : ${todo.target_url}`);
  console.log(`      body      : ${todo.body.length} car. ${JSON.stringify(todo.body.slice(0, 140))}`);
  console.log(`      @bot dans body : ${mentionsBot ? "oui" : "NON"}`);

  if (todo.note) {
    const truncated = todo.note.body.length !== todo.body.length;
    console.log(`      note.id   : ${todo.note.id}`);
    console.log(`      note.body : ${todo.note.body.length} car.${truncated ? "  ⚠︎ body du to-do TRONQUÉ" : "  (identique au body)"}`);
  } else {
    console.log(`      note      : ABSENTE de la réponse → il faudra la retrouver via l'API notes`);
  }

  const dump = join(config.dumpDir, `todo-${todo.id}.json`);
  writeFileSync(dump, JSON.stringify(todo, null, 2), "utf8");
  console.log(`      JSON brut : ${dump}\n`);
}

async function poll(): Promise<void> {
  const todos = await api<Todo[]>("/todos?state=pending&per_page=100");
  const fresh = todos.filter((todo) => !alreadyDisplayed.has(todo.id));

  const stamp = new Date().toLocaleTimeString("fr-FR");
  if (fresh.length === 0) {
    console.log(`[${stamp}] ${todos.length} to-do(s) pending, rien de nouveau.`);
    return;
  }

  console.log(`[${stamp}] ${fresh.length} nouveau(x) to-do(s) sur ${todos.length} pending :\n`);
  for (const todo of fresh) {
    alreadyDisplayed.add(todo.id);
    report(todo);
  }
}

async function main(): Promise<void> {
  await preflight();
  for (;;) {
    try {
      await poll();
    } catch (error) {
      if (error instanceof GitLabError) {
        console.error(`[erreur API] ${error.message}`);
        if (error.status === 401) {
          console.error("Token invalide ou expiré. Arrêt.");
          process.exit(1);
        }
      } else {
        console.error(`[erreur réseau] ${(error as Error).message}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

void main();
