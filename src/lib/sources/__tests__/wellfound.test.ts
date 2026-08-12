// Tests for src/lib/sources/wellfound.ts. `withBrowserSession` itself
// (origin-scoping, headed-only launch, centralized cleanup, auth-failure
// throw) is already fully covered by
// src/lib/auth/__tests__/browser-session.test.ts — this file mocks that
// module entirely (no real/simulated Chromium launch anywhere here, so zero
// live browser launches happen in `npm test`) and focuses on what's
// specific to THIS adapter, mirroring gofractional.test.ts's/ateam.test.ts's
// structure:
//   1. the real, scoped-to-wellfound.com-only origin allowlist this adapter
//      actually passes into withBrowserSession() — never Google/Clerk SSO
//      or any other origin;
//   2. the recursive __NEXT_DATA__ title/slug walk (findListings(), tested
//      indirectly via fetch()) against a fixture, including dedup across
//      the two role pages and both company-name extraction conventions;
//   3. the page-shape-failure path — no __NEXT_DATA__ tag present at all
//      (and its empty/invalid-JSON variants) — throws a specific,
//      actionable error naming the source, never a silent [];
//   4. the missing-session-file error path (settings.sessionStatePath
//      missing entirely, AND withBrowserSession's own "no storageState file
//      found" class of error propagated, never swallowed) — matching
//      gofractional.ts's/ateam.ts's existing test patterns exactly, per
//      this story's explicit acceptance criterion.
//
// *** FIXTURE IS SYNTHETIC, NOT LIVE-CAPTURED. ***  Unlike
// gofractional-jobs-cards.json (captured live from a real, valid session),
// this story's two target role-board URLs
// (wellfound.com/role/l/chief-technology-officer,
// wellfound.com/role/l/vp-of-engineering) were confirmed LIVE, with zero
// session/cookies involved, to both return a genuine HTTP 404 today — see
// wellfound.ts's own file-level comment for the full live-verification
// finding (re-checked against 8 different /role/l/<slug> paths, all 404;
// the whole URL scheme appears to have been retired since the legacy tool
// this story ports from was built). No real job-listing __NEXT_DATA__
// payload could therefore be captured this story. `fixtures/wellfound-next-
// data.json` is a best-effort synthetic approximation — a plausible
// Next.js state-tree shape with title/slug-keyed listing objects nested at
// different depths, exercising the recursive walk, dedup, and both
// company-extraction conventions findListings()/extractCompanyName()
// implement — NOT recorded from a real Wellfound page. The ONE exception is
// the login-page fixture data used in the "isAuthenticated predicate"
// describe block below, and the __NEXT_DATA__ SCRIPT TAG MECHANISM itself
// (id="__NEXT_DATA__", type="application/json") — both ARE real, confirmed,
// live-observed data, not synthetic. A future maintainer with a valid
// session and the current correct board URL MUST re-verify the real
// listing shape and refresh this fixture before trusting production
// output.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../types.js";

const withBrowserSessionMock = vi.fn();
vi.mock("../../auth/browser-session.js", () => ({
  withBrowserSession: (...args: unknown[]) => withBrowserSessionMock(...args),
}));

// Imported AFTER the mock is registered (vi.mock is hoisted by vitest).
import { wellfoundSource } from "../wellfound.js";
import { SOURCE_LOGIN_URLS, SOURCE_ORIGINS } from "../origins.js";

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const NEXT_DATA_TEXT = fs.readFileSync(path.join(fixturesDir, "wellfound-next-data.json"), "utf8");

interface WithBrowserSessionOptions {
  sourceId: string;
  storageStatePathSetting: string;
  allowedOrigins: string[];
  url: string;
  isAuthenticated: (page: unknown) => Promise<boolean>;
}

/**
 * A fake Page: `.title()`/`.textContent()` (used by isSignInPage()) are
 * canned; `.$eval()` (used by extractNextData()) either resolves the given
 * raw script-tag text or rejects, simulating Playwright's real behavior
 * when the selector matches zero elements (no `__NEXT_DATA__` tag present).
 */
