import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Grep-verifiable regression test (this story's own acceptance criterion,
// not just behavioral coverage): the scheduler module must NEVER call
// saveConfig() or import src/lib/config/save.ts, under any circumstance —
// see backoff.ts's and index.ts's own header comments for why this
// discipline is load-bearing for this project. Reads the REAL source files
// on disk (not a copy/paste of their contents) so this test fails the
// moment either file's source changes to violate it, exactly like a real
// `grep -rn saveConfig src/scheduler` would.
const schedulerDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readSchedulerSourceFiles(): { file: string; contents: string }[] {
  return fs
    .readdirSync(schedulerDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ file: name, contents: fs.readFileSync(path.join(schedulerDir, name), "utf8") }));
}

describe("src/scheduler never calls saveConfig() or touches config/save.ts", () => {
  it("no scheduler source file imports or invokes saveConfig — grep-verifiable: `saveConfig(` (a call) or `saveConfig` in an import/from clause never appears", () => {
    const files = readSchedulerSourceFiles();
    expect(files.length).toBeGreaterThan(0); // sanity: this test isn't silently scanning zero files

    // Matches an actual call (`saveConfig(`) or an import/re-export naming it
    // (`import { saveConfig }`, `saveConfig } from`). Deliberately does NOT
    // flag prose that merely mentions the name in a comment explaining this
    // module never calls it (see index.ts's/backoff.ts's own header
    // comments) — this test only fails on real usage, matching what a
    // reviewer's own `grep -n "saveConfig(" src/scheduler` would flag.
    const usagePattern = /saveConfig\s*\(|\bsaveConfig\b\s*[,}]/;

    for (const { file, contents } of files) {
      const codeOnly = contents
        .split("\n")
        .filter((line) => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
        .join("\n");
      expect(codeOnly, `${file} must never import or call saveConfig()`).not.toMatch(usagePattern);
    }
  });

  it("no scheduler source file imports src/lib/config/save.js (the only module that writes config.json)", () => {
    const files = readSchedulerSourceFiles();
    for (const { file, contents } of files) {
      expect(contents, `${file} must never import config/save.js`).not.toMatch(/config\/save(\.js)?["']/);
    }
  });

  it("the only config-reading function imported anywhere in src/scheduler is loadConfig", () => {
    const files = readSchedulerSourceFiles();
    const configImports = files
      .map(({ contents }) => [...contents.matchAll(/from\s+["']([^"']*\/lib\/config\/[^"']+)["']/g)])
      .flat();

    expect(configImports.length).toBeGreaterThan(0); // sanity: the scheduler does read config from somewhere
    for (const match of configImports) {
      expect(match[1]).toBe("../lib/config/load.js");
    }
  });
});
