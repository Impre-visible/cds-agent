import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { log, withRequestContext, currentContext, formatLine } from "./log.ts";

/**
 * Intercepte console.log/warn/error le temps d'un test. Sûr en parallèle :
 * `node --test` isole chaque fichier de test dans son propre process (voir
 * les autres *.test.ts du projet, aucun ne mutualise l'état global entre
 * fichiers).
 */
function captureConsole(): {
  lines: { level: "log" | "warn" | "error"; text: string }[];
  restore: () => void;
} {
  const lines: { level: "log" | "warn" | "error"; text: string }[] = [];
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = (text: string) => lines.push({ level: "log", text });
  console.warn = (text: string) => lines.push({ level: "warn", text });
  console.error = (text: string) => lines.push({ level: "error", text });
  return {
    lines,
    restore: () => {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    },
  };
}

describe("log — corrélation (§6.4)", () => {
  test("une ligne émise pendant le traitement porte key/projectPath/iid", async () => {
    const capture = captureConsole();
    try {
      await withRequestContext(
        { key: "note:1", projectPath: "grp/repo", iid: 42 },
        async () => {
          log.info("étape");
        },
      );
    } finally {
      capture.restore();
    }

    assert.equal(capture.lines.length, 1);
    const parsed = JSON.parse(capture.lines[0]!.text);
    assert.equal(parsed.key, "note:1");
    assert.equal(parsed.projectPath, "grp/repo");
    assert.equal(parsed.iid, 42);
    assert.equal(parsed.msg, "étape");
    assert.equal(parsed.level, "info");
    assert.ok(typeof parsed.ts === "string" && parsed.ts.length > 0);
  });

  test("hors traitement, aucun contexte n'est inventé", () => {
    const capture = captureConsole();
    try {
      log.info("hors contexte");
    } finally {
      capture.restore();
    }

    const parsed = JSON.parse(capture.lines[0]!.text);
    assert.equal("key" in parsed, false);
    assert.equal("projectPath" in parsed, false);
    assert.equal("iid" in parsed, false);
  });

  test("le contexte ne fuit pas d'une demande à l'autre une fois withRequestContext terminé", async () => {
    await withRequestContext(
      { key: "a", projectPath: "p", iid: 1 },
      async () => {
        assert.deepEqual(currentContext(), { key: "a", projectPath: "p", iid: 1 });
      },
    );
    assert.equal(currentContext(), undefined);
  });

  test("deux contextes imbriqués/successifs ne se mélangent jamais", async () => {
    const capture = captureConsole();
    try {
      await withRequestContext(
        { key: "req-a", projectPath: "grp/a", iid: 1 },
        async () => log.info("dans a"),
      );
      await withRequestContext(
        { key: "req-b", projectPath: "grp/b", iid: 2 },
        async () => log.info("dans b"),
      );
    } finally {
      capture.restore();
    }

    const a = JSON.parse(capture.lines[0]!.text);
    const b = JSON.parse(capture.lines[1]!.text);
    assert.equal(a.key, "req-a");
    assert.equal(b.key, "req-b");
  });

  test("mode par défaut : une ligne JSON valide", () => {
    const capture = captureConsole();
    try {
      log.warn("attention", { detail: "x" });
    } finally {
      capture.restore();
    }
    const line = capture.lines[0]!.text;
    assert.doesNotThrow(() => JSON.parse(line));
    const parsed = JSON.parse(line);
    assert.equal(parsed.detail, "x");
    assert.equal(parsed.level, "warn");
  });

  test("LOG_PRETTY=1 : sortie lisible, pas du JSON", () => {
    process.env.LOG_PRETTY = "1";
    const capture = captureConsole();
    try {
      log.error("boum");
    } finally {
      capture.restore();
      delete process.env.LOG_PRETTY;
    }
    const line = capture.lines[0]!.text;
    assert.match(line, /ERROR/);
    assert.match(line, /boum/);
    assert.throws(() => JSON.parse(line));
  });

  test("LOG_LEVEL filtre les niveaux inférieurs", () => {
    process.env.LOG_LEVEL = "warn";
    const capture = captureConsole();
    try {
      log.info("ignoré");
      log.warn("gardé");
    } finally {
      capture.restore();
      delete process.env.LOG_LEVEL;
    }
    assert.equal(capture.lines.length, 1);
    assert.match(capture.lines[0]!.text, /gardé/);
  });

  test("niveaux error/warn utilisent bien console.error/console.warn (pas console.log)", () => {
    const capture = captureConsole();
    try {
      log.error("e");
      log.warn("w");
      log.info("i");
      log.debug("d"); // filtré par défaut (niveau info)
    } finally {
      capture.restore();
    }
    assert.deepEqual(
      capture.lines.map((l) => l.level),
      ["error", "warn", "log"],
    );
  });
});

describe("formatLine", () => {
  test("mode JSON produit une ligne parseable, une par ligne", () => {
    const line = formatLine(
      { ts: "2020-01-01T00:00:00.000Z", level: "info", msg: "x" },
      false,
    );
    assert.equal(line.includes("\n"), false);
    assert.doesNotThrow(() => JSON.parse(line));
  });

  test("mode pretty inclut la clé de corrélation entre crochets", () => {
    const line = formatLine(
      {
        ts: "2020-01-01T00:00:00.000Z",
        level: "info",
        msg: "x",
        key: "note:1",
        projectPath: "grp/repo",
        iid: 42,
      },
      true,
    );
    assert.match(line, /\[note:1 grp\/repo!42\]/);
    assert.match(line, /INFO/);
  });

  test("mode pretty sans contexte : pas de crochets", () => {
    const line = formatLine(
      { ts: "2020-01-01T00:00:00.000Z", level: "warn", msg: "x" },
      true,
    );
    assert.equal(line.includes("["), false);
  });
});
