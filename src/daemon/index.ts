import { config } from "../config.ts";
import { gitlab, GitLabError, resourceKind } from "../gitlab/client.ts";
import { RequestStore, canProcess } from "./store.ts";
import type { AgentRequest, GitLabUser, Todo } from "../types.ts";
import { buildRequest, defuseMentions } from "./request.ts";
import { authorize } from "./authorize.ts";
import { TaskQueue } from "./queue.ts";
import { ShutdownController, drain } from "./shutdown.ts";
import { runTask } from "../tasks/router.ts";
import { currentContainer, killContainer } from "../agent/sandbox.ts";
import { currentWorkspace } from "../agent/workspace.ts";

const store = new RequestStore(config.stateFile);
let bot: GitLabUser;

/**
 * Délai maximal laissé à la tâche en cours pour se terminer d'elle-même
 * quand un arrêt est demandé (SIGINT/SIGTERM), avant qu'on abandonne et
 * sorte quand même. Volontairement une constante locale plutôt qu'une
 * variable d'environnement de plus dans config.ts (déjà bien chargé) : ce
 * réglage n'a jamais eu besoin d'être ajusté en pratique, contrairement à
 * pollIntervalMs ou aux timeouts de commande.
 */
const SHUTDOWN_GRACE_MS = 30_000;

const shutdown = new ShutdownController();

/**
 * Premier SIGINT/SIGTERM : bascule en arrêt gracieux (voir shutdown.ts),
 * réveille immédiatement une attente de polling en cours, et laisse la
 * boucle principale dérouler la séquence de drain jusqu'à sa fin naturelle.
 * Second signal : "forced" — quelqu'un qui tape Ctrl-C deux fois veut que ça
 * s'arrête maintenant, on ne tente donc plus rien de propre et on sort tout
 * de suite (process.exit ne tue pas les processus enfants déjà lancés —
 * docker run, notamment — mais c'est le prix d'une sortie immédiate).
 */
function onSignal(signal: NodeJS.Signals): void {
  const phase = shutdown.registerSignal();
  if (phase === "draining") {
    console.warn(
      `\n⚠︎ ${signal} reçu : arrêt gracieux (jusqu'à ${SHUTDOWN_GRACE_MS / 1000} s pour finir la tâche en cours). ` +
        `${signal} de nouveau pour forcer la sortie immédiate.`,
    );
    return;
  }
  console.error(`\n⚠︎ second ${signal} reçu : sortie immédiate, sans attendre.`);
  process.exit(130);
}

process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

/**
 * Le worker ne connaissait jusqu'ici que sa propre exécution : ni le
 * démarrage ("running"), ni l'issue ("done"/"failed") n'étaient visibles du
 * store. On les alimente ici plutôt que dans router.ts, pour que runTask
 * reste indépendant de la persistance des statuts. runTask avale déjà ses
 * propres erreurs (elle rapporte l'échec au demandeur puis retourne
 * normalement) : le chemin "failed" ci-dessous ne se déclenche donc pas en
 * pratique aujourd'hui, mais reste correct si runTask se met un jour à
 * relancer une exception.
 */
async function trackedWorker(request: AgentRequest): Promise<void> {
  store.record(request.key, request.todoId, "running");
  try {
    await runTask(request);
    store.record(request.key, request.todoId, "done");
  } catch (error) {
    store.record(
      request.key,
      request.todoId,
      "failed",
      `échec worker : ${(error as Error).message}`,
    );
    throw error;
  }
}

const queue = new TaskQueue(trackedWorker, (request) => request.key);
const examined = new Set<number>();
const attempts = new Map<number, number>();

/**
 * Porte la clé de la demande jusqu'au catch de poll(), pour que l'abandon
 * après épuisement des tentatives puisse marquer la demande "failed" dans le
 * store (voir plus bas) — sans quoi une demande abandonnée resterait à
 * "claimed"/"acked" et serait rejouée indéfiniment à chaque redémarrage
 * tombant dans la fenêtre de rattrapage des to-dos "done" récents.
 */
class HandleFailure extends Error {
  readonly key: string | undefined;
  constructor(message: string, key: string | undefined) {
    super(message);
    this.name = "HandleFailure";
    this.key = key;
  }
}

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
    // La file d'attente est en mémoire (voir queue.ts) : un arrêt ou un
    // crash du daemon avant que cette tâche ne démarre la perd purement et
    // simplement, sans notification ultérieure — le to-do GitLab est déjà
    // marqué "done" par finishTodo() au moment où cet accusé de réception
    // part, donc rien ne la fera réapparaître au redémarrage. Mieux vaut le
    // dire ici que laisser croire à une garantie de traitement qui n'existe
    // pas (voir aussi le commentaire au-dessus de onStranded dans main()).
    `<sub>cds-agent · POC local · clé \`${request.key}\` · file en mémoire, non garantie en cas de redémarrage du daemon avant traitement</sub>`,
  ].join("\n");
}

