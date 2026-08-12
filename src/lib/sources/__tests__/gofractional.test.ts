// Tests for src/lib/sources/gofractional.ts. `withBrowserSession` itself
// (origin-scoping, headed-only launch, centralized cleanup, auth-failure
// throw) is already fully covered by src/lib/auth/__tests__/browser-session.test.ts
// — this file mocks that module entirely (no real/simulated Chromium launch
// anywhere here, so zero live browser launches happen in `npm test`) and
// focuses on what's specific to THIS adapter:
//   1. the real, scoped-to-gofractional.com-only origin allowlist this
//      adapter actually passes into withBrowserSession() (exercising the
//      story's "origin-scoping via this adapter's real allowlist" AC);
//   2. the real, live-observed auth-failure predicate (a "Dashboard" nav
//      link vs a "Log in" one — GoFractional's /jobs page renders
//      identically either way, no redirect, confirmed live);
//   3. normalize/parse logic against a recorded, PII-scrubbed fixture of
//      real card data (src/lib/sources/__tests__/fixtures/gofractional-jobs-cards.json,
//      captured live from the real https://www.gofractional.com/jobs page
//      via the hive's valid gf.json session while building this adapter) —
//      real company/job-title text, no personal names/emails anywhere in
//      the source data, nothing to scrub beyond that;
//   4. throw-on-any-failure, never silent-empty, per this repo's
//      no-silent-zero convention.
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
import { gofractionalSource } from "../gofractional.js";

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const REAL_CARDS = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, "gofractional-jobs-cards.json"), "utf8"),
) as Array<{
  href: string;
  title: string;
  company: string | null;
  posted: string | null;
  workType: string | null;
  hours: string | null;
}>;

interface WithBrowserSessionOptions {
  sourceId: string;
  storageStatePathSetting: string;
  allowedOrigins: string[];
  url: string;
  isAuthenticated: (page: unknown) => Promise<boolean>;
}

