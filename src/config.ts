import { existsSync, readFileSync } from "node:fs";

/**
 * CDS_SKIP_DOTENV=1 : ne lit PAS .env. Posé par `npm test` (voir
 * package.json), et pour une raison qui s'est vérifiée deux fois.
 *
 * loadDotEnv ne remplit que les clés absentes de process.env — inoffensif
 * pour le daemon, mais pas pour la suite de tests : un test qui ne déclare
 * pas explicitement une variable hérite alors de celle de l'OPÉRATEUR. Le
 * 1er août 2026, l'ajout de CONTAINER_INFERENCE_URL et INFERENCE_API_KEY
 * dans un .env local a fait échouer trois tests d'inférence qui passaient la
 * minute d'avant, sans qu'une ligne de code ait bougé. La suite doit donner
 * le même résultat sur le poste de développement et dans un runner vierge —
 * c'est tout l'intérêt d'une CI, et ça ne tient que si `npm test` ne lit rien
 * de la configuration de la machine.
 */
function loadDotEnv(path = ".env"): void {
  if (process.env.CDS_SKIP_DOTENV === "1") return;
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name} — voir .env`);
  }
  return value;
}

/**
 * Chantier "projects.json" : sept variables d'environnement ont migré vers ce
 * fichier versionné (voir src/projects.ts) — la liste des dépôts/auteurs
 * autorisés, les capacités de l'agent, les commandes et l'image Docker par
 * dépôt, les répertoires de test maison. Un .env hérité qui en garderait une
 * ferait courir exactement le risque que ce chantier corrige ailleurs
 * (un réglage périmé mais toujours présent) : un réglage qui
 * n'autorise plus rien en silence, ou pire, qu'on croit encore actif. On
 * refuse donc de démarrer tant que l'une d'elles traîne encore dans
 * l'environnement, avec un message qui dit explicitement où le réglage a
 * migré — jamais un simple avertissement ignorable.
 */
const LEGACY_ENV_MIGRATIONS: Record<string, string> = {
  ALLOWED_PROJECTS:
    'la liste des dépôts autorisés est désormais la clé "projects" de projects.json — un dépôt qui n\'y figure pas est refusé, exactement comme une liste ALLOWED_PROJECTS vide auparavant.',
  ALLOWED_USERS:
    'les auteurs autorisés sont désormais "projects.<dépôt>.users" dans projects.json, dépôt par dépôt (il n\'y a plus de liste globale unique).',
  AGENT_CAPABILITIES:
    'les capacités de l\'agent sont désormais "capabilities" (issue/mergeRequest, dans "defaults" et par dépôt) dans projects.json — voir projects.example.json.',
  DOCKER_IMAGES:
    'l\'image Docker par dépôt est désormais "docker.image" (dans "defaults" et par dépôt) dans projects.json.',
  TEST_COMMANDS:
    'la commande de test par dépôt est désormais "commands.test" (dans "defaults" et par dépôt) dans projects.json.',
  INSTALL_COMMANDS:
    'la commande d\'installation par dépôt est désormais "commands.install" (dans "defaults" et par dépôt) dans projects.json.',
  TEST_DIRECTORY_OVERRIDES:
    'les répertoires de test maison par dépôt sont désormais "testDirectories" (dans "defaults" et par dépôt) dans projects.json.',
};

/** Voir LEGACY_ENV_MIGRATIONS ci-dessus. Appelée en tout premier dans buildConfig(). */
function assertNoLegacyEnvVars(env: NodeJS.ProcessEnv): void {
  for (const [name, migration] of Object.entries(LEGACY_ENV_MIGRATIONS)) {
    if (name in env) {
      throw new Error(
        `Variable d'environnement périmée : ${name} n'est plus lue par le daemon — ${migration} ` +
          `Retirez ${name} de .env (voir projects.example.json et le README, section Configuration des projets).`,
      );
    }
  }
}

interface NumberBounds {
  min?: number;
  max?: number;
}

/**
 * Lit une variable d'environnement numérique en s'assurant qu'elle est un
 * nombre fini et qu'elle respecte les bornes attendues, plutôt que de laisser
 * passer une valeur absurde. `Number("30s")` vaut `NaN`, et
 * `setTimeout(fn, NaN)` se comporte comme `setTimeout(fn, 0)` : sans ce
 * garde-fou, une simple faute de frappe sur POLL_INTERVAL_MS transforme
 * l'intervalle de polling en boucle serrée qui martèle l'API GitLab avec le
 * PAT — bannissement quasi garanti. Une valeur négative ou nulle est tout
 * aussi dangereuse (ex. MAX_ATTEMPTS=0 désactiverait silencieusement les
 * réessais), d'où les bornes. On échoue donc bruyamment au démarrage, en
 * nommant la variable fautive et la valeur lue — même ton que required().
 * Une variable absente ou vide retombe sur le défaut, comme required().
 */
function finiteNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  bounds: NumberBounds = {},
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(
      `Variable d'environnement invalide : ${name}="${raw}" n'est pas un nombre — voir .env`,
    );
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new Error(
      `Variable d'environnement invalide : ${name}=${raw} est inférieur au minimum autorisé (${bounds.min}) — voir .env`,
    );
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new Error(
      `Variable d'environnement invalide : ${name}=${raw} dépasse le maximum autorisé (${bounds.max}) — voir .env`,
    );
  }
  return value;
}

