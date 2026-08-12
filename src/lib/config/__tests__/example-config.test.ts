// Proves config.example.json (committed at the repo root — a template for
// users, not a real file loadConfig() ever reads) stays in sync with the
// SAME zod schema loadConfig() validates against. Schema drift breaks this
// test, not just manual upkeep. Also proves .env.example documents every
// "env:" reference the example config makes, with placeholder-only values —
// never anything that reads as a real credential.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../schema.js";

// src/lib/config/__tests__ -> config -> lib -> src -> repo root.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const CONFIG_EXAMPLE_PATH = path.join(REPO_ROOT, "config.example.json");
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, ".env.example");

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describe("config.example.json: validates against the real ConfigSchema", () => {
  it("parses successfully with zero validation errors", () => {
    const parsed = readJson(CONFIG_EXAMPLE_PATH);

    const result = ConfigSchema.safeParse(parsed);

    expect(result.success).toBe(true);
  });

  it("exercises an 'env:'-reference example in sources[].settings (the convention this story adds)", () => {
    const parsed = readJson(CONFIG_EXAMPLE_PATH) as {
      sources: Array<{ settings?: Record<string, unknown> }>;
    };

    const envRefs = parsed.sources
      .flatMap((s) => Object.values(s.settings ?? {}))
      .filter((v): v is string => typeof v === "string" && v.startsWith("env:"));

    expect(envRefs.length).toBeGreaterThan(0);
  });
});

describe(".env.example: one placeholder line per env: reference in config.example.json", () => {
  it("declares every referenced var, with a non-empty placeholder value", () => {
    const parsed = readJson(CONFIG_EXAMPLE_PATH) as {
      sources: Array<{ settings?: Record<string, unknown> }>;
    };
    const referencedVars = new Set(
      parsed.sources
        .flatMap((s) => Object.values(s.settings ?? {}))
        .filter((v): v is string => typeof v === "string" && v.startsWith("env:"))
        .map((v) => v.slice("env:".length)),
    );
    expect(referencedVars.size).toBeGreaterThan(0);

    const envExample = fs.readFileSync(ENV_EXAMPLE_PATH, "utf8");
    const declared = new Map<string, string>();
    for (const line of envExample.split("\n")) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined) declared.set(match[1], match[2]);
    }

    for (const varName of referencedVars) {
      expect(declared.has(varName), `.env.example is missing a placeholder line for ${varName}`).toBe(true);
      expect(declared.get(varName)?.length).toBeGreaterThan(0);
    }
  });

  it("contains no real-looking secret material — this is a committed file, never a place for actual credentials", () => {
    const envExample = fs.readFileSync(ENV_EXAMPLE_PATH, "utf8");

    // Loose sanity guard: real API keys from common providers have
    // recognizable high-entropy prefixes/shapes. The placeholder values in
    // this file should read as obviously fake instead.
    expect(envExample).not.toMatch(/sk-[A-Za-z0-9]{20,}/); // OpenAI/Anthropic-style key shape
    expect(envExample.toLowerCase()).toMatch(/example|placeholder|dummy|not-a-real/);
  });
});