/** A fake Page: `.title()`/`.evaluate()` are canned; `.$$eval()` actually runs the real callback against fake DOM-like anchor objects, so isAuthenticatedGoFractional's real logic gets exercised. */
function createFakePage(opts: { title?: string; evaluateResult?: unknown; anchors?: Array<{ textContent: string }> } = {}) {
  const anchors = opts.anchors ?? [{ textContent: "Dashboard" }];
  return {
    title: vi.fn().mockResolvedValue(opts.title ?? "Fractional Jobs | Go Fractional"),
    evaluate: vi.fn().mockResolvedValue(opts.evaluateResult ?? REAL_CARDS),
    $$eval: vi.fn(async (_selector: string, fn: (els: unknown[]) => unknown) => fn(anchors)),
    // isAuthenticatedGoFractional polls via waitForTimeout (see its doc
    // comment: GoFractional's nav is client-hydrated, confirmed live) —
    // resolves instantly here so the "false" scenario's poll loop doesn't
    // actually sleep in tests; Date.now() is mocked separately in that test
    // to fast-forward past the poll deadline in a handful of iterations.
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
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

const cfg: SourceConfig = { id: "gofractional", enabled: true, settings: { sessionStatePath: "/fake/gf.json" } };

describe("gofractionalSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    withBrowserSessionMock.mockReset();
  });

  it("normalizes real GoFractional listing cards into Gig[] with real per-listing urls (never the /jobs search page)", async () => {
    const page = createFakePage();
    stubWithBrowserSession(page);

    const gigs = await gofractionalSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

    expect(gigs).toHaveLength(REAL_CARDS.length);

    const director = gigs.find((g) => g.externalId === "fractional-engineering-director-cmry9syx");
    expect(director).toBeDefined();
    expect(director).toMatchObject({
      sourceId: "gofractional",
      externalId: "fractional-engineering-director-cmry9syx",
      title: "Fractional Engineering Director",
      company: "Built Environment Marketplace Company",
      url: "https://www.gofractional.com/job/fractional-engineering-director-cmry9syx",
      remote: true,
      weeklyHours: 20, // upper bound of "5-20 hrs/week"
    });
    // Real per-listing url, never a search/listing page.
    for (const g of gigs) {
      expect(g.url).toMatch(/^https:\/\/www\.gofractional\.com\/job\//);
      expect(g.url).not.toBe("https://www.gofractional.com/jobs");
      expect(g.url).not.toMatch(/[?&]/); // no query-string search-page shape either
    }
  });

  it("maps 'On-site' -> remote:false and leaves 'Hybrid' unset (ambiguous, never guessed)", async () => {
    const page = createFakePage();
    stubWithBrowserSession(page);

    const gigs = await gofractionalSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

    const onSite = gigs.find((g) => g.company === "Crusoe");
    expect(onSite?.remote).toBe(false);

    const hybrid = gigs.find((g) => g.company === "NCC Group");
    expect(hybrid?.remote).toBeUndefined();
  });

  it("takes the upper bound of an 'N-M hrs/week' range, and a bare 'N hrs/week' figure as-is", async () => {
    const page = createFakePage();
    stubWithBrowserSession(page);

    const gigs = await gofractionalSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

    const rangeJob = gigs.find((g) => g.externalId === "fractional-senior-developer-cmsjcyc1");
    expect(rangeJob?.weeklyHours).toBe(30); // "15-30 hrs/week"

    const singleFigureJob = gigs.find((g) => g.externalId === "chief-technology-officer-cms90vxt");
    expect(singleFigureJob?.weeklyHours).toBe(40); // "40 hrs/week"
  });

  it("never fabricates a rate — GoFractional's list card exposes no $ figure, so every Gig.rate stays unset", async () => {
    const page = createFakePage();
    stubWithBrowserSession(page);

    const gigs = await gofractionalSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

    for (const g of gigs) expect(g.rate).toBeUndefined();
  });

  it("passes an origin allowlist scoped to gofractional.com ONLY — never Google/Clerk SSO or any other origin", async () => {
    const page = createFakePage();
    const getOptions = stubWithBrowserSession(page);

    await gofractionalSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

    const options = getOptions();
    expect(options?.allowedOrigins).toEqual(["gofractional.com"]);
    // Explicit negative assertions — this adapter's real allowlist array,
    // not just browser-session-mechanism's own filter, is what the story's
    // AC calls out.
    expect(options?.allowedOrigins).not.toContain("accounts.google.com");
    expect(options?.allowedOrigins.join(",")).not.toMatch(/google|clerk/i);
    expect(options?.sourceId).toBe("gofractional");
    expect(options?.url).toBe("https://www.gofractional.com/jobs");
  });

  describe("isAuthenticated predicate (real, live-observed GoFractional shape)", () => {
    it("returns true when the header nav includes a 'Dashboard' link (the real authenticated signal)", async () => {
      const page = createFakePage({ anchors: [{ textContent: "Hire" }, { textContent: "Dashboard" }, { textContent: "Hire Talent" }] });
      const getOptions = stubWithBrowserSession(page);
      await gofractionalSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

      const isAuthenticated = getOptions()!.isAuthenticated;
      await expect(isAuthenticated(page)).resolves.toBe(true);
    });

    it("returns false when the header nav shows 'Log in' instead of 'Dashboard' (the real unauthenticated signal — GoFractional's /jobs page renders with no redirect either way)", async () => {
      const page = createFakePage({ anchors: [{ textContent: "Hire" }, { textContent: "Log in" }, { textContent: "Hire Talent" }] });
      const getOptions = stubWithBrowserSession(page);
      await gofractionalSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

      // Fast-forward the poll loop's deadline without a real 5s sleep —
      // each Date.now() call jumps 2s ahead, so the bounded poll (see
      // isAuthenticatedGoFractional's doc comment) exhausts in a few
      // iterations instead of actually waiting.
      const nowSpy = vi.spyOn(Date, "now");
      let simulatedNow = 0;
      nowSpy.mockImplementation(() => {
        simulatedNow += 2000;
        return simulatedNow;
      });

      const isAuthenticated = getOptions()!.isAuthenticated;
      await expect(isAuthenticated(page)).resolves.toBe(false);

      nowSpy.mockRestore();
    });
  });

  it("propagates (never swallows) the auth-failure error withBrowserSession throws for an invalid/expired session", async () => {
    withBrowserSessionMock.mockRejectedValue(
      new Error('gigradar browser-session: session expired/invalid for source "gofractional" (checked against "https://www.gofractional.com/jobs").'),
    );

    await expect(gofractionalSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(
      /session expired\/invalid for source "gofractional"/,
    );
  });

  it("throws (never returns []) when the page-shape sanity check fails (unexpected title, independent of auth state)", async () => {
    const page = createFakePage({ title: "Just a moment... | Cloudflare" });
    stubWithBrowserSession(page);

    await expect(gofractionalSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(
      /unexpected page shape/,
    );
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("throws (never returns []) when zero job cards are scraped despite the page shape looking correct", async () => {
    const page = createFakePage({ evaluateResult: [] });
    stubWithBrowserSession(page);

    await expect(gofractionalSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(
      /found 0 job cards/,
    );
  });

  it("throws (never returns []) when cards were found but none of them parse into a valid Gig", async () => {
    const page = createFakePage({
      evaluateResult: [
        { href: "not-a-job-href", title: "", company: null, posted: null, workType: null, hours: null },
        { href: "/jobs/engineering", title: "", company: null, posted: null, workType: null, hours: null },
      ],
    });
    stubWithBrowserSession(page);

    await expect(gofractionalSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(
      /found 2 job card\(s\) but could not parse any of them/,
    );
  });

  it("throws a specific, actionable error (before ever invoking withBrowserSession) when settings.sessionStatePath is missing", async () => {
    const badCfg: SourceConfig = { id: "gofractional", enabled: true };

    await expect(gofractionalSource.fetch(badCfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(
      /sessionStatePath/,
    );
    expect(withBrowserSessionMock).not.toHaveBeenCalled();
  });

  it("is registered with auth: browser-session", () => {
    expect(gofractionalSource.id).toBe("gofractional");
    expect(gofractionalSource.auth).toBe("browser-session");
  });
});
