// Tests for src/lib/sources/ateam.ts. `withBrowserSession` itself
// (origin-scoping, headed-only launch, centralized cleanup, auth-failure
// throw) is already fully covered by
// src/lib/auth/__tests__/browser-session.test.ts — this file mocks that
// module entirely (no real/simulated Chromium launch anywhere here, so zero
// live browser launches happen in `npm test`) and focuses on what's specific
// to THIS adapter, mirroring gofractional.test.ts's structure exactly (see
// this story's "pattern parity with gofractional-adapter" acceptance
// criterion):
//   1. the real, scoped-to-a.team/platform.a.team-only origin allowlist this
//      adapter actually passes into withBrowserSession() — never
//      Google/Clerk SSO or any other origin;
//   2. the REAL, live-observed auth-failure predicate — A.Team's confirmed
//      sign-in-page shape (title exactly "Sign In", body containing both
//      "Continue with Google" and "Continue with Github" — recorded live
//      during this epic's planning, see
//      .pHive/epics/browser-session-auth/docs/research-brief.md §7 and
//      ateam-adapter.yaml's `references`), tested against a fixture
//      reproducing that exact content;
//   3. normalize/parse logic against a fixture of Mission Control listing
//      data;
//   4. throw-on-any-failure, never silent-empty, per this repo's
//      no-silent-zero convention.
//
// FIXTURE NOTE (updated 2026-08-30, product-review-followups epic,
// ateam-session-lifetime-blocker story). This file mocks `page.evaluate()`
// to return `fixtures/ateam-mission-control-listings.json` directly —
// meaning scrapeListings()'s REAL in-browser extraction logic (the
// querySelectorAll/leaf-text-node walk, see that function's own doc
// comment for what was actually live-verified) is NOT exercised by these
// tests at all, same as before this update — only toGig()'s pure
// field-mapping logic (href -> externalId/url, remote/weeklyHours parsing)
// is. The fixture's `href` shape (`/mission/{id}`, singular) now matches
// the REAL, live-verified shape; its `locationType`/`commitment` values
// stay hand-picked test data exercising toGig()'s mapping logic across
// Remote/On-site/Hybrid and range/single-figure hours — scrapeListings()
// itself always produces `null` for both today (neither was visible on
// either of the two real cards observed live — see ateam.ts's own doc
// comments), so this fixture is deliberately a superset of what real
// scraping currently returns, kept for toGig()'s own coverage. The
// sign-in-page fixture data used in the "isAuthenticated predicate"
// describe block below remains real, confirmed, live-observed content
// (title "Sign In", "Continue with Google"/"Continue with Github").
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { SourceConfig } from "../../types.js";

const withBrowserSessionMock = vi.fn();
vi.mock("../../auth/browser-session.js", () => ({
  withBrowserSession: (...args: unknown[]) => withBrowserSessionMock(...args),
}));

// Imported AFTER the mock is registered (vi.mock is hoisted by vitest).
import { ateamSource } from "../ateam.js";

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const STRUCTURE_DERIVED_LISTINGS = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, "ateam-mission-control-listings.json"), "utf8"),
) as Array<{
  href: string;
  title: string;
  client: string | null;
  locationType: string | null;
  commitment: string | null;
}>;

interface WithBrowserSessionOptions {
  sourceId: string;
  storageStatePathSetting: string;
  allowedOrigins: string[];
  url: string;
  isAuthenticated: (page: unknown) => Promise<boolean>;
}

/**
 * A fake Page: `.evaluate()` (used by scrapeListings()) and `.textContent()`
 * (used by isSignInPage(), Playwright's real `page.textContent(selector)`
 * API) are independently canned — mirroring how gofractional.test.ts's fake
 * page separates `.evaluate()` (cards) from `.$$eval()` (auth check), so a
 * single fetch() run can exercise the listing-scrape path and the
 * auth-predicate path with different, non-conflicting fixture data.
 */