function createFakePage(
  opts: { title?: string; bodyText?: string; nextDataText?: string | null; evalRejects?: boolean } = {},
) {
  const nextDataText = opts.nextDataText === undefined ? NEXT_DATA_TEXT : opts.nextDataText;
  return {
    title: vi.fn().mockResolvedValue(opts.title ?? "Startup Jobs & AI Recruiting Platform | Wellfound"),
    textContent: vi.fn().mockResolvedValue(opts.bodyText ?? ""),
    $eval: vi.fn(async (_selector: string, fn: (el: { textContent: string | null }) => unknown) => {
      if (opts.evalRejects) throw new Error("failed to find element matching selector \"script#__NEXT_DATA__\"");
      return fn({ textContent: nextDataText });
    }),
  };
}

/** Wires the mocked withBrowserSession to invoke the adapter's `run` callback against `page` for EVERY call (both role-URL fetches), capturing every options object it was called with. */
function stubWithBrowserSession(page: ReturnType<typeof createFakePage>) {
  const capturedOptions: WithBrowserSessionOptions[] = [];
  withBrowserSessionMock.mockImplementation(async (options: WithBrowserSessionOptions, run: (p: unknown) => Promise<unknown>) => {
    capturedOptions.push(options);
    return run(page);
  });
  return capturedOptions;
}

const cfg: SourceConfig = { id: "wellfound", enabled: true, settings: { sessionStatePath: "/fake/wellfound-session.json" } };
const profile = { name: "t", roles: [], skills: [], timezone: "UTC" };

