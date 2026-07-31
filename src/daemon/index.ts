import { dirname, join } from "node:path";
import { config } from "../config.ts";
import { gitlab, GitLabError, resourceKind } from "../gitlab/client.ts";
import { RequestStore, canProcess } from "./store.ts";
import type { AckHandle, AgentRequest, GitLabUser, Todo } from "../types.ts";
import { buildRequest } from "./request.ts";
import { authorize } from "./authorize.ts";
import { TaskQueue } from "./queue.ts";
import { ShutdownController, drain } from "./shutdown.ts";
import { runTask } from "../tasks/router.ts";
import { currentContainer, killContainer } from "../agent/sandbox.ts";
import { currentWorkspace } from "../agent/workspace.ts";
import { SeenTracker } from "./seen.ts";
import { bootstrapIfFresh } from "./bootstrap.ts";
import { collectTodos as collectTodosWith } from "./todos.ts";
import { ackBody } from "./ack.ts";
import { InstanceLock } from "./lock.ts";
import { log, withRequestContext } from "../log.ts";
import { daemonStatus } from "./status.ts";
import { startHealthServer, stopHealthServer, type HealthDeps } from "./health.ts";
import {
  SHUTDOWN_GRACE_MS,
  ABANDON_REASON_CHARS,
  REQUEST_LOG_EXCERPT_CHARS,
} from "../limits.ts";

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

// SHUTDOWN_GRACE_MS vient de src/limits.ts (§5.8) : délai maximal laissé à
// la tâche en cours pour se terminer d'elle-même quand un arrêt est demandé
// (SIGINT/SIGTERM), avant qu'on abandonne et sorte quand même — voir
// là-bas pour le raisonnement complet (pourquoi ce n'est pas une variable
// d'environnement de plus).

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
    log.warn(
      `${signal} reçu : arrêt gracieux (jusqu'à ${SHUTDOWN_GRACE_MS / 1000} s pour finir la tâche en cours). ` +
        `${signal} de nouveau pour forcer la sortie immédiate.`,
    );
    return;
  }
  log.error(`second ${signal} reçu : sortie immédiate, sans attendre.`);
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
 *
 * §6.4/§6.5 : ouvre aussi le contexte de corrélation (key/projectPath/iid,
 * voir log.ts) et la fenêtre d'observabilité (daemonStatus, voir status.ts)
 * pour toute la durée de l'exécution réelle du worker — séparément du
 * contexte ouvert plus bas par handle() avant la mise en file, puisque
 * runTask() démarre potentiellement bien après (une fois la tâche dépilée
 * par queue.ts, voir pump()), dans une chaîne d'appels asynchrones distincte.
 */