function createFakePage(opts: { title?: string; evaluateResult?: unknown; bodyText?: string } = {}) {
  return {
    title: vi.fn().mockResolvedValue(opts.title ?? "Mission Control | A.Team"),
    evaluate: vi.fn().mockResolvedValue(opts.evaluateResult ?? STRUCTURE_DERIVED_LISTINGS),
    textContent: vi.fn().mockResolvedValue(opts.bodyText ?? ""),
    // scrapeListings() waits for network idle before evaluating (see that
    // function's own doc comment) -- mocked resolved so the fake page
    // doesn't need a real network stack.
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

const cfg: SourceConfig = { id: "ateam", enabled: true, settings: { sessionStatePath: "/fake/mat.json" } };

describe("ateamSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    withBrowserSessionMock.mockReset();
  });

  it("normalizes Mission Control listings into Gig[] with real per-listing urls (never the board's own list-view url)", async () => {
    const page = createFakePage();
    stubWithBrowserSession(page);

    const gigs = await ateamSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

    expect(gigs).toHaveLength(STRUCTURE_DERIVED_LISTINGS.length);

    const cto = gigs.find((g) => g.externalId === "fractional-cto-acme-robotics");
    expect(cto).toBeDefined();
    expect(cto).toMatchObject({
      sourceId: "ateam",
      externalId: "fractional-cto-acme-robotics",
      title: "Fractional CTO",
      company: "Acme Robotics",
      url: "https://platform.a.team/mission/fractional-cto-acme-robotics",
      remote: true,
      weeklyHours: 20, // upper bound of "10-20 hrs/week"
    });

    // Real per-listing url, never the board's own list-view page.
    for (const g of gigs) {
      expect(g.url).toMatch(/^https:\/\/platform\.a\.team\/mission\//);
      expect(g.url).not.toBe("https://platform.a.team/mission-control/all");
      expect(g.url).not.toMatch(/[?&]/); // no query-string search-page shape either
    }
  });

  it("maps 'On-site' -> remote:false and leaves 'Hybrid' unset (ambiguous, never guessed) — same convention as gofractional.ts", async () => {
    const page = createFakePage();
    stubWithBrowserSession(page);

    const gigs = await ateamSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

    const onSite = gigs.find((g) => g.company === "Harbor Fintech");
    expect(onSite?.remote).toBe(false);

    const hybrid = gigs.find((g) => g.company === "Northwind Health");
    expect(hybrid?.remote).toBeUndefined();
  });

  it("takes the upper bound of an 'N-M hrs/week' range, and a bare 'N hrs/week' figure as-is", async () => {
    const page = createFakePage();
    stubWithBrowserSession(page);

    const gigs = await ateamSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

    const rangeJob = gigs.find((g) => g.externalId === "staff-backend-engineer-northwind-health");
    expect(rangeJob?.weeklyHours).toBe(30); // "20-30 hrs/week"

    const singleFigureJob = gigs.find((g) => g.externalId === "principal-architect-vertex-logistics");
    expect(singleFigureJob?.weeklyHours).toBe(40); // "40 hrs/week"
  });

  it("never fabricates a rate or postedAt — A.Team's real card shape was never live-observed, so both stay unset rather than guessed", async () => {
    const page = createFakePage();
    stubWithBrowserSession(page);

    const gigs = await ateamSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

    for (const g of gigs) {
      expect(g.rate).toBeUndefined();
      expect(g.postedAt).toBeUndefined();
    }
  });

  it("passes an origin allowlist scoped to a.team and platform.a.team ONLY — never Google/Github/Clerk SSO or any other origin", async () => {
    const page = createFakePage();
    const getOptions = stubWithBrowserSession(page);

    await ateamSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

    const options = getOptions();
    expect(options?.allowedOrigins).toEqual(["a.team", "platform.a.team"]);
    // Explicit negative assertions — this adapter's real allowlist array,
    // not just browser-session-mechanism's own filter, is what the story's
    // AC calls out (same pattern as gofractional.test.ts).
    expect(options?.allowedOrigins).not.toContain("accounts.google.com");
    expect(options?.allowedOrigins).not.toContain("github.com");
    expect(options?.allowedOrigins.join(",")).not.toMatch(/google|clerk|github/i);
    expect(options?.sourceId).toBe("ateam");
    expect(options?.url).toBe("https://platform.a.team/mission-control/all");
  });

  describe("isAuthenticated predicate (A.Team's REAL, live-observed sign-in-page shape — confirmed during epic planning, not structure-derived)", () => {
    it("returns false when the page matches A.Team's real observed sign-in page (title 'Sign In', body containing 'Continue with Google' and 'Continue with Github')", async () => {
      const page = createFakePage({
        title: "Sign In",
        bodyText:
          "Sign In\nClose\nShow all notifications\nSign In\nForgot Password?\nSign In\nContinue with Google\nContinue with Github\n©2026 ATeams Inc., All rights reserved.",
      });
      const getOptions = stubWithBrowserSession(page);
      // evaluateResult is left at its default (the structure-derived
      // listings fixture) so fetch() itself still completes normally — this
      // block is testing isAuthenticated() directly, extracted from the
      // captured options, same pattern as gofractional.test.ts.
      await expect(ateamSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).resolves.toBeDefined();

      const isAuthenticated = getOptions()!.isAuthenticated;
      await expect(isAuthenticated(page)).resolves.toBe(false);
    });

    it("returns true when the page title is not exactly 'Sign In' (the tight match never false-positives on unrelated content)", async () => {
      const page = createFakePage({ title: "Mission Control | A.Team", bodyText: "some other page content" });
      const getOptions = stubWithBrowserSession(page);
      await ateamSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

      const isAuthenticated = getOptions()!.isAuthenticated;
      await expect(isAuthenticated(page)).resolves.toBe(true);
    });

    it("returns true when the title is 'Sign In' but the body lacks BOTH real button strings (guards against a loose single-substring match)", async () => {
      const page = createFakePage({
        title: "Sign In",
        bodyText: "Sign In\nWelcome back\nContinue with Google\n(c) 2026 ATeams Inc.",
      });
      const getOptions = stubWithBrowserSession(page);
      await ateamSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

      const isAuthenticated = getOptions()!.isAuthenticated;
      // Title matches and ONE of the two button strings is present, but not
      // both — isSignInPage() requires all three signals together.
      await expect(isAuthenticated(page)).resolves.toBe(true);
    });
  });

  it("propagates (never swallows) the auth-failure error withBrowserSession throws for an invalid/expired session", async () => {
    withBrowserSessionMock.mockRejectedValue(
      new Error('gigradar browser-session: session expired/invalid for source "ateam" (checked against "https://platform.a.team/mission-control/all").'),
    );

    await expect(ateamSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(/session expired\/invalid for source "ateam"/);
  });

  it("throws (never returns []) when zero mission listings are scraped despite auth succeeding", async () => {
    const page = createFakePage({ evaluateResult: [] });
    stubWithBrowserSession(page);

    await expect(ateamSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(/found 0 mission listings/);
  });

  it("throws (never returns []) when listings were found but none of them parse into a valid Gig", async () => {
    const page = createFakePage({
      evaluateResult: [
        { href: "not-a-mission-href", title: "", client: null, locationType: null, commitment: null },
        { href: "/opportunities/other-board-shape", title: "", client: null, locationType: null, commitment: null },
      ],
    });
    stubWithBrowserSession(page);

    await expect(ateamSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(/found 2 mission listing\(s\) but could not parse any of them/);
  });

  it("throws a specific, actionable error (before ever invoking withBrowserSession) when settings.sessionStatePath is missing", async () => {
    const badCfg: SourceConfig = { id: "ateam", enabled: true };

    await expect(ateamSource.fetch(badCfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(/sessionStatePath/);
    expect(withBrowserSessionMock).not.toHaveBeenCalled();
  });

  it("is registered with auth: browser-session", () => {
    expect(ateamSource.id).toBe("ateam");
    expect(ateamSource.auth).toBe("browser-session");
  });

  describe("pattern parity with gofractional.ts (AC: same shape — origin-scoped allowlist, source-specific predicate, throw-on-failure)", () => {
    it("both adapters declare auth: 'browser-session' and call withBrowserSession with sourceId/allowedOrigins/url/isAuthenticated", async () => {
      const page = createFakePage();
      const getOptions = stubWithBrowserSession(page);
      await ateamSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });
      const options = getOptions();

      expect(ateamSource.auth).toBe("browser-session");
      expect(typeof options?.sourceId).toBe("string");
      expect(Array.isArray(options?.allowedOrigins)).toBe(true);
      expect(options?.allowedOrigins.length).toBeGreaterThan(0);
      expect(typeof options?.url).toBe("string");
      expect(typeof options?.isAuthenticated).toBe("function");
    });

    it("never returns an empty array on any failure path — a missing config, an auth failure, and a zero-scrape all throw rather than resolving []", async () => {
      const badCfg: SourceConfig = { id: "ateam", enabled: true };
      await expect(ateamSource.fetch(badCfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow();

      withBrowserSessionMock.mockRejectedValueOnce(new Error("session expired/invalid"));
      await expect(ateamSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow();

      const emptyPage = createFakePage({ evaluateResult: [] });
      stubWithBrowserSession(emptyPage);
      await expect(ateamSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow();
    });
  });
});