async function finishTodo(todoId: number): Promise<void> {
  if (config.skipMarkDone) {
    console.log(`    to-do laissé pending (SKIP_MARK_DONE=1)`);
    return;
  }
  const outcome = await gitlab.markTodoDone(todoId);
  console.log(
    `    to-do ${outcome === "done" ? "marqué done" : "déjà done côté GitLab"}`,
  );
}

async function acknowledge(
  request: AgentRequest,
  position: number,
): Promise<void> {
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
  if (process.env.FORCE_HANDLE_ERROR === "1") {
    throw new Error("échec simulé pour tester le compteur");
  }

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

  const status = store.statusOf(request.key);
  if (!canProcess(status)) {
    console.log(
      `  to-do #${todo.id} → ${request.key} DÉJÀ TRAITÉ (${status}), aucun repost`,
    );
    await finishTodo(todo.id);
    return;
  }

  try {
    // Réservation AVANT toute écriture : en cas de crash, on préfère perdre
    // une demande plutôt que de la traiter deux fois. Sans effet si le
    // statut est déjà "claimed" ou "acked" (rejeu) : record() est monotone.
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
  } catch (error) {
    // On remonte la clé, pas seulement le message : poll() en a besoin pour
    // marquer la demande "failed" dans le store si les tentatives s'épuisent
    // (voir notifyGiveUp plus bas).
    throw new HandleFailure((error as Error).message, request.key);
  }
}

async function collectTodos(): Promise<Todo[]> {
  const [pending, done] = await Promise.all([
    gitlab.pendingTodos(),
    gitlab.doneTodos(),
  ]);

  // Un to-do peut avoir été auto-résolu par une écriture du bot avant
  // qu'on l'ait lu. On rattrape donc les « done » récents.
  const cutoff = Date.now() - config.lookbackMs;
  const recentDone = done.filter(
    (todo) => Date.parse(todo.created_at) >= cutoff,
  );

  const byId = new Map<number, Todo>();
  for (const todo of [...pending, ...recentDone]) byId.set(todo.id, todo);

  // FIFO par date de création de la demande, pas par ordre de découverte.
  return [...byId.values()].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}

/** Le demandeur ne doit jamais rester sans réponse, même quand tout casse. */
async function notifyGiveUp(todo: Todo, reason: string): Promise<void> {
  const kind = resourceKind(todo.target_type);
  const projectId = todo.project?.id;
  const iid = todo.target?.iid;
  if (!kind || !projectId || !iid) return;

  try {
    await gitlab.createNote(
      projectId,
      kind,
      iid,
      `🤖 Demande abandonnée après ${config.maxAttempts} tentatives.\n\n\`\`\`\n${reason.slice(0, 500)}\n\`\`\`\n\n<sub>cds-agent</sub>`,
    );
  } catch (error) {
    console.error(`    notification impossible : ${(error as Error).message}`);
  }
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
    // Arrêt demandé en cours de cycle : on ne réclame (store.record("claimed"))
    // ni ne poste d'accusé de réception pour aucun to-do supplémentaire. Ceux
    // qui restent ici n'ont pas encore été touchés : ils seront repris tels
    // quels au prochain démarrage du daemon.
    if (shutdown.isStopping) {
      console.log(
        `  arrêt en cours : to-do #${todo.id} laissé de côté, sera repris au prochain démarrage`,
      );
      break;
    }
    try {
      await handle(todo);
      examined.add(todo.id);
      attempts.delete(todo.id);
    } catch (error) {
      const count = (attempts.get(todo.id) ?? 0) + 1;
      attempts.set(todo.id, count);
      const message = (error as Error).message;

      if (count < config.maxAttempts) {
        console.error(
          `  to-do #${todo.id} en échec (${count}/${config.maxAttempts}) : ${message}`,
        );
        continue;
      }

      // Plafond atteint : on abandonne, mais le demandeur doit être prévenu.
      console.error(
        `  to-do #${todo.id} ABANDONNÉ après ${count} tentatives : ${message}`,
      );
      examined.add(todo.id);
      attempts.delete(todo.id);
      // Statut terminal explicite : sans lui, la demande resterait à
      // "claimed"/"acked" et un redémarrage tombant dans la fenêtre de
      // rattrapage des to-dos "done" récents la rejouerait, malgré
      // l'abandon. Pas de clé quand l'échec a eu lieu avant buildRequest
      // (rien à marquer, ce n'était pas encore une demande identifiable).
      if (error instanceof HandleFailure && error.key) {
        store.record(error.key, todo.id, "failed", `abandonné après ${count} tentatives`);
      }
      await notifyGiveUp(todo, message);
      await finishTodo(todo.id);
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
    // running : le worker avait démarré, peut-être en plein push — jamais
    // rejoué automatiquement (voir canProcess()), à vérifier à la main.
    // claimed/acked : rien d'irréversible n'a eu lieu, le rejeu se fera tout
    // seul au prochain sondage si le to-do est toujours ouvert côté GitLab.
    const stuck = interrupted.filter((entry) => entry.status === "running");
    const replayable = interrupted.filter((entry) => entry.status !== "running");

    console.warn(
      `⚠︎ ${interrupted.length} demande(s) interrompue(s) par le précédent arrêt :`,
    );
    for (const entry of stuck) {
      console.warn(
        `   ${entry.key} (running) — interrompue en pleine exécution, PAS rejouée automatiquement, à vérifier`,
      );
    }
    for (const entry of replayable) {
      console.warn(
        `   ${entry.key} (${entry.status}) — sera rejouée si le to-do est toujours ouvert côté GitLab`,
      );
    }
  }

  console.log(`Journal : ${config.stateFile}`);
  console.log(`Polling toutes les ${config.pollIntervalMs / 1000} s.\n`);

  while (!shutdown.isStopping) {
    try {
      await poll();
    } catch (error) {
      if (error instanceof GitLabError && error.status === 401) {
        console.error("Token invalide ou expiré. Arrêt.");
        process.exit(1);
      }
      console.error(`[erreur] ${(error as Error).message}`);
    }
    if (shutdown.isStopping) break;
    // sleep() (et non un setTimeout brut) : un signal doit réveiller cette
    // attente immédiatement, pas seulement après pollIntervalMs — jusqu'à 1h
    // avec les bornes de config.ts. Voir shutdown.ts.
    await shutdown.sleep(config.pollIntervalMs);
  }

  await shutdownSequence();
}