/**
 * L'instance OpenHands à qui tout le travail est délégué. OBLIGATOIRE : sur
 * cette branche, le daemon n'a aucun autre moyen d'exécuter une demande — il
 * détecte, autorise, accuse réception et dispatche, rien de plus.
 *
 * Réclamée AU DÉMARRAGE plutôt qu'au moment de la première demande : un
 * daemon qui se déclare prêt, accuse réception, puis découvre qu'il n'a
 * personne à qui déléguer laisse le demandeur sans réponse.
 *
 * La forme est vérifiée ici (URL absolue http/https) parce qu'une valeur
 * comme "localhost:3000" produirait sinon un `fetch` en échec avec un message
 * qui ne nomme pas la variable fautive.
 */
function validateOpenHandsUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.OPENHANDS_URL?.trim();

  if (raw === undefined || raw === "") {
    throw new Error(
      "Variable d'environnement manquante : OPENHANDS_URL — le daemon délègue toute " +
        'exécution à une instance OpenHands (ex. "http://127.0.0.1:3000") — voir .env',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `Variable d'environnement invalide : OPENHANDS_URL="${raw}" n'est pas une URL absolue ` +
        '(ex. "http://127.0.0.1:3000") — voir .env',
    );
  }
  // Attrape aussi "localhost:3000", que `new URL` accepte sans broncher en
  // lisant "localhost:" comme un schéma — d'où un contrôle sur le protocole
  // et pas seulement sur la réussite de l'analyse.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Variable d'environnement invalide : OPENHANDS_URL="${raw}" doit être une URL absolue ` +
        `en http ou https (ex. "http://127.0.0.1:3000") — voir .env`,
    );
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Format LiteLLM attendu par OpenHands : "<fournisseur>/<modèle>", le
 * fournisseur pouvant lui-même contenir des "/" ("openrouter/xiaomi/mimo").
 * Un identifiant sans "/" ne dit rien à LiteLLM et échouerait au premier
 * appel, loin de la variable fautive — même garde-fou que le
 * validateAgentModel de `hardening`, pour la même raison.
 *
 * Vide ou absent : le daemon ne touche pas aux réglages de l'instance.
 */
function validateAgentModel(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.AGENT_MODEL?.trim();
  if (!raw) return undefined;

  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    throw new Error(
      `Variable d'environnement invalide : AGENT_MODEL="${raw}" doit être au format ` +
        `"fournisseur/modèle" attendu par LiteLLM (ex. "openai/qwen3.6-35b-a3b", ` +
        `"openrouter/xiaomi/mimo-v2.5") — voir .env`,
    );
  }
  return raw;
}

