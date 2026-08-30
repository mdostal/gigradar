// Tests for runRadar()'s custom-source routing fallback (llm-custom-sources
// epic, custom-source-core-mechanism story): `getSource(sc.id) ??
// (sc.kind === "custom-llm" ? customLlmSource : undefined)`. Deliberately
// SEPARATE from runner.test.ts (which never imports the real
// custom-llm-source.ts) and from custom-llm-source.test.ts (which tests
// extraction logic in isolation, never through runRadar()) — this file's
// only job is proving the actual end-to-end wiring: a source id with NO
// hand-written adapter and NO registerSource() call still produces real
// gigs when runRadar() is called, purely via config (`kind: "custom-llm"`).
// The LLM (via the Vercel AI SDK, llm-provider-harness's
// custom-llm-source-credential-migration story) and `playwright` are both
// mocked — no live network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "../../store/index.js";
import type { Config } from "../../types.js";

const { mockGenerateText, mockCreateAnthropic, mockAnthropicModel } = vi.hoisted(() => {
  const mockAnthropicModel = vi.fn((modelId: string) => ({ modelId, provider: "anthropic" }));
  return {
    mockGenerateText: vi.fn(),
    mockCreateAnthropic: vi.fn(() => mockAnthropicModel),
    mockAnthropicModel,
  };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: mockGenerateText };
});

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: mockCreateAnthropic }));

const launchMock = vi.fn();
vi.mock("playwright", () => ({
  chromium: { launch: (...args: unknown[]) => launchMock(...args) },
}));

import { runRadar } from "../runner.js";

const FAKE_CREDENTIAL = { kind: "api-key" as const, provider: "anthropic" as const, value: "fake-api-key" };

function fakeRecipeResult(listings: unknown[]) {
  return { output: { listings, recipe: { listItemSelector: ".job-card", titleSelector: "h3", urlSelector: "a" } } };
}

function setUpFakeBrowser() {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue("<html><body></body></html>"),
    // deriveRecipeAndExtract() validates listItemSelector against the live
    // page via locator(...).count() before ever returning/caching a recipe
    // -- resolve it here to simulate a real, valid CSS selector.
    locator: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(1) }),
  };
  const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
  launchMock.mockResolvedValue(browser);
}

let tmpDir: string;
let dataDir: string;
let dbPath: string;
let db: DatabaseSync;
let originalXdgDataHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-runner-custom-source-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
  // customLlmSource.fetch() reads/writes an extraction-recipe cache under
  // getDefaultDataDir() (XDG_DATA_HOME) -- isolate it the same way every
  // other test that touches that directory does, so this suite never reads
  // or writes the real user's actual ~/.local/share/gigradar/.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-runner-custom-source-test-data-"));
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataDir;
  mockGenerateText.mockReset();
  mockCreateAnthropic.mockClear();
  mockAnthropicModel.mockClear();
  launchMock.mockReset();
});

afterEach(() => {
  closeDb();
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
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
    mockGenerateText.mockResolvedValueOnce(fakeRecipeResult([{ title: "Fractional CFO", url: "https://example.com/jobs/1" }]));

    const result = await runRadar(makeConfig(), { db }, { credential: FAKE_CREDENTIAL });

    expect(result.errors).toEqual([]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.gig.title).toBe("Fractional CFO");
    expect(result.results[0]?.gig.sourceId).toBe("monster");
  });

  it("forwards runOpts.credential through to the custom source's extraction call", async () => {
    setUpFakeBrowser();
    mockGenerateText.mockResolvedValueOnce(fakeRecipeResult([]));

    const result = await runRadar(makeConfig(), { db }, { credential: { kind: "api-key", provider: "anthropic", value: "the-real-key" } });

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([]);
  });

  it("reports a per-source error (never a thrown exception out of runRadar itself) when no credential is supplied for a custom source with no cached recipe yet", async () => {
    setUpFakeBrowser();

    const result = await runRadar(makeConfig(), { db }, {});

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.sourceId).toBe("monster");
    expect(result.errors[0]?.message).toContain("no LLM credential was supplied");
  });

  it("every EXISTING (non-custom) source lookup is unaffected -- an unregistered plain id with no kind still reports 'no such registered source'", async () => {
    const config: Config = {
      ...makeConfig(),
      sources: [{ id: "totally-unregistered-source", enabled: true }],
    };

    const result = await runRadar(config, { db }, { credential: FAKE_CREDENTIAL });

    expect(result.errors).toEqual([{ sourceId: "totally-unregistered-source", message: "no such registered source" }]);
    expect(launchMock).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});
