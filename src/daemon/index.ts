import { dirname, join } from "node:path";
import { config } from "../config.ts";
import { gitlab, GitLabError, resourceKind } from "../gitlab/client.ts";
import { RequestStore, canProcess } from "./store.ts";
import type { AckHandle, AgentRequest, GitLabUser, Todo } from "../types.ts";
import { buildRequest, defuseMentions } from "./request.ts";
import { authorize } from "./authorize.ts";
import { TaskQueue } from "./queue.ts";
import { ShutdownController, drain } from "./shutdown.ts";
import { runTask } from "../tasks/router.ts";
import { currentContainer, killContainer } from "../agent/sandbox.ts";
import { currentWorkspace } from "../agent/workspace.ts";
import { SeenTracker } from "./seen.ts";
import { bootstrapIfFresh } from "./bootstrap.ts";
import { InstanceLock } from "./lock.ts";

const store = new RequestStore(config.stateFile);
let bot: GitLabUser;

/**
 * Fichier de verrou d'instance (§3.9), rangé à côté du fichier d'état
 * plutôt que défini via une nouvelle variable d'environnement : ce chemin
 * n'a jamais eu besoin d'être ajusté indépendamment de STATE_FILE en
 * pratique, voir InstanceLock dans lock.ts pour le mécanisme complet.
 */
const LOCK_FILE = join(dirname(config.stateFile), "daemon.lock");
const lock = new InstanceLock(LOCK_FILE);
// Libère le verrou sur TOUTE sortie du process (process.exit() explicite,
// fin naturelle de l'event loop, exception non rattrapée...) plutôt que de
// disperser des appels à lock.release() à chaque site de sortie : l'événement
// "exit" est synchrone et se déclenche dans tous les cas, voir doc Node.
process.on("exit", () => lock.release());

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
// §3.8 : SeenTracker unifie l'ancien `examined: Set<number>` et l'ancien
// `attempts: Map<number, number>`, tous deux non bornés, en une seule
// structure purgée par âge — voir seen.ts pour ce que chacun garantissait
// réellement et pourquoi lookbackMs est l'horizon de purge correct.
const seen = new SeenTracker(config.lookbackMs);

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

/**
 * §6.10 : pose l'accusé de réception et sa réaction 👀, et renvoie de quoi
 * les retrouver ensuite — l'identifiant de la note (pour l'éditer avec le
 * résultat final) et celui de la réaction (pour la remplacer par ✅/❌,
 * l'API award emoji n'ayant pas de mise à jour en place). Voir
 * tasks/router.ts::report(), seul autre endroit qui connaît ces
 * identifiants, via AgentRequest.ack (types.ts).
 */
