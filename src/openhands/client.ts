/**
 * Client HTTP de l'application server OpenHands (API V1).
 *
 * TOUT ce que ce module suppose de l'API a été relevé dans le code du serveur,
 * pas déduit d'un exemple ni d'un billet de blog — voir docs/openhands.md,
 * section « Ce qui a été vérifié, et où ». Les références ci-dessous pointent
 * vers les fichiers du dépôt OpenHands/legacy (le code Python de
 * l'application server, dont l'image `openhands` est construite) :
 *
 * - `openhands/app_server/v1_router.py` : tous les routeurs V1 sont montés
 *   sous le préfixe `/api/v1`.
 * - `openhands/app_server/app_conversation/app_conversation_router.py` : le
 *   routeur des conversations ajoute `/app-conversations`, d'où les chemins
 *   complets utilisés ici. `POST ''` démarre une conversation et rend un
 *   AppConversationStartTask ; `GET ''` et `GET '/start-tasks'` sont des
 *   lectures PAR LOT — leur paramètre s'appelle `ids` (au pluriel) et la
 *   réponse est un TABLEAU aligné sur les identifiants demandés, avec `null`
 *   pour ceux qui n'existent pas. Ce n'est pas un `GET /<id>` : il n'y en a
 *   pas pour ces deux ressources.
 * - `openhands/app_server/utils/dependencies.py` : l'authentification d'une
 *   instance auto-hébergée est un en-tête `X-Session-API-Key` comparé à la
 *   variable d'environnement SESSION_API_KEY du serveur. Ce n'est PAS
 *   `Authorization: Bearer` — ça, c'est l'API de l'offre Cloud. Et si
 *   SESSION_API_KEY n'est pas positionnée côté serveur, l'API n'est pas
 *   protégée du tout (voir get_dependencies : la dépendance de contrôle n'est
 *   même pas installée).
 * - `openhands/app_server/app_conversation/app_conversation_models.py` et
 *   `openhands/sdk/conversation/state.py` : les trois énumérations de statut
 *   recopiées plus bas.
 *
 * Aucune dépendance à `config` ni à `log` : `fetch` est injecté, ce qui rend
 * la construction de la requête, la lecture de la réponse, les statuts et le
 * timeout testables sans réseau ni serveur (voir tests/openhands/client.test.ts).
 */

import { OPENHANDS_ERROR_BODY_CHARS } from "../limits.ts";

/**
 * Les deux préfixes de l'API, composés une fois pour toutes : `/api/v1` vient
 * de v1_router.py, `/app-conversations` du routeur des conversations
 * lui-même. Les écrire séparément à chaque appel était exactement l'erreur
 * que les tests de ce module ont attrapée.
 */
const CONVERSATIONS_PATH = "/api/v1/app-conversations";

export class OpenHandsError extends Error {
  // Champs déclarés explicitement plutôt qu'en propriétés de paramètres du
  // constructeur : même contrainte que GitLabError (voir gitlab/client.ts) —
  // le "type stripping" natif de Node n'accepte pas la forme raccourcie.
  readonly status: number;
  readonly url: string;
  readonly payload: string;

  constructor(status: number, url: string, payload: string) {
    super(
      `OpenHands ${status} sur ${url} — ${payload.slice(0, OPENHANDS_ERROR_BODY_CHARS)}`,
    );
    this.name = "OpenHandsError";
    this.status = status;
    this.url = url;
    this.payload = payload;
  }
}

/**
 * Statuts du démarrage d'une conversation
 * (AppConversationStartTaskStatus). READY et ERROR sont terminaux ; tous les
 * autres décrivent une étape de la préparation (bac à sable, clone du dépôt,
 * script de setup, hooks git, compétences, démarrage) et se succèdent pendant
 * le sondage.
 */
