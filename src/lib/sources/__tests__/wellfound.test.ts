// Tests for src/lib/sources/wellfound.ts. `withBrowserSession` itself
// (origin-scoping, headed-only launch, centralized cleanup, auth-failure
// throw) is already fully covered by
// src/lib/auth/__tests__/browser-session.test.ts — this file mocks that
// module entirely (no real/simulated Chromium launch anywhere here, so zero
// live browser launches happen in `npm test`) and focuses on what's
// specific to THIS adapter, mirroring gofractional.test.ts's/ateam.test.ts's
// structure.
//
// LIVE-VERIFIED 2026-08-31 (product-review-followups epic — the owner's own
// real account). This REPLACES an earlier version of this test file that
// exercised a `__NEXT_DATA__` JSON-walk implementation — that approach's
// own fixture was explicitly synthetic (its target URLs 404'd even
// anonymously) and was never actually confirmed against real data. The
// real, working board is a flat DOM anchor list at `https://wellfound.com/jobs`
// (see wellfound.ts's own file-level comment for the exact real card
// shape observed) — this file now mirrors ateam.test.ts's/gofractional.
// test.ts's `evaluateResult` mocking convention instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../types.js";

const withBrowserSessionMock = vi.fn();
vi.mock("../../auth/browser-session.js", () => ({
  withBrowserSession: (...args: unknown[]) => withBrowserSessionMock(...args),
}));

// Imported AFTER the mock is registered (vi.mock is hoisted by vitest).
import { wellfoundSource } from "../wellfound.js";
import { SOURCE_LOGIN_URLS, SOURCE_ORIGINS } from "../origins.js";

const REAL_CARD_LISTINGS = [
  { href: "4617965-founding-cto-chief-ai-delivery-officer", title: "Founding CTO / Chief AI & Delivery Officer" },
  { href: "4610203-vp-of-engineering", title: "VP of Engineering" },
];

interface WithBrowserSessionOptions {
  sourceId: string;
  storageStatePathSetting: string;
  allowedOrigins: string[];
  url: string;
  isAuthenticated: (page: unknown) => Promise<boolean>;
}

/**
 * A fake Page: `.title()`/`.textContent()` (used by isSignInPage()) and
 * `.evaluate()` (used by scrapeJobCards()) are independently canned, same
 * separation ateam.test.ts's/gofractional.test.ts's fake page uses.
 * `.waitForLoadState()` is mocked resolved — scrapeJobCards() waits for
 * network idle before evaluating.
 */
function createFakePage(opts: { title?: string; bodyText?: string; evaluateResult?: unknown } = {}) {
  return {
    title: vi.fn().mockResolvedValue(opts.title ?? "Startup Jobs & AI Recruiting Platform | Wellfound"),
    textContent: vi.fn().mockResolvedValue(opts.bodyText ?? ""),
    evaluate: vi.fn().mockResolvedValue(opts.evaluateResult ?? REAL_CARD_LISTINGS),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
  };
}

/** Wires the mocked withBrowserSession to actually invoke the adapter's `run` callback against a fake page, capturing the options it was called with. */
function stubWithBrowserSession(page: ReturnType<typeof createFakePage>) {
  let capturedOptions: WithBrowserSessionOptions | undefined;
  withBrowserSessionMock.mockImplementation(async (options: WithBrowserSessionOptions, run: (p: unknown) => Promise<unknown>) => {
    capturedOptions = options;
    return run(page);
  });
  return () => capturedOptions;
}

const cfg: SourceConfig = { id: "wellfound", enabled: true, settings: { sessionStatePath: "/fake/wellfound-session.json" } };
const profile = { name: "t", roles: [], skills: [], timezone: "UTC" };

