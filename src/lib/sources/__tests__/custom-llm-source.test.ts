// Tests for src/lib/sources/custom-llm-source.ts (llm-custom-sources epic).
// This file's job is ONLY the cache-then-fallback orchestration + Source
// wiring — the actual extraction/recipe logic (custom-source-recipe.ts's
// readRecipe/writeRecipe/extractWithRecipe/deriveRecipeAndExtract) is
// mocked here and tested in its own dedicated file
// (custom-source-recipe.test.ts). `playwright` is mocked (no real browser);
// `@anthropic-ai/sdk` is never even imported by this file, since this file
// never calls it directly.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Gig, Profile, SourceConfig } from "../../types.js";
import type { CustomSourceRecipe } from "../custom-source-recipe.js";

const launchMock = vi.fn();
vi.mock("playwright", () => ({
  chromium: { launch: (...args: unknown[]) => launchMock(...args) },
}));

const readRecipeMock = vi.fn();
const writeRecipeMock = vi.fn();
const extractWithRecipeMock = vi.fn();
const deriveRecipeAndExtractMock = vi.fn();
vi.mock("../custom-source-recipe.js", () => ({
  readRecipe: (...args: unknown[]) => readRecipeMock(...args),
  writeRecipe: (...args: unknown[]) => writeRecipeMock(...args),
  extractWithRecipe: (...args: unknown[]) => extractWithRecipeMock(...args),
  deriveRecipeAndExtract: (...args: unknown[]) => deriveRecipeAndExtractMock(...args),
}));

import { customLlmSource } from "../custom-llm-source.js";