export const START_TASK_STATUSES = [
  "WORKING",
  "WAITING_FOR_SANDBOX",
  "PREPARING_REPOSITORY",
  "RUNNING_SETUP_SCRIPT",
  "SETTING_UP_GIT_HOOKS",
  "SETTING_UP_SKILLS",
  "STARTING_CONVERSATION",
  "READY",
  "ERROR",
] as const;
export type StartTaskStatus = (typeof START_TASK_STATUSES)[number];

/** Statut du bac à sable qui porte la conversation (SandboxStatus). */
export type SandboxStatus =
  | "STARTING"
  | "RUNNING"
  | "PAUSED"
  | "ERROR"
  | "MISSING";

/**
 * Statut d'exécution de l'agent (ConversationExecutionStatus, défini dans le
 * SDK). `deleting` existe aussi côté SDK mais ne concerne que la suppression
 * d'une conversation, que ce client ne déclenche jamais — il est accepté au
 * type près pour ne pas casser la lecture si le serveur le renvoie.
 */
export type ExecutionStatus =
  | "idle"
  | "running"
  | "paused"
  | "waiting_for_confirmation"
  | "finished"
  | "error"
  | "stuck"
  | "deleting";

/**
 * Terminal AU SENS DU SDK (`ConversationExecutionStatus.is_terminal`) : le run
 * est fini, l'agent ne travaille plus. `idle` en est délibérément exclu côté
 * SDK — c'est l'état d'une conversation qui n'a pas ENCORE démarré, et le
 * confondre avec une fin ferait conclure « terminé » à la première lecture.
 *
 * `waiting_for_confirmation` ne figure pas ici non plus : l'agent y attend un
 * humain. On le traite séparément (voir waitForCompletion), parce que
 * continuer à sonder n'apporterait rien mais que ce n'est pas non plus une
 * fin de travail.
 */
const TERMINAL_EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  "finished",
  "error",
  "stuck",
]);

export function isTerminalExecutionStatus(status: string): boolean {
  return TERMINAL_EXECUTION_STATUSES.has(status);
}

/**
 * Ce que le démon envoie pour démarrer une conversation. Sous-ensemble
 * DÉLIBÉRÉ d'AppConversationStartRequest, qui compte une trentaine de champs :
 * ne sont repris que ceux dont ce chantier a besoin. Tout le reste
 * (profils d'agent, greffons, processeurs d'événements, secrets…) se règle
 * dans la configuration d'OpenHands, jamais dans une requête du démon — c'est
 * le point du chantier.
 */
export interface StartConversationInput {
  /** Le texte envoyé à l'agent, tel quel. */
  message: string;
  /** "groupe/depot" — le chemin du dépôt, pas son identifiant numérique. */
  repository: string;
  /**
   * Branche à sortir après le clone. Sans elle, OpenHands travaille sur la
   * branche par défaut du dépôt : pour relire une merge request, ce serait
   * relire autre chose que ce qui est demandé.
   */
  branch?: string;
  /** Titre affiché dans la liste des conversations d'OpenHands. */
  title?: string;
}

export interface StartTask {
  id: string;
  status: StartTaskStatus;
  /** Renseigné dès que le démarrage aboutit — `null` tant que ce n'est pas READY. */
  app_conversation_id: string | null;
  sandbox_id: string | null;
  /** Message d'erreur du serveur quand le statut vaut ERROR. */
  detail: string | null;
}

export interface Conversation {
  id: string;
  /**
   * Identifiant du bac à sable (`oh-agent-server-<xxx>`) — À LIRE ICI, jamais
   * sur la tâche de démarrage : au moment où `POST /app-conversations` répond,
   * le bac à sable n'existe pas encore (statut WORKING) et le champ vaut
   * `null`. C'est ce champ-ci qu'attend `POST /api/v1/sandboxes/{id}/resume`.
   */
  sandbox_id: string | null;
  sandbox_status: SandboxStatus;
  /**
   * `null` tant que le bac à sable n'est pas RUNNING — documenté ainsi sur le
   * modèle AppConversation. Une conversation lue trop tôt n'a donc pas de
   * statut d'exécution, ce qui n'est pas une anomalie.
   */
  execution_status: ExecutionStatus | null;
  /**
   * NE PAS UTILISER pour donner une adresse à un humain, malgré son nom :
   * vérifié contre une instance réelle, ce champ vaut
   * `http://localhost:<port-éphémère>/api/conversations/<id>` — l'API de
   * l'agent-server, pas une page. Voir conversationUrl() plus bas.
   */
  conversation_url: string | null;
  title: string | null;
}

