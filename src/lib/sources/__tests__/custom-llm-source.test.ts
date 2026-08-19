// Tests for src/lib/sources/custom-llm-source.ts (llm-custom-sources epic).
// This file's job is ONLY the cache-then-fallback orchestration + Source
// wiring — the actual extraction/recipe logic (custom-source-recipe.ts's
// readRecipe/writeRecipe/extractWithRecipe/deriveRecipeAndExtract) is
// mocked here and tested in its own dedicated file
// (custom-source-recipe.test.ts). `playwright` is mocked (no real browser);
// no LLM SDK is ever imported by this file, since this file never calls
// one directly.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Gig, Profile, SourceConfig } from "../../types.js";
import type { CustomSourceRecipe } from "../custom-source-recipe.js";

const FAKE_CREDENTIAL = { kind: "api-key" as const, provider: "anthropic" as const, value: "fake-api-key" };

const launchMock = vi.fn();
vi.mock("playwright", () => ({
  chromium: { launch: (...args: unknown[]) => launchMock(...args) },
}));

const readRecipeMock = vi.fn();
const writeRecipeMock = vi.fn();
const extractWithRecipeMock = vi.fn();
const deriveRecipeAndExtractMock = vi.fn();
const followPaginationMock = vi.fn();
vi.mock("../custom-source-recipe.js", () => ({
  readRecipe: (...args: unknown[]) => readRecipeMock(...args),
  writeRecipe: (...args: unknown[]) => writeRecipeMock(...args),
  extractWithRecipe: (...args: unknown[]) => extractWithRecipeMock(...args),
  deriveRecipeAndExtract: (...args: unknown[]) => deriveRecipeAndExtractMock(...args),
  followPagination: (...args: unknown[]) => followPaginationMock(...args),
}));