const PROFILE: Profile = { name: "Jane Doe", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" };

const FAKE_RECIPE: CustomSourceRecipe = {
  listItemSelector: ".job-card",
  titleSelector: "h3",
  urlSelector: "a",
  derivedAt: "2026-01-01T00:00:00.000Z",
};

const FAKE_GIGS: Gig[] = [{ sourceId: "monster", externalId: "https://example.com/1", title: "Fractional CFO", url: "https://example.com/1" }];

function customSourceCfg(settings: Record<string, unknown> = {}): SourceConfig {
  return { id: "monster", enabled: true, kind: "custom-llm", settings: { url: "https://example.com/jobs", ...settings } };
}

function setUpFakeBrowser() {
  const page = { goto: vi.fn().mockResolvedValue(undefined) };
  const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
  launchMock.mockResolvedValue(browser);
  return { browser, page };
}

beforeEach(() => {
  launchMock.mockReset();
  readRecipeMock.mockReset();
  writeRecipeMock.mockReset();
  extractWithRecipeMock.mockReset();
  deriveRecipeAndExtractMock.mockReset();
});

describe("customLlmSource.fetch: settings.url", () => {
  it("throws a specific, actionable error (before ever launching a browser) when settings.url is missing", async () => {
    const cfg: SourceConfig = { id: "monster", enabled: true, kind: "custom-llm", settings: {} };

    await expect(customLlmSource.fetch(cfg, PROFILE, "fake-api-key")).rejects.toThrow(/missing settings\.url/);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("navigates to the exact configured url", async () => {
    const { page } = setUpFakeBrowser();
    readRecipeMock.mockReturnValue(FAKE_RECIPE);
    extractWithRecipeMock.mockResolvedValue(FAKE_GIGS);

    await customLlmSource.fetch(customSourceCfg({ url: "https://example.com/truck-jobs" }), PROFILE, "fake-api-key");

    expect(page.goto).toHaveBeenCalledWith("https://example.com/truck-jobs");
  });
});

describe("customLlmSource.fetch: cache-hit fast path (no LLM derivation)", () => {
  it("returns extractWithRecipe()'s result directly and never calls deriveRecipeAndExtract()/writeRecipe() when a cached recipe still matches", async () => {
    setUpFakeBrowser();
    readRecipeMock.mockReturnValue(FAKE_RECIPE);
    extractWithRecipeMock.mockResolvedValue(FAKE_GIGS);

    const gigs = await customLlmSource.fetch(customSourceCfg(), PROFILE, "fake-api-key");

    expect(gigs).toBe(FAKE_GIGS);
    expect(extractWithRecipeMock).toHaveBeenCalledWith(expect.anything(), "monster", FAKE_RECIPE);
    expect(deriveRecipeAndExtractMock).not.toHaveBeenCalled();
    expect(writeRecipeMock).not.toHaveBeenCalled();
  });

  it("succeeds via the cached recipe even with NO apiKey supplied -- the key is only needed on the LLM-derivation fallback", async () => {
    setUpFakeBrowser();
    readRecipeMock.mockReturnValue(FAKE_RECIPE);
    extractWithRecipeMock.mockResolvedValue(FAKE_GIGS);

    const gigs = await customLlmSource.fetch(customSourceCfg(), PROFILE, undefined);

    expect(gigs).toBe(FAKE_GIGS);
    expect(deriveRecipeAndExtractMock).not.toHaveBeenCalled();
  });
});

describe("customLlmSource.fetch: cache-miss / stale-recipe fallback to LLM derivation", () => {
  it("calls deriveRecipeAndExtract() and writeRecipe() when no recipe is cached yet", async () => {
    setUpFakeBrowser();
    readRecipeMock.mockReturnValue(undefined);
    deriveRecipeAndExtractMock.mockResolvedValue({ gigs: FAKE_GIGS, recipe: FAKE_RECIPE });

    const gigs = await customLlmSource.fetch(customSourceCfg(), PROFILE, "fake-api-key");

    expect(extractWithRecipeMock).not.toHaveBeenCalled();
    expect(deriveRecipeAndExtractMock).toHaveBeenCalledWith(expect.anything(), "monster", undefined, "fake-api-key");
    expect(writeRecipeMock).toHaveBeenCalledWith("monster", FAKE_RECIPE);
    expect(gigs).toBe(FAKE_GIGS);
  });

  it("calls deriveRecipeAndExtract() and overwrites the cache when extractWithRecipe() returns null (stale recipe)", async () => {
    setUpFakeBrowser();
    readRecipeMock.mockReturnValue(FAKE_RECIPE);
    extractWithRecipeMock.mockResolvedValue(null);
    const freshRecipe: CustomSourceRecipe = { ...FAKE_RECIPE, listItemSelector: ".new-card-class" };
    deriveRecipeAndExtractMock.mockResolvedValue({ gigs: FAKE_GIGS, recipe: freshRecipe });

    const gigs = await customLlmSource.fetch(customSourceCfg(), PROFILE, "fake-api-key");

    expect(deriveRecipeAndExtractMock).toHaveBeenCalled();
    expect(writeRecipeMock).toHaveBeenCalledWith("monster", freshRecipe);
    expect(gigs).toBe(FAKE_GIGS);
  });

  it("passes settings.hint through to deriveRecipeAndExtract()", async () => {
    setUpFakeBrowser();
    readRecipeMock.mockReturnValue(undefined);
    deriveRecipeAndExtractMock.mockResolvedValue({ gigs: FAKE_GIGS, recipe: FAKE_RECIPE });

    await customLlmSource.fetch(customSourceCfg({ hint: "this is a truck-driving jobs board" }), PROFILE, "fake-api-key");

    expect(deriveRecipeAndExtractMock).toHaveBeenCalledWith(expect.anything(), "monster", "this is a truck-driving jobs board", "fake-api-key");
  });

  it("throws a specific error and never calls deriveRecipeAndExtract() when apiKey is missing and there's no usable cached recipe", async () => {
    setUpFakeBrowser();
    readRecipeMock.mockReturnValue(undefined);

    await expect(customLlmSource.fetch(customSourceCfg(), PROFILE, undefined)).rejects.toThrow(/no Anthropic API key was supplied/);
    expect(deriveRecipeAndExtractMock).not.toHaveBeenCalled();
  });
});

describe("customLlmSource.fetch: headless chromium.launch(), closed on every exit path", () => {
  it("launches headless chromium.launch() -- not headed, not real-chrome.ts", async () => {
    setUpFakeBrowser();
    readRecipeMock.mockReturnValue(FAKE_RECIPE);
    extractWithRecipeMock.mockResolvedValue(FAKE_GIGS);

    await customLlmSource.fetch(customSourceCfg(), PROFILE, "fake-api-key");

    expect(launchMock).toHaveBeenCalledWith({ headless: true });
  });

  it("closes the browser even when deriveRecipeAndExtract() throws", async () => {
    const { browser } = setUpFakeBrowser();
    readRecipeMock.mockReturnValue(undefined);
    deriveRecipeAndExtractMock.mockRejectedValue(new Error("simulated derivation failure"));

    await expect(customLlmSource.fetch(customSourceCfg(), PROFILE, "fake-api-key")).rejects.toThrow("simulated derivation failure");

    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
