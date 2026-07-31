import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * §A (durcissement proxy d'entreprise) : après le correctif de
 * `gitlab/proxy-fetch.ts`, un appel API GitLab utilise bien HTTP_PROXY/
 * HTTPS_PROXY quand ces variables sont présentes dans l'environnement du
 * daemon — mais rien ne les y place automatiquement. Le propriétaire de ce
 * projet configure son proxy d'entreprise dans `~/.gitconfig`
 * (`http.<url>.proxy`, scopé par hôte) : `git` (clone, push) en profite déjà
 * (sanitizedEnv() transmet HOME, voir config.ts), mais si HTTP_PROXY/
 * HTTPS_PROXY ne sont PAS explicitement exportées pour le process du
 * daemon, les appels API GitLab n'ont toujours rien à lire — exactement
 * l'asymétrie que ce module cherche à combler pour `fetch()` (voir
 * proxy-fetch.ts), sauf que rien ne peut la combler automatiquement dans CE
 * cas précis : `~/.gitconfig` n'est lu que par le binaire `git`, jamais par
 * le process Node lui-même. On se contente donc de le détecter et de le
 * signaler bruyamment au démarrage, plutôt que de laisser un opérateur le
 * découvrir des heures plus tard sur un "timeout" GitLab incompréhensible
 * pendant que `git clone`/`git push`, eux, fonctionnent très bien.
 *
 * `git config --get-urlmatch` renvoie la valeur la plus spécifique de
 * `http.<motif>.<clé>` qui matche l'URL donnée (exit 1, silencieux, si
 * aucune entrée ne matche) — le même mécanisme que celui déjà vérifié pour
 * `http.<url>.extraHeader` dans gitCredentialEnv (voir config.ts).
 */
export async function gitProxyConfiguredFor(
  url: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["config", "--global", "--get-urlmatch", "http.proxy", url],
      { env },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Avertit au démarrage si (a) aucune variable HTTP_PROXY/HTTPS_PROXY n'est
 * exportée pour ce process ET (b) git, lui, a bien un proxy configuré pour
 * `gitlabUrl` dans sa config globale — signe que l'opérateur a configuré le
 * proxy pour git mais pas (encore) pour ce daemon. Ne se déclenche jamais
 * si HTTP_PROXY/HTTPS_PROXY sont déjà présentes (cas déjà couvert par
 * proxy-fetch.ts/containerProxyEnv), ni si aucun proxy git n'est configuré
 * pour cet hôte (rien à signaler : le cas nominal sans proxy du tout).
 *
 * Ne journalise JAMAIS la valeur du proxy configuré (seulement sa
 * présence/absence) : une URL de proxy d'entreprise authentifié embarque
 * parfois un identifiant dans son userinfo (`http://utilisateur:jeton@proxy`,
 * observé en pratique) — un secret à part entière, qu'un message
 * d'avertissement ne doit jamais faire fuiter dans les logs du daemon.
 */
export async function warnIfGitProxyNotExported(
  gitlabUrl: string,
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): Promise<void> {
  const hasEnvProxy = Boolean(
    env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy,
  );
  if (hasEnvProxy) return;

  // `env` explicitement (pas le défaut sanitizedEnv() de gitProxyConfiguredFor) :
  // c'est ce qui rend cette fonction testable avec un HOME/.gitconfig
  // fabriqués, sans dépendre du process.env réel du test — voir proxy-check.test.ts.
  const configured = await gitProxyConfiguredFor(gitlabUrl, env);
  if (!configured) return;

  warn(
    `un proxy est configuré pour ${gitlabUrl} dans ~/.gitconfig (http.<url>.proxy), mais ` +
      "aucune variable HTTP_PROXY/HTTPS_PROXY n'est présente dans l'environnement de ce daemon : " +
      "git (clone, push) passera par ce proxy, mais PAS les appels API GitLab (src/gitlab/client.ts) " +
      "tant que HTTP_PROXY/HTTPS_PROXY (et éventuellement NO_PROXY) ne sont pas explicitement " +
      "exportées pour ce process — voir la section Configuration du README.",
  );
}
