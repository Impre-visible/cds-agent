export interface ChangeSet {
  paths: string[];
  offending: string[];
}

const TEST_DIRECTORIES = ["tests/", "test/", "__tests__/", "spec/"];
const TEST_FILENAME = /\.(test|spec)\.[cm]?[jt]sx?$/;

export function isTestPath(path: string): boolean {
  if (TEST_DIRECTORIES.some((directory) => path.startsWith(directory)))
    return true;
  const basename = path.split("/").pop() ?? "";
  return TEST_FILENAME.test(basename);
}

/** Lit l'état réel du dépôt, sans faire confiance à ce que l'agent déclare. */
export function collectChanges(porcelain: string): ChangeSet {
  const paths: string[] = [];

  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const payload = line.slice(3);
    // Un renommage s'écrit "ancien -> nouveau" : les deux chemins comptent.
    for (const part of payload.split(" -> ")) {
      const clean = part.trim().replace(/^"|"$/g, "");
      if (clean) paths.push(clean);
    }
  }

  const unique = [...new Set(paths)];
  return {
    paths: unique,
    offending: unique.filter((path) => !isTestPath(path)),
  };
}