/**
 * Séquence de sortie une fois la boucle de polling arrêtée : ferme la file
 * (plus aucun push()), rend explicite dans le store la perte de ce qui n'a
 * jamais démarré, puis attend au plus SHUTDOWN_GRACE_MS que la tâche en
 * cours (s'il y en a une) se termine avant d'abandonner.
 *
 * Sur ce dernier point : une tâche "running" au moment de l'abandon n'est
 * PAS marquée "failed" ici — c'est canProcess() qui en décide (voir
 * store.ts), et il l'interdit délibérément : on ne sait pas si le worker a
 * déjà poussé du code. Le prochain démarrage la signalera via
 * store.interrupted() comme "à vérifier à la main", exactement comme un
 * crash (voir plus haut dans main()) : un arrêt volontaire n'est pas plus
 * sûr qu'un crash pour une tâche déjà en vol.
 */
async function shutdownSequence(): Promise<void> {
  console.log("\nArrêt du daemon : fin du polling, drainage de la file...");

  const outcome = await drain({
    queue,
    gracePeriodMs: SHUTDOWN_GRACE_MS,
    // Ce qui n'a jamais démarré n'a, par construction de handle(), plus
    // rien à voir avec GitLab : l'accusé de réception a déjà été posté et
    // le to-do déjà marqué "done" avant même que push() ne rende la main
    // (voir handle()). Rien ne le rejouera jamais tout seul. Le laisser à
    // "acked" ferait croire à tort, via interrupted() au prochain
    // démarrage, qu'un rejeu automatique est possible — on le marque donc
    // "failed" ici, avec une raison qui dit la vérité : la perte devient un
    // fait consigné plutôt qu'une promesse non tenue silencieuse.
    onStranded: (stranded) => {
      for (const request of stranded) {
        store.record(
          request.key,
          request.todoId,
          "failed",
          "file en mémoire perdue à l'arrêt du daemon (jamais démarrée)",
        );
        console.warn(
          `   ${request.key} abandonnée avant démarrage (arrêt du daemon)`,
        );
      }
    },
  });

  if (outcome === "clean") {
    console.log("Arrêt propre.");
    process.exit(0);
  }

  console.error(
    `⚠︎ la tâche en cours n'a pas fini dans le délai de grâce (${SHUTDOWN_GRACE_MS / 1000} s) : abandon.`,
  );
  await cleanupActiveResources();
  process.exit(1);
}

/**
 * Nettoyage best-effort de ce que la tâche abandonnée ci-dessus a pu
 * laisser ouvert. Un seul worker tourne à la fois (voir queue.ts), donc au
 * plus un conteneur et un workspace sont concernés — voir currentContainer()
 * dans sandbox.ts et currentWorkspace() dans workspace.ts. Ne prétend pas
 * couvrir tous les cas (le "second signal" ci-dessus sort avant même
 * d'appeler cette fonction) : une vraie comptabilité des ressources actives
 * demanderait de suivre chaque tâche individuellement, ce qui n'est pas
 * justifié tant qu'il n'y a jamais qu'une tâche en vol.
 */
async function cleanupActiveResources(): Promise<void> {
  const container = currentContainer();
  if (container) {
    console.warn(`   conteneur ${container} encore actif : kill...`);
    await killContainer(container);
  }

  const workspace = currentWorkspace();
  if (workspace) {
    console.warn(`   workspace ${workspace.root} encore présent : suppression...`);
    try {
      workspace.dispose();
    } catch (error) {
      console.error(`   nettoyage du workspace impossible : ${(error as Error).message}`);
    }
  }
}

void main();
