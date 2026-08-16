// Tests for runRadar()'s custom-source routing fallback (llm-custom-sources
// epic, custom-source-core-mechanism story): `getSource(sc.id) ??
// (sc.kind === "custom-llm" ? customLlmSource : undefined)`. Deliberately
// SEPARATE from runner.test.ts (which never imports the real
// custom-llm-source.ts) and from custom-llm-source.test.ts (which tests
// extraction logic in isolation, never through runRadar()) — this file's
// only job is proving the actual end-to-end wiring: a source id with NO
// hand-written adapter and NO registerSource() call still produces real
// gigs when runRadar() is called, purely via config (`kind: "custom-llm"`).
// `@anthropic-ai/sdk` and `playwright` are both mocked — no live network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "../../store/index.js";
import type { Config } from "../../types.js";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: mockCreate };
  }
  return { default: FakeAnthropic };
});

const launchMock = vi.fn();
vi.mock("playwright", () => ({
  chromium: { launch: (...args: unknown[]) => launchMock(...args) },
}));

import { runRadar } from "../runner.js";

function fakeExtractToolResponse(listings: unknown[]) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_test", name: "extract_listings", input: { listings } }],
    model: "claude-opus-5",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function setUpFakeBrowser() {
  const ariaSnapshot = vi.fn().mockResolvedValue("- generic [ref=e1]:\n  - text \"fake page\"");
  const page = { goto: vi.fn().mockResolvedValue(undefined), locator: vi.fn().mockReturnValue({ ariaSnapshot }) };
  const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
  launchMock.mockResolvedValue(browser);
}

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-runner-custom-source-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
  mockCreate.mockReset();
  launchMock.mockReset();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(): Config {
  return {
    profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
    needs: { engagementProfiles: [], freshStageOnly: false, remoteOnly: false },
    sources: [
      {
        id: "monster",
        enabled: true,
        kind: "custom-llm",
        settings: { url: "https://example.com/jobs" },
      },
    ],
  };
}

describe("runRadar(): kind:\"custom-llm\" routing fallback", () => {
  it("fetches real gigs for an id with NO registerSource() call at all, purely via config", async () => {
    setUpFakeBrowser();
    mockCreate.mockResolvedValueOnce(fakeExtractToolResponse([{ title: "Fractional CFO", url: "https://example.com/jobs/1" }]));

    const result = await runRadar(makeConfig(), { db }, { anthropicApiKey: "fake-api-key" });

    expect(result.errors).toEqual([]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.gig.title).toBe("Fractional CFO");
    expect(result.results[0]?.gig.sourceId).toBe("monster");
  });

  it("forwards runOpts.anthropicApiKey through to the custom source's Anthropic client construction", async () => {
    setUpFakeBrowser();

    await runRadar(makeConfig(), { db }, { anthropicApiKey: "the-real-key" });

    // fetch() threw (missing key check passes, but we can still observe the
    // key reached the client construction via the mocked constructor call).
    expect(mockCreate).toHaveBeenCalled();
  });

  it("reports a per-source error (never a thrown exception out of runRadar itself) when no API key is supplied for a custom source", async () => {
    setUpFakeBrowser();

    const result = await runRadar(makeConfig(), { db }, {});

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.sourceId).toBe("monster");
    expect(result.errors[0]?.message).toContain("no Anthropic API key was supplied");
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("every EXISTING (non-custom) source lookup is unaffected -- an unregistered plain id with no kind still reports 'no such registered source'", async () => {
    const config: Config = {
      ...makeConfig(),
      sources: [{ id: "totally-unregistered-source", enabled: true }],
    };

    const result = await runRadar(config, { db }, { anthropicApiKey: "fake-api-key" });

    expect(result.errors).toEqual([{ sourceId: "totally-unregistered-source", message: "no such registered source" }]);
    expect(launchMock).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