describe("wellfoundSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    withBrowserSessionMock.mockReset();
  });

  it("normalizes the __NEXT_DATA__ tree into Gig[] with real per-listing urls, deduped by slug across both role pages", async () => {
    const page = createFakePage();
    stubWithBrowserSession(page);

    const gigs = await wellfoundSource.fetch(cfg, profile);

    // 3 unique listings across the fixture's apolloState + searchResults
    // trees (fractional-cto-acme-labs-123 appears twice, deduped) — fetched
    // once per role URL (2 calls), so 6 raw finds collapse to 3 unique.
    expect(gigs).toHaveLength(3);

    const cto = gigs.find((g) => g.externalId === "fractional-cto-acme-labs-123");
    expect(cto).toBeDefined();
    expect(cto).toMatchObject({
      sourceId: "wellfound",
      externalId: "fractional-cto-acme-labs-123",
      title: "Fractional Chief Technology Officer",
      company: "Acme Labs", // via the flat `companyName` key
      url: "https://wellfound.com/jobs/fractional-cto-acme-labs-123", // no explicit url field -> constructed
    });

    const vpEng = gigs.find((g) => g.externalId === "vp-of-engineering-northwind-124");
    expect(vpEng).toMatchObject({
      title: "VP of Engineering",
      company: "Northwind Robotics", // via the nested `company.name` key
      url: "https://wellfound.com/jobs/vp-of-engineering-northwind-124",
    });

    const interim = gigs.find((g) => g.externalId === "interim-cto-meridian-pay-987");
    expect(interim).toMatchObject({
      title: "Interim CTO — Seed Stage Fintech",
      company: "Meridian Pay",
      url: "https://wellfound.com/jobs/interim-cto-meridian-pay-987", // explicit relative url field, resolved absolute
    });

    // Real per-listing urls, never a search/role-board page.
    for (const g of gigs) {
      expect(g.url).toMatch(/^https:\/\/wellfound\.com\/jobs\//);
      expect(g.url).not.toContain("/role/l/");
    }
  });

  it("ignores objects that carry only a title or only a slug, never a false-positive match on a partial shape", async () => {
    const page = createFakePage();
    stubWithBrowserSession(page);

    const gigs = await wellfoundSource.fetch(cfg, profile);

    expect(gigs.find((g) => g.title === "Not A Real Listing")).toBeUndefined();
    expect(gigs.some((g) => g.externalId === "not-a-real-listing-either")).toBe(false);
    // The decoy Company object (name+slug, no `title` key) never matches either.
    expect(gigs.some((g) => g.externalId === "acme-labs")).toBe(false);
  });

  it("never fabricates rate/weeklyHours/remote/postedAt — the real listing shape was never live-observed, so all stay unset rather than guessed", async () => {
    const page = createFakePage();
    stubWithBrowserSession(page);

    const gigs = await wellfoundSource.fetch(cfg, profile);

    for (const g of gigs) {
      expect(g.rate).toBeUndefined();
      expect(g.weeklyHours).toBeUndefined();
      expect(g.remote).toBeUndefined();
      expect(g.postedAt).toBeUndefined();
    }
  });

  it("calls withBrowserSession once per role-board URL, each scoped to wellfound.com ONLY — never Google/Clerk SSO or any other origin", async () => {
    const page = createFakePage();
    const getOptions = stubWithBrowserSession(page);

    await wellfoundSource.fetch(cfg, profile);

    expect(getOptions).toHaveLength(2);
    const urls = getOptions.map((o) => o.url);
    expect(urls).toEqual(["https://wellfound.com/role/l/chief-technology-officer", "https://wellfound.com/role/l/vp-of-engineering"]);

    for (const options of getOptions) {
      expect(options.sourceId).toBe("wellfound");
      expect(options.allowedOrigins).toEqual(["wellfound.com"]);
      expect(options.allowedOrigins).not.toContain("accounts.google.com");
      expect(options.allowedOrigins.join(",")).not.toMatch(/google|clerk/i);
    }
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

      const isAuthenticated = getOptions[0]!.isAuthenticated;
      await expect(isAuthenticated(page)).resolves.toBe(false);
    });

    it("returns true when the page title is not exactly 'Log In | Wellfound' (the tight match never false-positives on unrelated content)", async () => {
      const page = createFakePage({ title: "Startup Jobs & AI Recruiting Platform | Wellfound", bodyText: "some other page content" });
      const getOptions = stubWithBrowserSession(page);
      await wellfoundSource.fetch(cfg, profile);

      const isAuthenticated = getOptions[0]!.isAuthenticated;
      await expect(isAuthenticated(page)).resolves.toBe(true);
    });

    it("returns true when the title matches but the body lacks the real 'Continue with Google' button text (guards against a loose title-only match)", async () => {
      const page = createFakePage({ title: "Log In | Wellfound", bodyText: "Email address\nPassword\nLog in" });
      const getOptions = stubWithBrowserSession(page);
      await wellfoundSource.fetch(cfg, profile);

      const isAuthenticated = getOptions[0]!.isAuthenticated;
      await expect(isAuthenticated(page)).resolves.toBe(true);
    });
  });

  describe("page-shape failures (no silent []) ", () => {
    it("throws a specific, actionable error naming the source when no __NEXT_DATA__ script tag is present at all", async () => {
      const page = createFakePage({ evalRejects: true });
      stubWithBrowserSession(page);

      await expect(wellfoundSource.fetch(cfg, profile)).rejects.toThrow(/wellfound: no __NEXT_DATA__ script tag found/);
    });

    it("throws when the __NEXT_DATA__ tag is present but empty", async () => {
      const page = createFakePage({ nextDataText: "" });
      stubWithBrowserSession(page);

      await expect(wellfoundSource.fetch(cfg, profile)).rejects.toThrow(/wellfound.*__NEXT_DATA__.*empty/);
    });

    it("throws when the __NEXT_DATA__ tag content is not valid JSON", async () => {
      const page = createFakePage({ nextDataText: "{not valid json" });
      stubWithBrowserSession(page);

      await expect(wellfoundSource.fetch(cfg, profile)).rejects.toThrow(/wellfound.*__NEXT_DATA__.*not valid JSON/);
    });

    it("throws (never returns []) when zero listings are found across both role pages despite the __NEXT_DATA__ tag parsing fine", async () => {
      const page = createFakePage({ nextDataText: JSON.stringify({ props: { pageProps: { nothingHere: true } } }) });
      stubWithBrowserSession(page);

      await expect(wellfoundSource.fetch(cfg, profile)).rejects.toThrow(/found 0 listings across 2 role page\(s\)/);
    });
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
