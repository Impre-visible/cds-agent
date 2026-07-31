import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pas de dépendance à config.ts (contrairement à la plupart des autres
// tests du projet) : proxy-check.ts n'importe que node:child_process, donc
// aucun besoin de GITLAB_TOKEN/BOT_USERNAME avant l'import.
let gitProxyConfiguredFor: (url: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
let warnIfGitProxyNotExported: (
  gitlabUrl: string,
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
) => Promise<void>;

before(async () => {
  ({ gitProxyConfiguredFor, warnIfGitProxyNotExported } = await import("./proxy-check.ts"));
});

/** Un HOME jetable avec un ~/.gitconfig fabriqué à la main. */
function makeHomeWithGitconfig(gitconfigContent: string): string {
  const home = mkdtempSync(join(tmpdir(), "cds-agent-proxy-check-home-"));
  writeFileSync(join(home, ".gitconfig"), gitconfigContent, "utf8");
  return home;
}

function envWithHome(home: string): NodeJS.ProcessEnv {
  return { HOME: home, PATH: process.env.PATH };
}

describe("gitProxyConfiguredFor", () => {
  let home: string;

  after(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("un proxy configuré pour l'hôte exact de l'URL est détecté", async () => {
    home = makeHomeWithGitconfig(
      '[http "https://gitlab.corp.example/"]\n\tproxy = http://proxy.corp.example:3128\n',
    );
    assert.equal(
      await gitProxyConfiguredFor("https://gitlab.corp.example", envWithHome(home)),
      true,
    );
  });

  test("aucune entrée ne matche un hôte différent : false", async () => {
    home = makeHomeWithGitconfig(
      '[http "https://gitlab.corp.example/"]\n\tproxy = http://proxy.corp.example:3128\n',
    );
    assert.equal(await gitProxyConfiguredFor("https://gitlab.com", envWithHome(home)), false);
  });

  test("aucun ~/.gitconfig du tout : false, ne lève pas", async () => {
    home = mkdtempSync(join(tmpdir(), "cds-agent-proxy-check-empty-home-"));
    await assert.doesNotReject(() =>
      gitProxyConfiguredFor("https://gitlab.com", envWithHome(home)),
    );
    assert.equal(await gitProxyConfiguredFor("https://gitlab.com", envWithHome(home)), false);
  });
});

describe("warnIfGitProxyNotExported", () => {
  let homeWithProxy: string;
  let homeWithoutProxy: string;

  before(() => {
    homeWithProxy = makeHomeWithGitconfig(
      '[http "https://gitlab.corp.example/"]\n\tproxy = http://utilisateur:secret-jeton@proxy.corp.example:3128\n',
    );
    homeWithoutProxy = mkdtempSync(join(tmpdir(), "cds-agent-proxy-check-none-"));
  });

  after(() => {
    rmSync(homeWithProxy, { recursive: true, force: true });
    rmSync(homeWithoutProxy, { recursive: true, force: true });
  });

  test("HTTP_PROXY déjà exportée : jamais d'avertissement, même si git a un proxy configuré", async () => {
    const warnings: string[] = [];
    await warnIfGitProxyNotExported(
      "https://gitlab.corp.example",
      { ...envWithHome(homeWithProxy), HTTP_PROXY: "http://deja-la:3128" },
      (message) => warnings.push(message),
    );
    assert.deepEqual(warnings, []);
  });

  test("HTTPS_PROXY déjà exportée : jamais d'avertissement non plus", async () => {
    const warnings: string[] = [];
    await warnIfGitProxyNotExported(
      "https://gitlab.corp.example",
      { ...envWithHome(homeWithProxy), HTTPS_PROXY: "http://deja-la:3128" },
      (message) => warnings.push(message),
    );
    assert.deepEqual(warnings, []);
  });

  test("aucune variable de proxy exportée, et git n'a rien de configuré : pas d'avertissement (cas nominal sans proxy)", async () => {
    const warnings: string[] = [];
    await warnIfGitProxyNotExported(
      "https://gitlab.com",
      envWithHome(homeWithoutProxy),
      (message) => warnings.push(message),
    );
    assert.deepEqual(warnings, []);
  });

  test("aucune variable de proxy exportée, mais git a un proxy configuré pour GITLAB_URL : avertissement déclenché, sans jamais exposer la valeur du proxy", async () => {
    const warnings: string[] = [];
    await warnIfGitProxyNotExported(
      "https://gitlab.corp.example",
      envWithHome(homeWithProxy),
      (message) => warnings.push(message),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] as string, /gitlab\.corp\.example/);
    assert.match(warnings[0] as string, /HTTP_PROXY/);
    // La valeur du proxy (qui embarque ici un identifiant) ne doit jamais
    // apparaître dans le message — seulement sa présence/absence.
    assert.doesNotMatch(warnings[0] as string, /secret-jeton/);
    assert.doesNotMatch(warnings[0] as string, /proxy\.corp\.example:3128/);
  });
});