/** Le modèle en vigueur sur l'instance, tel que `GET /api/v1/settings` le décrit. */
export interface LlmSettings {
  model: string | null;
  baseUrl: string | null;
  /** Le serveur ne rend jamais la clé, seulement si elle est posée. */
  apiKeySet: boolean;
}

/** Ce qu'on veut imposer à l'instance — voir setLlmSettings. */
export interface DesiredLlm {
  model: string;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
}

export interface OpenHandsClientOptions {
  /** Racine de l'instance, sans `/api/v1` : les "/" de fin sont retirés. */
  baseUrl: string;
  /**
   * Valeur de l'en-tête `X-Session-API-Key`. Absente, aucune en-tête n'est
   * envoyée — ce qui est le cas nominal d'une instance dont SESSION_API_KEY
   * n'est pas positionnée, et le cas d'un 401 systématique sinon.
   */
  apiKey?: string;
  /** Injecté pour les tests ; `globalThis.fetch` en production. */
  fetch?: typeof fetch;
  /** Injecté pour les tests : permet de ne pas attendre réellement. */
  sleep?: (ms: number) => Promise<void>;
  /** Injecté pour les tests : horloge du timeout de waitForCompletion. */
  now?: () => number;
}

/** Issue d'une attente de fin de conversation (voir waitForCompletion). */
export interface CompletionOutcome {
  /**
   * - `finished`  : l'agent a terminé son travail ;
   * - `error`     : l'agent ou son bac à sable a échoué ;
   * - `stuck`     : le serveur a détecté une boucle ;
   * - `waiting`   : l'agent attend une confirmation humaine ;
   * - `timeout`   : le budget de temps du démon a expiré. La conversation, elle,
   *   continue côté OpenHands (voir docs/openhands.md).
   */
  result: "finished" | "error" | "stuck" | "waiting" | "timeout";
  conversation: Conversation | null;
  /** Durée réellement écoulée dans l'attente, en millisecondes. */
  elapsedMs: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenHandsClient {
  readonly baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: OpenHandsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? Date.now;
  }