describe("wellfoundSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    withBrowserSessionMock.mockReset();
  });

  it("normalizes real job cards into Gig[] with real per-listing urls (never the board's own list-view url)", async () => {
    const page = createFakePage();
    stubWithBrowserSession(page);

    const gigs = await wellfoundSource.fetch(cfg, profile);

    expect(gigs).toHaveLength(2);

    const founding = gigs.find((g) => g.externalId === "4617965-founding-cto-chief-ai-delivery-officer");
    expect(founding).toMatchObject({
      sourceId: "wellfound",
      externalId: "4617965-founding-cto-chief-ai-delivery-officer",
      title: "Founding CTO / Chief AI & Delivery Officer",
      url: "https://wellfound.com/jobs/4617965-founding-cto-chief-ai-delivery-officer",
    });

    for (const g of gigs) {
      expect(g.url).toMatch(/^https:\/\/wellfound\.com\/jobs\//);
      expect(g.url).not.toBe("https://wellfound.com/jobs");
    }
  });

  it("never fabricates company/rate/weeklyHours/remote/postedAt — not reliably extractable from the real card DOM observed live, so all stay unset rather than guessed", async () => {
    const page = createFakePage();
    stubWithBrowserSession(page);

    const gigs = await wellfoundSource.fetch(cfg, profile);

    for (const g of gigs) {
      expect(g.company).toBeUndefined();
      expect(g.rate).toBeUndefined();
      expect(g.weeklyHours).toBeUndefined();
      expect(g.remote).toBeUndefined();
      expect(g.postedAt).toBeUndefined();
    }
  });

  it("filters out a card with no extractable title rather than producing a blank-titled Gig", async () => {
    const page = createFakePage({ evaluateResult: [...REAL_CARD_LISTINGS, { href: "999-no-title-card", title: "" }] });
    stubWithBrowserSession(page);

    const gigs = await wellfoundSource.fetch(cfg, profile);

    expect(gigs).toHaveLength(2);
    expect(gigs.some((g) => g.externalId === "999-no-title-card")).toBe(false);
  });

  it("calls withBrowserSession once, against the real /jobs board, scoped to wellfound.com ONLY — never Google/Clerk SSO or any other origin", async () => {
    const page = createFakePage();
    const getOptions = stubWithBrowserSession(page);

    await wellfoundSource.fetch(cfg, profile);

    expect(withBrowserSessionMock).toHaveBeenCalledTimes(1);
    const options = getOptions();
    expect(options?.url).toBe("https://wellfound.com/jobs");
    expect(options?.sourceId).toBe("wellfound");
    expect(options?.allowedOrigins).toEqual(["wellfound.com"]);
    expect(options?.allowedOrigins).not.toContain("accounts.google.com");
    expect(options?.allowedOrigins.join(",")).not.toMatch(/google|clerk/i);
  });

  it("registers its own dedicated session settings — SOURCE_ORIGINS/SOURCE_LOGIN_URLS never point wellfound at gofractional's or ateam's entries", () => {
    expect(SOURCE_ORIGINS["wellfound"]).toEqual(["wellfound.com"]);
    expect(SOURCE_LOGIN_URLS["wellfound"]).toBe("https://wellfound.com/login");
    expect(SOURCE_LOGIN_URLS["wellfound"]).not.toBe(SOURCE_LOGIN_URLS["gofractional"]);
    expect(SOURCE_LOGIN_URLS["wellfound"]).not.toBe(SOURCE_LOGIN_URLS["ateam"]);
  });

  describe("isAuthenticated predicate (Wellfound's REAL, live-observed login-page shape)", () => {
    it("returns false when the page matches Wellfound's real login page (title 'Log In | Wellfound', body containing 'Continue with Google')", async () => {
      const page = createFakePage({
        title: "Log In | Wellfound",
        bodyText: "Log in to Wellfound\nContinue with Google\nEmail address\nPassword\nLog in",
      });
      const getOptions = stubWithBrowserSession(page);
      await wellfoundSource.fetch(cfg, profile);

      const isAuthenticated = getOptions()!.isAuthenticated;
      await expect(isAuthenticated(page)).resolves.toBe(false);
    });

    it("returns true when the page title is not exactly 'Log In | Wellfound' (the tight match never false-positives on unrelated content)", async () => {
      const page = createFakePage({ title: "Startup Jobs & AI Recruiting Platform | Wellfound", bodyText: "some other page content" });
      const getOptions = stubWithBrowserSession(page);
      await wellfoundSource.fetch(cfg, profile);

      const isAuthenticated = getOptions()!.isAuthenticated;
      await expect(isAuthenticated(page)).resolves.toBe(true);
    });

    it("returns true when the title matches but the body lacks the real 'Continue with Google' button text (guards against a loose title-only match)", async () => {
      const page = createFakePage({ title: "Log In | Wellfound", bodyText: "Email address\nPassword\nLog in" });
      const getOptions = stubWithBrowserSession(page);
      await wellfoundSource.fetch(cfg, profile);

      const isAuthenticated = getOptions()!.isAuthenticated;
      await expect(isAuthenticated(page)).resolves.toBe(true);
    });
  });

  it("throws (never returns []) when zero listings are scraped despite auth succeeding", async () => {
    const page = createFakePage({ evaluateResult: [] });
    stubWithBrowserSession(page);

    await expect(wellfoundSource.fetch(cfg, profile)).rejects.toThrow(/found 0 job listings at https:\/\/wellfound\.com\/jobs/);
  });

  describe("missing-session error paths (same class of error as gofractional.ts/ateam.ts)", () => {
    it("throws a specific, actionable error (before ever invoking withBrowserSession) when settings.sessionStatePath is missing", async () => {
      const badCfg: SourceConfig = { id: "wellfound", enabled: true };

      await expect(wellfoundSource.fetch(badCfg, profile)).rejects.toThrow(/sessionStatePath/);
      expect(withBrowserSessionMock).not.toHaveBeenCalled();
    });

    it("propagates (never swallows) the 'no storageState file found' error withBrowserSession throws when no Capture Login has been done yet for wellfound", async () => {
      withBrowserSessionMock.mockRejectedValue(
        new Error(
          'gigradar browser-session: no storageState file found at "/fake/wellfound-session.json". Generate one by logging in once with a headed Playwright browser and saving its storage state (see docs/ARCHITECTURE.md\'s auth section for the exact steps), then reference that path from this source\'s settings.',
        ),
      );

      await expect(wellfoundSource.fetch(cfg, profile)).rejects.toThrow(/no storageState file found at "\/fake\/wellfound-session\.json"/);
    });
  });

  it("is registered with auth: browser-session", () => {
    expect(wellfoundSource.id).toBe("wellfound");
    expect(wellfoundSource.label).toBe("Wellfound");
    expect(wellfoundSource.auth).toBe("browser-session");
  });
});