/**
 * Construit la configuration à partir d'un environnement donné. Fonction
 * pure exportée séparément de `config` afin d'être testable en isolation
 * (sans dépendre de process.env ni du cache des modules ESM) : voir
 * config.test.ts.
 *
 * CE QUI A DISPARU DE CE FICHIER, et pourquoi. Toute la configuration de
 * l'exécution maison — modèle et budget de l'agent, passes de revue et leur
 * mode, seuil de sévérité, arbitre, profondeur de clone, image et limites du
 * conteneur, proxy d'inférence, identité git du committeur — a été retirée
 * avec le code qui la lisait. Le daemon n'exécute plus rien : il dispatche.
 * Ce qui remplace ces réglages vit désormais dans la configuration
 * d'OpenHands (docker/openhands/docker-compose.yml) et dans le dépôt relu
 * (AGENTS.md, .agents/skills/, .openhands/) — voir docs/openhands.md. Une
 * variable qui ne fait plus rien mais reste documentée est pire qu'absente :
 * elle laisse croire à un levier qui n'existe pas.
 */
export function buildConfig(env: NodeJS.ProcessEnv) {
  // Chantier "projects.json" : en tout premier, avant toute autre lecture —
  // voir LEGACY_ENV_MIGRATIONS ci-dessus.
  assertNoLegacyEnvVars(env);

  // BENCH_ACCEPT_BOT_NOTES retire le garde-fou anti-boucle. Le seul frein qui
  // reste alors est le quota de tâches : on refuse donc la combinaison sans
  // lui, plutôt que de laisser un dépôt réel s'emballer parce qu'un drapeau
  // de banc de mesure a traîné dans un .env.
  if (env.BENCH_ACCEPT_BOT_NOTES === "1" && !env.CDS_MAX_TASKS) {
    throw new Error(
      "BENCH_ACCEPT_BOT_NOTES=1 retire le garde-fou anti-boucle (le bot peut alors " +
        "se répondre à lui-même) et exige donc CDS_MAX_TASKS pour borner le nombre " +
        "de tâches. Posez CDS_MAX_TASKS=1 — c'est ce que fait scripts/bench.sh — ou " +
        "retirez BENCH_ACCEPT_BOT_NOTES. Voir .env",
    );
  }

  return {
    // -----------------------------------------------------------------------
    // GitLab — connexion et identité du bot
    // -----------------------------------------------------------------------

    gitlabUrl: (env.GITLAB_URL ?? "https://gitlab.com").replace(/\/+$/, ""),
    token: required(env, "GITLAB_TOKEN"),
    botUsername: required(env, "BOT_USERNAME"),

    // Délai maximal d'une requête HTTP vers GitLab. Le plancher très bas
    // (50 ms) est délibérément permissif : il sert surtout à garder les tests
    // rapides contre un vrai serveur HTTP local (voir gitlab/client.test.ts) ;
    // 5 min de plafond, au-delà autant dire qu'il n'y a plus de timeout.
    gitlabRequestTimeoutMs: finiteNumber(
      env,
      "GITLAB_REQUEST_TIMEOUT_MS",
      20_000,
      { min: 50, max: 300_000 },
    ),
    // Nombre de réessais (en plus de la tentative initiale) pour les requêtes
    // idempotentes (GET) face à une erreur transitoire (429, 5xx, réseau).
    // 0 désactive les réessais sans désactiver le timeout ci-dessus — utile
    // en test.
    gitlabMaxRetries: finiteNumber(env, "GITLAB_MAX_RETRIES", 4, {
      min: 0,
      max: 10,
    }),
    // Délai de base et plafond du backoff exponentiel (avec jitter complet,
    // voir gitlab/client.ts) entre deux tentatives. Le plafond évite qu'un
    // 429 mal réglé ne fasse attendre le worker des minutes entières.
    gitlabRetryBaseMs: finiteNumber(env, "GITLAB_RETRY_BASE_MS", 500, {
      min: 1,
      max: 60_000,
    }),
    gitlabRetryMaxDelayMs: finiteNumber(env, "GITLAB_RETRY_MAX_DELAY_MS", 8_000, {
      min: 1,
      max: 120_000,
    }),

    // -----------------------------------------------------------------------
    // OpenHands — l'exécutant
    // -----------------------------------------------------------------------

    /**
     * Racine de l'instance, SANS `/api/v1` (le client l'ajoute — voir
     * openhands/client.ts). Les "/" de fin sont retirés.
     */
    openhandsUrl: validateOpenHandsUrl(env),
    /**
     * Envoyée en en-tête `X-Session-API-Key`. DOIT correspondre à la variable
     * SESSION_API_KEY du serveur OpenHands (vérifié dans son code :
     * openhands/app_server/utils/dependencies.py). Ce n'est PAS
     * `Authorization: Bearer` — cette forme-là est celle de l'offre Cloud.
     *
     * Vide des deux côtés, l'API d'OpenHands n'est PAS protégée : le serveur
     * n'installe même pas le contrôle. C'est pourtant le réglage RECOMMANDÉ
     * en usage local — l'interface web d'OpenHands n'envoie aucun en-tête
     * d'authentification, donc poser une clé la rend inutilisable (voir
     * docker/openhands/docker-compose.yml et docs/openhands.md). Ce qui
     * protège alors l'instance est le binding du port sur 127.0.0.1. Le
     * daemon le rappelle au démarrage (daemon/index.ts::checkOpenHands)
     * plutôt que de laisser ce compromis passer inaperçu.
     */
    openhandsApiKey: env.OPENHANDS_API_KEY,
    /**
     * Budget de temps accordé au TRAVAIL de l'agent, à partir du moment où sa
     * conversation est prête — le DÉMARRAGE a son propre plafond, non
     * réglable (OPENHANDS_START_TIMEOUT_MS, voir limits.ts).
     *
     * Défaut 10 min, la valeur qu'avait AGENT_TIMEOUT_MINUTES sur le chemin
     * opencode : les deux branches partent ainsi du même budget sur le banc
     * de mesure. Plafond à 4 h, identique lui aussi.
     *
     * À l'expiration, le daemon rend la main et le dit au demandeur — mais la
     * conversation continue côté OpenHands : ce timeout est celui de
     * l'ATTENTE, pas une annulation (voir docs/openhands.md).
     */
    openhandsTimeoutMs:
      finiteNumber(env, "OPENHANDS_TIMEOUT_MINUTES", 10, { min: 1, max: 240 }) *
      60_000,

    // -----------------------------------------------------------------------
    // Polling, état, autorisations
    // -----------------------------------------------------------------------

    // Plancher à 1 s : en dessous, on martèle l'API GitLab. Plafond à 1 h :
    // au-delà, autant dire que le polling ne sert plus à rien.
    pollIntervalMs: finiteNumber(env, "POLL_INTERVAL_MS", 30_000, {
      min: 1_000,
      max: 3_600_000,
    }),
    // Exprimé en minutes côté env : borné à [1, 1440] (une journée) avant
    // conversion en ms.
    lookbackMs:
      finiteNumber(env, "LOOKBACK_MINUTES", 10, { min: 1, max: 1_440 }) * 60_000,
    maxAttempts: finiteNumber(env, "MAX_ATTEMPTS", 3, { min: 1, max: 20 }),

    stateFile: env.STATE_FILE ?? "./state/processed.jsonl",
    skipMarkDone: env.SKIP_MARK_DONE === "1",
    /**
     * Chantier "projects.json" : dépôts et auteurs autorisés, capacités.
     * Chargé et validé par daemon/index.ts au démarrage (fatal si
     * absent/invalide) et rechargé à chaud à chaque cycle de polling — voir
     * ProjectsRegistry.
     */
    projectsFile: env.PROJECTS_FILE ?? "./projects.json",
    // Table modèle → quantification imposée à OpenRouter. Fichier ABSENT =
    // routage libre, comportement inchangé. Voir openhands/quantization.ts.
    quantizationsFile: env.QUANTIZATIONS_FILE ?? "./quantizations.json",

    /**
     * Défauts globaux injectés dans la résolution par projet
     * (ProjectsBaseline, voir daemon/index.ts).
     *
     * Le daemon n'exécute plus AUCUNE de ces commandes et ne lance plus aucun
     * conteneur : c'est `.openhands/setup.sh` du dépôt relu qui installe, et
     * OpenHands qui choisit l'image de son bac à sable. Ces trois valeurs
     * subsistent pour une seule raison, et elle compte : le même
     * `projects.json` doit rester valide sur cette branche ET sur
     * `hardening`, sinon comparer les deux demanderait d'éditer le fichier à
     * chaque bascule. Elles sont résolues, jamais lues.
     */
    testCommand: env.TEST_COMMAND ?? "npm test",
    installCommand: env.INSTALL_COMMAND ?? "npm install",
    dockerDefaultImage: env.DOCKER_DEFAULT_IMAGE ?? "node:22-bookworm-slim",

    // -----------------------------------------------------------------------
    // Observabilité
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Modèle — imposé à l'instance OpenHands au démarrage du daemon
    // -----------------------------------------------------------------------
    //
    // Le modèle ne vit PAS dans l'environnement du conteneur OpenHands : il
    // vit dans ses réglages persistés, et les variables LLM_* ne l'y
    // remplacent pas (vérifié en le testant, voir docs/openhands.md). Sans ce
    // bloc, changer de modèle demanderait de passer par l'interface à chaque
    // fois — ingérable pour comparer une dizaine de modèles.
    //
    // Le daemon aligne donc l'instance sur ces trois valeurs à chaque
    // démarrage. `.env` redevient la source de vérité du modèle, comme sur
    // `hardening` : c'est ce qui rend une campagne multi-modèles symétrique
    // entre les deux branches.
    //
    // AGENT_MODEL absent : le daemon ne touche à rien, et l'instance garde ce
    // qui a été réglé dans son interface.
    agentModel: validateAgentModel(env),
    /** Devient `base_url` côté OpenHands. Absent : le fournisseur décide. */
    inferenceUrl: env.CONTAINER_INFERENCE_URL?.trim() || undefined,
    /** Devient `api_key`. Jamais relue depuis le serveur, qui ne rend qu'un booléen. */
    inferenceApiKey: env.INFERENCE_API_KEY?.trim() || undefined,

    /**
     * Nombre de tâches à traiter avant de s'arrêter tout seul, proprement.
     * 0 (le défaut) : illimité — le daemon tourne jusqu'à SIGINT, comportement
     * historique et seul comportement d'exploitation.
     *
     * Existe pour le banc de mesure : comparer dix modèles demande de lancer
     * le daemon dix fois, chacune avec un AGENT_MODEL différent, et d'attendre
     * qu'UNE tâche se termine avant de passer au suivant. Le faire à la main
     * (Ctrl-C au bon moment) marche mais oblige à rester devant l'écran des
     * heures durant, et un Ctrl-C mal placé coupe une tâche en vol — qui
     * atterrit alors en "running" non rejouable dans le journal.
     *
     * L'arrêt passe par la séquence de drain normale, pas par un exit brutal :
     * voir ShutdownController.requestStop.
     */
    maxTasks: finiteNumber(env, "CDS_MAX_TASKS", 0, { min: 0, max: 1_000 }),

    /**
     * Accepte les notes écrites par le BOT LUI-MÊME comme déclencheur.
     *
     * Normalement rejetées (daemon/request.ts) : c'est le garde-fou
     * anti-boucle du projet. Sans lui, une note du bot qui mentionne le bot
     * crée un to-do, qui crée une tâche, qui publie une note… Le seul autre
     * frein serait le journal d'idempotence, et il ne freine rien ici : chaque
     * publication porte un identifiant de note NEUF, donc une clé neuve.
     *
     * Pourquoi l'ouvrir quand même : le banc de mesure doit poster la demande
     * de revue lui-même. Sans ce drapeau il lui faut un SECOND jeton, celui
     * d'un compte humain — une pièce de configuration de plus, à créer et à
     * garder à jour, pour une opération qui n'a lieu que sur un dépôt de test.
     *
     * COUPLÉ À CDS_MAX_TASKS, ET FAIL-CLOSED (voir plus bas) : le daemon
     * refuse de démarrer avec ce drapeau si aucun quota de tâches n'est posé.
     * Une boucle bornée à N tâches n'est pas une boucle ; une boucle non
     * bornée sur un dépôt réel est un incident.
     */
    benchAcceptBotNotes: env.BENCH_ACCEPT_BOT_NOTES === "1",

    healthEnabled: env.HEALTH_ENABLED !== "0",
    // min: 0 et non 1 — le port 0 demande au noyau un port libre au hasard,
    // ce qui est un réglage légitime (et utilisé en test), pas une erreur.
    healthPort: finiteNumber(env, "HEALTH_PORT", 8090, {
      min: 0,
      max: 65_535,
    }),
    healthHost: env.HEALTH_HOST ?? "127.0.0.1",
  };
}

export const config = buildConfig(process.env);