const withBrowserSessionMock = vi.fn();
vi.mock("../../auth/browser-session.js", () => ({
  withBrowserSession: (...args: unknown[]) => withBrowserSessionMock(...args),
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
  withBrowserSessionMock.mockReset();
  followPaginationMock.mockReset();
  // Default: pass the first-page gigs through unchanged -- most tests here
  // aren't exercising pagination itself (that's custom-source-recipe.test.ts's
  // job); this file only needs to prove followPagination() is CALLED with
  // the right args, not re-test its own internal logic.
  followPaginationMock.mockImplementation((_page: unknown, _sourceId: string, _recipe: unknown, gigs: unknown) => Promise.resolve(gigs));
});

describe("customLlmSource.fetch: settings.url", () => {
  it("throws a specific, actionable error (before ever launching a browser) when settings.url is missing", async () => {
    const cfg: SourceConfig = { id: "monster", enabled: true, kind: "custom-llm", settings: {} };

    await expect(customLlmSource.fetch(cfg, PROFILE, FAKE_CREDENTIAL)).rejects.toThrow(/missing settings\.url/);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("navigates to the exact configured url", async () => {
    const { page } = setUpFakeBrowser();
    readRecipeMock.mockReturnValue(FAKE_RECIPE);
    extractWithRecipeMock.mockResolvedValue(FAKE_GIGS);

    await customLlmSource.fetch(customSourceCfg({ url: "https://example.com/truck-jobs" }), PROFILE, FAKE_CREDENTIAL);

    expect(page.goto).toHaveBeenCalledWith("https://example.com/truck-jobs");
  });
});

describe("customLlmSource.fetch: cache-hit fast path (no LLM derivation)", () => {
  it("returns extractWithRecipe()'s result directly and never calls deriveRecipeAndExtract()/writeRecipe() when a cached recipe still matches", async () => {
    setUpFakeBrowser();
    readRecipeMock.mockReturnValue(FAKE_RECIPE);
    extractWithRecipeMock.mockResolvedValue(FAKE_GIGS);

    const gigs = await customLlmSource.fetch(customSourceCfg(), PROFILE, FAKE_CREDENTIAL);

    expect(gigs).toBe(FAKE_GIGS);
    expect(extractWithRecipeMock).toHaveBeenCalledWith(expect.anything(), "monster", FAKE_RECIPE);
    expect(deriveRecipeAndExtractMock).not.toHaveBeenCalled();
    expect(writeRecipeMock).not.toHaveBeenCalled();
  });

  it("succeeds via the cached recipe even with NO credential supplied -- one is only needed on the LLM-derivation fallback", async () => {
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

    const gigs = await customLlmSource.fetch(customSourceCfg(), PROFILE, FAKE_CREDENTIAL);

    expect(extractWithRecipeMock).not.toHaveBeenCalled();
    expect(deriveRecipeAndExtractMock).toHaveBeenCalledWith(expect.anything(), "monster", undefined, FAKE_CREDENTIAL);
    expect(writeRecipeMock).toHaveBeenCalledWith("monster", FAKE_RECIPE);
    expect(gigs).toBe(FAKE_GIGS);
  });

  it("calls deriveRecipeAndExtract() and overwrites the cache when extractWithRecipe() returns null (stale recipe)", async () => {
    setUpFakeBrowser();
    readRecipeMock.mockReturnValue(FAKE_RECIPE);
    extractWithRecipeMock.mockResolvedValue(null);
    const freshRecipe: CustomSourceRecipe = { ...FAKE_RECIPE, listItemSelector: ".new-card-class" };
    deriveRecipeAndExtractMock.mockResolvedValue({ gigs: FAKE_GIGS, recipe: freshRecipe });

    const gigs = await customLlmSource.fetch(customSourceCfg(), PROFILE, FAKE_CREDENTIAL);

    expect(deriveRecipeAndExtractMock).toHaveBeenCalled();
    expect(writeRecipeMock).toHaveBeenCalledWith("monster", freshRecipe);
    expect(gigs).toBe(FAKE_GIGS);
  });

  it("passes settings.hint through to deriveRecipeAndExtract()", async () => {
    setUpFakeBrowser();
    readRecipeMock.mockReturnValue(undefined);
    deriveRecipeAndExtractMock.mockResolvedValue({ gigs: FAKE_GIGS, recipe: FAKE_RECIPE });

    await customLlmSource.fetch(customSourceCfg({ hint: "this is a truck-driving jobs board" }), PROFILE, FAKE_CREDENTIAL);

    expect(deriveRecipeAndExtractMock).toHaveBeenCalledWith(expect.anything(), "monster", "this is a truck-driving jobs board", FAKE_CREDENTIAL);
  });

  it("throws a specific error and never calls deriveRecipeAndExtract() when credential is missing and there's no usable cached recipe", async () => {
    setUpFakeBrowser();
    readRecipeMock.mockReturnValue(undefined);

    await expect(customLlmSource.fetch(customSourceCfg(), PROFILE, undefined)).rejects.toThrow(/no LLM credential was supplied/);
    expect(deriveRecipeAndExtractMock).not.toHaveBeenCalled();
  });
});

describe("customLlmSource.fetch: headless chromium.launch(), closed on every exit path", () => {
  it("launches headless chromium.launch() -- not headed, not real-chrome.ts", async () => {
    setUpFakeBrowser();
    readRecipeMock.mockReturnValue(FAKE_RECIPE);
    extractWithRecipeMock.mockResolvedValue(FAKE_GIGS);

    await customLlmSource.fetch(customSourceCfg(), PROFILE, FAKE_CREDENTIAL);

    expect(launchMock).toHaveBeenCalledWith({ headless: true });
  });

  it("closes the browser even when deriveRecipeAndExtract() throws", async () => {
    const { browser } = setUpFakeBrowser();
    readRecipeMock.mockReturnValue(undefined);
    deriveRecipeAndExtractMock.mockRejectedValue(new Error("simulated derivation failure"));

    await expect(customLlmSource.fetch(customSourceCfg(), PROFILE, FAKE_CREDENTIAL)).rejects.toThrow("simulated derivation failure");

    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe("customLlmSource.fetch: pagination is delegated to followPagination()", () => {
  it("calls followPagination() with the recipe + first-page gigs on a cache hit, and returns its result", async () => {
    setUpFakeBrowser();
    readRecipeMock.mockReturnValue(FAKE_RECIPE);
    extractWithRecipeMock.mockResolvedValue(FAKE_GIGS);
    const paginatedGigs: Gig[] = [
      ...FAKE_GIGS,
      { sourceId: "monster", externalId: "https://example.com/2", title: "Page 2 listing", url: "https://example.com/2" },
    ];
    followPaginationMock.mockResolvedValue(paginatedGigs);

    const gigs = await customLlmSource.fetch(customSourceCfg(), PROFILE, FAKE_CREDENTIAL);

    expect(followPaginationMock).toHaveBeenCalledWith(expect.anything(), "monster", FAKE_RECIPE, FAKE_GIGS);
    expect(gigs).toBe(paginatedGigs);
  });

  it("calls followPagination() with the freshly-derived recipe + gigs on a cache-miss LLM derivation", async () => {
    setUpFakeBrowser();
    readRecipeMock.mockReturnValue(undefined);
    deriveRecipeAndExtractMock.mockResolvedValue({ gigs: FAKE_GIGS, recipe: FAKE_RECIPE });

    await customLlmSource.fetch(customSourceCfg(), PROFILE, FAKE_CREDENTIAL);

    expect(followPaginationMock).toHaveBeenCalledWith(expect.anything(), "monster", FAKE_RECIPE, FAKE_GIGS);
  });
});

describe("customLlmSource.fetch: settings.customAuth === \"browser-session\"", () => {
  function authedCfg(settings: Record<string, unknown> = {}): SourceConfig {
    return customSourceCfg({
      customAuth: "browser-session",
      sessionStatePath: "/fake/monster-session.json",
      allowedOrigins: ["monster.com"],
      ...settings,
    });
  }

  it("routes to withBrowserSession() instead of chromium.launch(), with the resolved allowedOrigins/sessionStatePath/sessionBackend", async () => {
    withBrowserSessionMock.mockResolvedValue(FAKE_GIGS);

    const gigs = await customLlmSource.fetch(authedCfg(), PROFILE, FAKE_CREDENTIAL);

    expect(launchMock).not.toHaveBeenCalled();
    expect(withBrowserSessionMock).toHaveBeenCalledTimes(1);
    const [options] = withBrowserSessionMock.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(options.sourceId).toBe("monster");
    expect(options.storageStatePathSetting).toBe("/fake/monster-session.json");
    expect(options.allowedOrigins).toEqual(["monster.com"]);
    expect(options.sessionBackend).toBe("local");
    expect(options.url).toBe("https://example.com/jobs");
    expect(gigs).toBe(FAKE_GIGS);
  });

  it("isAuthenticated always resolves true -- no source-specific auth-failure check exists for an arbitrary custom site", async () => {
    withBrowserSessionMock.mockResolvedValue(FAKE_GIGS);

    await customLlmSource.fetch(authedCfg(), PROFILE, FAKE_CREDENTIAL);

    const [options] = withBrowserSessionMock.mock.calls[0] as [{ isAuthenticated: () => Promise<boolean> }, unknown];
    await expect(options.isAuthenticated()).resolves.toBe(true);
  });

  it("passes sessionBackend:\"portunus\" through when settings.sessionBackend is portunus", async () => {
    withBrowserSessionMock.mockResolvedValue(FAKE_GIGS);

    await customLlmSource.fetch(authedCfg({ sessionBackend: "portunus" }), PROFILE, FAKE_CREDENTIAL);

    const [options] = withBrowserSessionMock.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(options.sessionBackend).toBe("portunus");
  });

  it("throws a specific error (before calling withBrowserSession()) when settings.sessionStatePath is missing", async () => {
    const cfg = customSourceCfg({ customAuth: "browser-session", allowedOrigins: ["monster.com"] });

    await expect(customLlmSource.fetch(cfg, PROFILE, FAKE_CREDENTIAL)).rejects.toThrow(/missing settings\.sessionStatePath/);
    expect(withBrowserSessionMock).not.toHaveBeenCalled();
  });

  it("throws a specific error (before calling withBrowserSession()) when there's no allowedOrigins from either the static registry or settings", async () => {
    const cfg = customSourceCfg({ customAuth: "browser-session", sessionStatePath: "/fake/monster-session.json" });

    await expect(customLlmSource.fetch(cfg, PROFILE, FAKE_CREDENTIAL)).rejects.toThrow(/no origin allowlist registered/);
    expect(withBrowserSessionMock).not.toHaveBeenCalled();
  });

  it("the withBrowserSession() callback runs the SAME cache-then-derive extraction as the no-auth path", async () => {
    withBrowserSessionMock.mockImplementation(async (_options: unknown, run: (page: unknown) => Promise<Gig[]>) => run({ fakePage: true }));
    readRecipeMock.mockReturnValue(FAKE_RECIPE);
    extractWithRecipeMock.mockResolvedValue(FAKE_GIGS);

    const gigs = await customLlmSource.fetch(authedCfg(), PROFILE, FAKE_CREDENTIAL);

    expect(extractWithRecipeMock).toHaveBeenCalledWith({ fakePage: true }, "monster", FAKE_RECIPE);
    expect(gigs).toBe(FAKE_GIGS);
  });
});