async function acknowledge(
  request: AgentRequest,
  position: number,
): Promise<AckHandle> {
  const { projectId, kind, iid, noteId } = request;

  let awardId: number | null = null;
  try {
    const award =
      noteId === null
        ? await gitlab.awardOnResource(projectId, kind, iid, "eyes")
        : await gitlab.awardOnNote(projectId, kind, iid, noteId, "eyes");
    awardId = award.id;
  } catch (error) {
    console.warn(`    réaction emoji impossible : ${(error as Error).message}`);
  }

  const ackNote = await gitlab.createNote(
    projectId,
    kind,
    iid,
    ackBody(request, position),
  );
  return { ackNoteId: ackNote.id, awardId };
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
    // Voir authorize.ts pour le raisonnement complet (§3.11) : un dépôt hors
    // périmètre reste silencieux (ne pas révéler l'existence du bot, ni
    // permettre d'énumérer les dépôts surveillés) ; un auteur refusé sur un
    // dépôt AUTORISÉ reçoit une réponse explicite (c'est peut-être un
    // collègue légitime qu'il suffit d'ajouter à ALLOWED_USERS).
    if (!auth.silent) {
      await notifyUnauthorized(request, auth.reason);
    }
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
    // Nuance documentée sur record() (store.ts) : cette garantie suppose que
    // la ligne "claimed" a effectivement atteint le disque, ce
    // qu'`appendFileSync` seul ne garantit pas (pas de fsync).
    store.record(request.key, todo.id, "claimed");
    console.log(`  to-do #${todo.id} → ${request.key} de @${request.requester}`);
    const marker = request.kind === "merge_requests" ? "!" : "#";
    console.log(`    ${request.projectPath} ${marker}${request.iid}`);
    console.log(`    « ${request.text.replace(/\n/g, " ").slice(0, 100)} »`);

    // §6.10 : l'accusé de réception doit être posté — et son identifiant
    // connu — AVANT d'empiler la tâche dans la file, pas après (contrairement
    // à l'ordre précédent, qui poussait d'abord et acquittait ensuite) : sans
    // ça, le worker pourrait démarrer et vouloir publier son résultat
    // (tasks/router.ts::report()) avant que l'identifiant de la note
    // d'accusé de réception ne soit connu, une course que rien ne
    // garantissait de gagner (report() aurait alors dû se rabattre sur une
    // nouvelle note, perdant l'objectif "une seule note"). queue.depth, lu
    // juste avant l'accusé de réception, donne la position prévisionnelle de
    // cette tâche — rien d'autre ne peut modifier la file entre cette
    // lecture et le push() qui suit, aucun `await` ne s'intercale entre les
    // deux. Purement informatif (comme avant ce changement) : par
    // construction, cette tâche est la seule sous cette clé (canProcess()
    // l'a autorisée plus haut) donc jamais dédupliquée au push.
    const position = queue.depth + 1;
    const ack = await acknowledge(request, position);
    const enqueued: AgentRequest = { ...request, ack };

    const actualPosition = queue.push(enqueued);
    console.log(`    position dans la file : ${actualPosition}`);
    store.record(request.key, todo.id, "acked");
    console.log(`    accusé de réception posté (note ${ack.ackNoteId})`);

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

/**
 * Réponse explicite au refus d'autorisation quand elle est utile au
 * demandeur (voir authorize.ts pour la distinction avec le cas silencieux,
 * §3.11) : sans elle, un collègue légitime sur un dépôt autorisé croirait le
 * bot en panne au lieu de comprendre qu'il lui suffit de se faire ajouter à
 * ALLOWED_USERS. Best-effort comme notifyGiveUp ci-dessous : un échec de
 * cette notification ne doit pas empêcher de classer le to-do comme traité.
 */
async function notifyUnauthorized(
  request: AgentRequest,
  reason: string,
): Promise<void> {
  const body = [
    `🤖 Demande de @${request.requester} refusée : ${reason}.`,
    "",
    "Si vous pensez que c'est une erreur, demandez à un mainteneur de vous ajouter à la liste des auteurs autorisés.",
    "",
    "<sub>cds-agent</sub>",
  ].join("\n");

  try {
    await gitlab.createNote(request.projectId, request.kind, request.iid, body);
  } catch (error) {
    console.warn(
      `    notification de refus impossible : ${(error as Error).message}`,
    );
  }
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
  const todos = (await collectTodos()).filter((todo) => !seen.hasExamined(todo.id));
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
      seen.markExamined(todo.id);
    } catch (error) {
      const count = seen.recordFailure(todo.id);
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
      seen.markExamined(todo.id);
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
  // Posé avant tout appel réseau : si une autre instance tourne déjà, autant
  // le savoir sans même attendre une réponse de GitLab (voir lock.ts, §3.9).
  const lockResult = lock.acquire();
  if (!lockResult.acquired) {
    console.error(
      `ARRÊT : une autre instance tourne déjà (PID ${lockResult.heldByPid}, verrou ${LOCK_FILE}). ` +
        `Si ce PID n'existe plus, le verrou sera repris automatiquement au prochain démarrage.`,
    );
    process.exit(1);
  }

  bot = await gitlab.currentUser();
  console.log(`Compte du PAT : @${bot.username} (id ${bot.id})`);

  if (bot.username.toLowerCase() !== config.botUsername.toLowerCase()) {
    console.error(`ARRÊT : le PAT n'appartient pas à @${config.botUsername}.`);
    process.exit(1);
  }

  // Capturé AVANT le moindre traitement : c'est la seule fenêtre où
  // store.isEmpty() reflète fidèlement "tout premier démarrage" (voir
  // bootstrap.ts, §3.7) plutôt qu'un état déjà modifié par ce run.
  const isFreshStore = store.isEmpty();

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

  await bootstrapIfFresh(isFreshStore, {
    collectTodos,
    finishTodo,
    markExamined: (todoId) => seen.markExamined(todoId),
    log: (message) => console.warn(message),
  });

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