  /**
   * LE seul endroit qui pose les en-têtes et lit les erreurs. `url` est
   * absolue : les deux helpers ci-dessous construisent les préfixes.
   */
  async #send<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    };
    // Jamais d'en-tête vide : une instance sans SESSION_API_KEY n'installe pas
    // la dépendance de contrôle, un en-tête vide n'y changerait rien, mais sur
    // une instance qui l'a positionnée il produirait un 401 plus difficile à
    // lire qu'une absence franche.
    if (this.#apiKey) headers["X-Session-API-Key"] = this.#apiKey;

    const response = await this.#fetch(url, { ...init, headers });
    const text = await response.text();

    if (!response.ok) throw new OpenHandsError(response.status, url, text);

    // Corps vide sur un 2xx : rendu tel quel plutôt que de faire échouer
    // JSON.parse avec un message qui parlerait de syntaxe alors que le
    // problème est ailleurs.
    if (text.trim() === "") return undefined as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OpenHandsError(
        response.status,
        url,
        `réponse illisible (JSON attendu) : ${text}`,
      );
    }
  }

  /**
   * `path` est relatif à `/api/v1/app-conversations` : les deux préfixes se
   * composent côté serveur (v1_router.py monte `/api/v1`, le routeur des
   * conversations y ajoute `/app-conversations`) et sont donc assemblés en un
   * seul endroit ici. Une chaîne vide vise la ressource racine — c'est le cas
   * de `POST ''` (démarrer) et de `GET ''` (lecture par lot).
   */
  #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.#send<T>(`${this.baseUrl}${CONVERSATIONS_PATH}${path}`, init);
  }

  /** `path` est relatif à `/api/v1` — pour les routeurs hors conversations. */
  #v1<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.#send<T>(`${this.baseUrl}/api/v1${path}`, init);
  }

  /**
   * Le modèle réellement en vigueur, tel que l'instance l'appliquera à la
   * PROCHAINE conversation.
   *
   * C'est la seule source de vérité : les variables `LLM_*` de
   * l'environnement du conteneur ne choisissent PAS le modèle (vérifié en le
   * testant — voir docs/openhands.md, section « Changer de modèle »).
   *
   * `api_key` n'est jamais rendue en clair par le serveur ; il rend un
   * booléen `llm_api_key_set`, d'où la forme de LlmSettings.
   */
  async getLlmSettings(): Promise<LlmSettings> {
    const settings = await this.#v1<{
      agent_settings?: { llm?: { model?: string | null; base_url?: string | null } };
      llm_api_key_set?: boolean;
    }>("/settings");

    return {
      model: settings?.agent_settings?.llm?.model ?? null,
      baseUrl: settings?.agent_settings?.llm?.base_url ?? null,
      apiKeySet: settings?.llm_api_key_set === true,
    };
  }

  /**
   * `POST /api/v1/settings` — fusion en profondeur côté serveur : le champ
   * s'appelle `agent_settings_diff` précisément parce qu'il ne remplace pas
   * le bloc entier (voir le docstring de `store_settings`). Envoyer le seul
   * sous-objet `llm` ne touche donc ni aux réglages MCP, ni au condenseur, ni
   * au reste.
   */
  setLlmSettings(desired: DesiredLlm): Promise<void> {
    const llm: Record<string, unknown> = { model: desired.model };
    // Une base_url vide n'est pas la même chose qu'absente : l'envoyer
    // écraserait celle d'un fournisseur qui n'en a pas besoin.
    if (desired.baseUrl) llm.base_url = desired.baseUrl;
    if (desired.apiKey) llm.api_key = desired.apiKey;

    return this.#v1<void>("/settings", {
      method: "POST",
      body: JSON.stringify({ agent_settings_diff: { llm } }),
    });
  }

  /**
   * `GET /health` — hors de `/api/v1`, et sans authentification : le routeur
   * de statut est monté directement sur l'application, sans la dépendance
   * `get_dependencies()` qui protège les routes V1 (vérifié dans
   * `openhands/app_server/app.py` et `status/status_router.py`). Répond la
   * chaîne `OK`.
   *
   * Sert au diagnostic au démarrage du démon : dire « l'instance ne répond
   * pas » tout de suite vaut mieux que de le découvrir à la première demande,
   * après avoir déjà accusé réception.
   */
  async health(): Promise<string> {
    const url = `${this.baseUrl}/health`;
    const response = await this.#fetch(url, { headers: { accept: "*/*" } });
    const text = await response.text();
    if (!response.ok) throw new OpenHandsError(response.status, url, text);
    return text.trim();
  }

  /**
   * `POST /api/v1/app-conversations`. Rend la tâche de DÉMARRAGE, pas la
   * conversation : `app_conversation_id` n'est renseigné qu'une fois le statut
   * passé à READY (le bac à sable doit démarrer, le dépôt être cloné, les
   * compétences chargées). Voir waitForReady.
   */
  startConversation(input: StartConversationInput): Promise<StartTask> {
    const body: Record<string, unknown> = {
      // La forme exacte attendue par SendMessageRequest (openhands/sdk) :
      // un rôle et une LISTE de contenus typés, pas une chaîne.
      initial_message: {
        role: "user",
        content: [{ type: "text", text: input.message }],
      },
      selected_repository: input.repository,
      // Dit explicitement de quel fournisseur il s'agit plutôt que de laisser
      // le serveur le deviner à partir du chemin du dépôt : sur une instance
      // branchée à plusieurs fournisseurs, "groupe/depot" est ambigu.
      git_provider: "gitlab",
    };
    if (input.branch) body.selected_branch = input.branch;
    if (input.title) body.title = input.title;

    return this.#request<StartTask>("", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * `POST /api/v1/app-conversations/{id}/send-message` — relance une
   * conversation EXISTANTE au lieu d'en créer une nouvelle.
   *
   * `run: true` est indispensable : le défaut du modèle amont
   * (`AppSendMessageRequest.run`) est `false`, ce qui dépose le message sans
   * réveiller la boucle de l'agent — la conversation resterait `idle` et le
   * daemon attendrait jusqu'au timeout sans que rien ne se passe.
   *
   * Le serveur documente ses refus, et ils comptent tous les trois ici :
   * 409 si le bac à sable n'est pas RUNNING (voir resumeSandbox), 410 si la
   * conversation est archivée (bac à sable définitivement disparu), 404 si
   * elle n'existe plus du tout. L'appelant retombe alors sur la création
   * d'une conversation neuve — voir tasks/openhands.ts.
   */
  sendMessage(conversationId: string, text: string): Promise<unknown> {
    return this.#request(`/${encodeURIComponent(conversationId)}/send-message`, {
      method: "POST",
      body: JSON.stringify({
        role: "user",
        content: [{ type: "text", text }],
        run: true,
      }),
    });
  }

  /**
   * `POST /api/v1/sandboxes/{id}/resume` — hors du routeur des conversations,
   * d'où le chemin absolu construit ici plutôt qu'un appel à #request.
   *
   * Un bac à sable est mis en PAUSE par OpenHands lui-même quand le nombre de
   * bacs à sable actifs dépasse sa limite (`pause_old_sandboxes`, appelée au
   * démarrage de chaque nouvelle conversation). Reprendre une conversation
   * ancienne suppose donc de le relancer d'abord.
   */
  resumeSandbox(sandboxId: string): Promise<void> {
    return this.#v1<void>(`/sandboxes/${encodeURIComponent(sandboxId)}/resume`, {
      method: "POST",
    });
  }

  /**
   * Sonde la conversation jusqu'à ce que son bac à sable soit RUNNING, après
   * un resume. Rend `false` si le délai expire ou si le bac à sable part en
   * ERROR/MISSING — l'appelant repart alors sur une conversation neuve plutôt
   * que d'insister sur un bac à sable qui ne reviendra pas.
   */
  async waitForSandboxRunning(
    conversationId: string,
    options: { timeoutMs: number; pollIntervalMs: number },
  ): Promise<boolean> {
    const deadline = this.#now() + options.timeoutMs;

    for (;;) {
      const conversation = await this.getConversation(conversationId);
      if (conversation === null) return false;
      if (conversation.sandbox_status === "RUNNING") return true;
      if (conversation.sandbox_status === "ERROR") return false;
      if (conversation.sandbox_status === "MISSING") return false;
      if (this.#now() >= deadline) return false;
      await this.#sleep(options.pollIntervalMs);
    }
  }

  /**
   * `GET /api/v1/app-conversations/start-tasks?ids=<id>` — lecture par lot,
   * réponse alignée sur les identifiants demandés, `null` pour un identifiant
   * inconnu. On n'en demande qu'un, d'où la lecture de l'élément 0.
   */
  async getStartTask(id: string): Promise<StartTask | null> {
    const items = await this.#request<(StartTask | null)[]>(
      `/start-tasks?ids=${encodeURIComponent(id)}`,
    );
    return items?.[0] ?? null;
  }

  /** `GET /api/v1/app-conversations?ids=<id>` — même forme par lot que ci-dessus. */
  async getConversation(id: string): Promise<Conversation | null> {
    const items = await this.#request<(Conversation | null)[]>(
      `?ids=${encodeURIComponent(id)}`,
    );
    return items?.[0] ?? null;
  }

  /**
   * Sonde la tâche de démarrage jusqu'à READY (rend l'identifiant de
   * conversation) ou ERROR (lève, avec le `detail` du serveur quand il y en a
   * un). Le timeout couvre le DÉMARRAGE seul, pas le travail de l'agent : un
   * bac à sable qui ne démarre jamais doit se dire vite, pas au bout du budget
   * complet de la tâche.
   */
  async waitForReady(
    startTaskId: string,
    options: { timeoutMs: number; pollIntervalMs: number },
  ): Promise<string> {
    const deadline = this.#now() + options.timeoutMs;

    for (;;) {
      const task = await this.getStartTask(startTaskId);

      if (task === null) {
        throw new Error(
          `démarrage introuvable côté OpenHands (tâche ${startTaskId}) — conversation jamais créée`,
        );
      }
      if (task.status === "ERROR") {
        throw new Error(
          `OpenHands n'a pas pu démarrer la conversation${task.detail ? ` : ${task.detail}` : ""}`,
        );
      }
      if (task.status === "READY") {
        if (!task.app_conversation_id) {
          throw new Error(
            `OpenHands rend READY sans identifiant de conversation (tâche ${startTaskId})`,
          );
        }
        return task.app_conversation_id;
      }
      if (this.#now() >= deadline) {
        throw new Error(
          `démarrage de la conversation non abouti en ${Math.round(options.timeoutMs / 1000)} s ` +
            `(dernier statut : ${task.status})`,
        );
      }

      await this.#sleep(options.pollIntervalMs);
    }
  }

  /**
   * Sonde la conversation jusqu'à un statut d'exécution terminal, une attente
   * de confirmation, ou l'expiration du budget de temps.
   *
   * Ne lève PAS sur `error`/`stuck`/`timeout` : ce sont des issues à rapporter
   * au demandeur, pas des pannes du client. L'appelant décide quoi en dire
   * (voir tasks/openhands.ts).
   */
  async waitForCompletion(
    conversationId: string,
    options: { timeoutMs: number; pollIntervalMs: number },
  ): Promise<CompletionOutcome> {
    const started = this.#now();
    const deadline = started + options.timeoutMs;
    let last: Conversation | null = null;

    for (;;) {
      last = await this.getConversation(conversationId);
      const status = last?.execution_status ?? null;

      if (status !== null && isTerminalExecutionStatus(status)) {
        return {
          result: status as "finished" | "error" | "stuck",
          conversation: last,
          elapsedMs: this.#now() - started,
        };
      }
      if (status === "waiting_for_confirmation") {
        return { result: "waiting", conversation: last, elapsedMs: this.#now() - started };
      }
      // Bac à sable disparu (supprimé, ou jamais reconstruit après un
      // redémarrage d'OpenHands) : continuer à sonder ne rendrait jamais rien.
      if (last !== null && last.sandbox_status === "MISSING") {
        return { result: "error", conversation: last, elapsedMs: this.#now() - started };
      }
      if (this.#now() >= deadline) {
        return { result: "timeout", conversation: last, elapsedMs: this.#now() - started };
      }

      await this.#sleep(options.pollIntervalMs);
    }
  }

  /**
   * Adresse à donner à un HUMAIN.
   *
   * N'utilise délibérément PAS `AppConversation.conversation_url`, malgré son
   * nom et malgré sa description amont (« l'URL où la conversation peut être
   * consultée ») : vérifié contre une instance réelle, ce champ vaut
   * `http://localhost:<port-du-bac-à-sable>/api/conversations/<id>` — l'API de
   * l'agent-server, sur un port éphémère, pas une page. Le donner à quelqu'un
   * dans un commentaire de merge request ne mène nulle part.
   *
   * `/conversations/<id>` sur la racine de l'instance est en revanche la route
   * de l'interface web (relevée dans `frontend/src/routes.ts` :
   * `route("conversations/:conversationId", …)`).
   */
  conversationUrl(conversationId: string): string {
    return `${this.baseUrl}/conversations/${conversationId}`;
  }
}