async function trackedWorker(request: AgentRequest): Promise<void> {
  await withRequestContext(
    { key: request.key, projectPath: request.projectPath, iid: request.iid },
    async () => {
      daemonStatus.taskStarted({
        key: request.key,
        projectPath: request.projectPath,
        iid: request.iid,
        since: Date.now(),
      });
      try {
        store.record(request.key, request.todoId, "running");
        await runTask(request);
        store.record(request.key, request.todoId, "done");
        daemonStatus.recordProcessed();
      } catch (error) {
        store.record(
          request.key,
          request.todoId,
          "failed",
          `échec worker : ${(error as Error).message}`,
        );
        throw error;
      } finally {
        daemonStatus.taskEnded();
      }
    },
  );
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

// ackBody() est extrait dans ack.ts (pur, testable indépendamment de main()
// — voir ack.test.ts) : ne mentionne plus le contrat de fiabilité de la file
// en mémoire dans le message posté sur GitLab (décision du propriétaire du
// projet, aucune annonce de contrat de fiabilité à l'utilisateur), voir le
// commentaire de ackBody() dans ack.ts pour où cette information vit
// désormais.

async function finishTodo(todoId: number): Promise<void> {
  if (config.skipMarkDone) {
    log.info(`to-do laissé pending (SKIP_MARK_DONE=1)`);
    return;
  }
  const outcome = await gitlab.markTodoDone(todoId);
  log.info(
    `to-do ${outcome === "done" ? "marqué done" : "déjà done côté GitLab"}`,
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
    log.warn(`réaction emoji impossible : ${(error as Error).message}`);
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
    // Pas encore une demande identifiable (buildRequest a refusé avant même
    // d'en construire une) : aucun key/projectPath/iid à corréler, voir
    // log.ts — cette ligne n'en invente pas.
    log.info(`to-do #${todo.id} ignoré : ${result.reason}`);
    await finishTodo(todo.id);
    return;
  }

  const request = result.request;

  // §6.4 : à partir d'ici, tout ce que cette fonction (et ce qu'elle appelle)
  // journalise porte key/projectPath/iid sans avoir à les passer en
  // paramètre — voir log.ts. trackedWorker() ouvre sa propre fenêtre
  // équivalente, séparément, pour l'exécution du worker (voir plus haut).
  await withRequestContext(
    { key: request.key, projectPath: request.projectPath, iid: request.iid },
    async () => {
      const auth = authorize(request);
      if (!auth.allowed) {
        log.info(`to-do #${todo.id} REFUSÉ : ${auth.reason}`);
        daemonStatus.recordRefused();
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
        log.info(
          `to-do #${todo.id} → ${request.key} DÉJÀ TRAITÉ (${status}), aucun repost`,
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
        log.info(`to-do #${todo.id} → ${request.key} de @${request.requester}`);
        const marker = request.kind === "merge_requests" ? "!" : "#";
        log.info(`${request.projectPath} ${marker}${request.iid}`);
        log.info(
          `« ${request.text.replace(/\n/g, " ").slice(0, REQUEST_LOG_EXCERPT_CHARS)} »`,
        );

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
        log.info(`position dans la file : ${actualPosition}`);
        store.record(request.key, todo.id, "acked");
        log.info(`accusé de réception posté (note ${ack.ackNoteId})`);

        await finishTodo(todo.id);
      } catch (error) {
        // On remonte la clé, pas seulement le message : poll() en a besoin pour
        // marquer la demande "failed" dans le store si les tentatives s'épuisent
        // (voir notifyGiveUp plus bas).
        throw new HandleFailure((error as Error).message, request.key);
      }
    },
  );
}

// collectTodos() est extrait dans todos.ts (dépendances injectées, testable
// sans réseau — voir todos.test.ts) : le filtre de rattrapage des to-dos
// "done" récents porte sur `updated_at`, pas `created_at` — voir le
// commentaire de collectTodos() dans todos.ts pour le raisonnement complet.
function collectTodos(): Promise<Todo[]> {
  return collectTodosWith({
    pendingTodos: gitlab.pendingTodos,
    doneTodos: gitlab.doneTodos,
    lookbackMs: config.lookbackMs,
  });
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
    log.warn(
      `notification de refus impossible : ${(error as Error).message}`,
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
      `🤖 Demande abandonnée après ${config.maxAttempts} tentatives.\n\n\`\`\`\n${reason.slice(0, ABANDON_REASON_CHARS)}\n\`\`\`\n\n<sub>cds-agent</sub>`,
    );
  } catch (error) {
    log.error(`notification impossible : ${(error as Error).message}`);
  }
}

async function poll(): Promise<void> {
  const todos = (await collectTodos()).filter((todo) => !seen.hasExamined(todo.id));
  const stamp = new Date().toLocaleTimeString("fr-FR");

  if (todos.length === 0) {
    log.info(`[${stamp}] rien de neuf.`);
    return;
  }

  log.info(`[${stamp}] ${todos.length} to-do(s) à examiner :`);
  for (const todo of todos) {
    // Arrêt demandé en cours de cycle : on ne réclame (store.record("claimed"))
    // ni ne poste d'accusé de réception pour aucun to-do supplémentaire. Ceux
    // qui restent ici n'ont pas encore été touchés : ils seront repris tels
    // quels au prochain démarrage du daemon.
    if (shutdown.isStopping) {
      log.info(
        `arrêt en cours : to-do #${todo.id} laissé de côté, sera repris au prochain démarrage`,
      );
      break;
    }
    try {
      await handle(todo);
      seen.markExamined(todo.id);
    } catch (error) {
      const count = seen.recordFailure(todo.id);
      const message = (error as Error).message;
      // handle() a déjà fermé son propre contexte de corrélation (voir
      // withRequestContext plus haut) au moment où cette exception atteint
      // ce catch : on rattache donc la clé explicitement (extra), plutôt que
      // de laisser cette ligne — pourtant bien "pendant le traitement" de
      // cette demande précise — sans elle. Absente si l'échec a eu lieu
      // avant buildRequest (pas encore une demande identifiable).
      const correlation =
        error instanceof HandleFailure && error.key
          ? { key: error.key }
          : undefined;

      if (count < config.maxAttempts) {
        log.error(
          `to-do #${todo.id} en échec (${count}/${config.maxAttempts}) : ${message}`,
          correlation,
        );
        continue;
      }

      // Plafond atteint : on abandonne, mais le demandeur doit être prévenu.
      log.error(
        `to-do #${todo.id} ABANDONNÉ après ${count} tentatives : ${message}`,
        correlation,
      );
      daemonStatus.recordAbandoned();
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

/**
 * Dépendances du serveur d'observabilité (§6.5), construites à partir des
 * instances réelles du module (queue, daemonStatus, shutdown) : health.ts ne
 * les importe jamais directement, pour rester testable sans process réel
 * (voir health.test.ts).
 */
const healthDeps: HealthDeps = {
  queueDepth: () => queue.depth,
  currentTask: () => daemonStatus.getCurrentTask(),
  lastPollSuccessAt: () => daemonStatus.getLastPollSuccessAt(),
  counters: () => daemonStatus.getCounters(),
  startedAt: daemonStatus.getStartedAt(),
  pollIntervalMs: config.pollIntervalMs,
  agentTimeoutMs: config.agentTimeoutMs,
  commandTimeoutMs: config.commandTimeoutMs,
};

/** Instance du serveur d'observabilité, mise en place par main() — voir shutdownSequence() pour son arrêt. */
let health: ReturnType<typeof startHealthServer>;

async function main(): Promise<void> {
  // Posé avant tout appel réseau : si une autre instance tourne déjà, autant
  // le savoir sans même attendre une réponse de GitLab (voir lock.ts, §3.9).
  const lockResult = lock.acquire();
  if (!lockResult.acquired) {
    log.error(
      `ARRÊT : une autre instance tourne déjà (PID ${lockResult.heldByPid}, verrou ${LOCK_FILE}). ` +
        `Si ce PID n'existe plus, le verrou sera repris automatiquement au prochain démarrage.`,
    );
    process.exit(1);
  }

  // §6.5 : démarré tôt (avant même la vérification du PAT) — /healthz doit
  // pouvoir répondre dès que le process tourne, y compris pendant les
  // quelques appels réseau qui suivent au démarrage.
  health = startHealthServer(healthDeps, {
    enabled: config.healthEnabled,
    port: config.healthPort,
    host: config.healthHost,
  });

  bot = await gitlab.currentUser();
  log.info(`Compte du PAT : @${bot.username} (id ${bot.id})`);

  if (bot.username.toLowerCase() !== config.botUsername.toLowerCase()) {
    log.error(`ARRÊT : le PAT n'appartient pas à @${config.botUsername}.`);
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

    log.warn(
      `⚠︎ ${interrupted.length} demande(s) interrompue(s) par le précédent arrêt :`,
    );
    for (const entry of stuck) {
      log.warn(
        `${entry.key} (running) — interrompue en pleine exécution, PAS rejouée automatiquement, à vérifier`,
      );
    }
    for (const entry of replayable) {
      log.warn(
        `${entry.key} (${entry.status}) — sera rejouée si le to-do est toujours ouvert côté GitLab`,
      );
    }
  }

  await bootstrapIfFresh(isFreshStore, {
    collectTodos,
    finishTodo,
    markExamined: (todoId) => seen.markExamined(todoId),
    log: (message) => log.warn(message),
  });

  log.info(`Journal : ${config.stateFile}`);
  log.info(`Polling toutes les ${config.pollIntervalMs / 1000} s.`);

  while (!shutdown.isStopping) {
    try {
      await poll();
      daemonStatus.pollSucceeded(Date.now());
    } catch (error) {
      if (error instanceof GitLabError && error.status === 401) {
        log.error("Token invalide ou expiré. Arrêt.");
        process.exit(1);
      }
      log.error(`[erreur] ${(error as Error).message}`);
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
  log.info("Arrêt du daemon : fin du polling, drainage de la file...");

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
        log.warn(
          `${request.key} abandonnée avant démarrage (arrêt du daemon)`,
        );
      }
    },
  });

  // §6.5 : le serveur d'observabilité s'arrête avec le reste — branché sur
  // la même séquence de drain que la file (shutdown.ts), pas laissé ouvert
  // après que le daemon a par ailleurs fini de tourner.
  await stopHealthServer(health);

  if (outcome === "clean") {
    log.info("Arrêt propre.");
    process.exit(0);
  }

  log.error(
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
    log.warn(`conteneur ${container} encore actif : kill...`);
    await killContainer(container);
  }

  const workspace = currentWorkspace();
  if (workspace) {
    log.warn(`workspace ${workspace.root} encore présent : suppression...`);
    try {
      workspace.dispose();
    } catch (error) {
      log.error(`nettoyage du workspace impossible : ${(error as Error).message}`);
    }
  }
}

void main();
