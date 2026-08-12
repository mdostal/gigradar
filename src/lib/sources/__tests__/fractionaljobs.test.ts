import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../types.js";
import { fractionalJobsSource } from "../fractionaljobs.js";

// A recorded, sanitized fixture of real fractionaljobs.io homepage
// (`https://www.fractionaljobs.io/`) responses, captured live while
// building this adapter (`.pHive/epics/adapter-batch-public-boards/docs/research-brief.md`
// §2's curl run). Hand-assembled composite: 6 real job-item HTML fragments
// (verbatim markup and values — company, title, location/work-arrangement
// text, and posted date all real), pulled from a single live fetch of the
// homepage (63 real cards observed; these 6 were chosen to cover every
// branch this adapter parses: plain "Remote", "Remote (X only)", "Hybrid
// (X only)" (ambiguous -> remote left unknown), "Onsite (X only)", an
// HTML-entity company/title ("&amp;" -> "&"), and several different
// absolute dates). Each fragment is truncated right after its own
// `job-id`/date block to keep the fixture a reasonable size — safe because
// this adapter's parser is regex-based, not a DOM parser (same convention
// as builtin.test.ts's own fixture). Checked for PII before saving: generic
// public job-board listing text (company/title/location/date), nothing
// needed scrubbing. Zero network calls happen anywhere in this file.
const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const fixtureHtml = fs.readFileSync(path.join(fixturesDir, "fractionaljobs-live-jobs.html"), "utf8");

function htmlResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: async () => body,
  } as unknown as Response;
}

const cfg: SourceConfig = { id: "fractionaljobs", enabled: true };
const profile = { name: "t", roles: [], skills: [], timezone: "UTC" };

describe("fractionalJobsSource", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("normalizes real FractionalJobs listings into Gig[] with real per-listing urls", async () => {
    const fetchMock = vi.fn(async (_url: string | URL) => htmlResponse(fixtureHtml));
    global.fetch = fetchMock as unknown as typeof fetch;

    const gigs = await fractionalJobsSource.fetch(cfg, profile);

    expect(gigs).toHaveLength(6);
    // Fetched the site's own root url — the homepage IS the live jobs list,
    // there is no separate /jobs path for this board.
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://www.fractionaljobs.io/");

    const remoteOnly = gigs.find((g) => g.externalId === "insurance-advisor-at-abode-money");
    expect(remoteOnly).toMatchObject({
      sourceId: "fractionaljobs",
      externalId: "insurance-advisor-at-abode-money",
      title: "Insurance Advisor",
      company: "Abode Money",
      url: "https://www.fractionaljobs.io/jobs/insurance-advisor-at-abode-money",
      remote: true,
      postedAt: "2026-08-10",
    });
    // Never the root/search page — always the specific job's own permalink.
    expect(remoteOnly?.url).not.toBe("https://www.fractionaljobs.io/");

    // Plain "Remote " (trailing space, no qualifier) also -> remote: true.
    const plainRemote = gigs.find((g) => g.externalId === "growth-marketing-manager-at-allball");
    expect(plainRemote).toMatchObject({ company: "AllBall", remote: true });

    // "Hybrid (...)" is genuinely mixed/ambiguous -> left unknown, never
    // guessed true/false. Also exercises HTML-entity decoding in the title
    // ("&amp;" -> "&").
    const hybrid = gigs.find((g) => g.externalId === "commercial-finance-governance-director-at-reward-flight-finder");
    expect(hybrid).toMatchObject({
      company: "Reward Flight Finder",
      title: "Commercial Finance & Governance Director",
    });
    expect(hybrid?.remote).toBeUndefined();

    // "Onsite (...)" -> remote: false.
    const onsite = gigs.find((g) => g.externalId === "chief-marketing-officer-at-magic-plumbing");
    expect(onsite).toMatchObject({ company: "Magic Plumbing", remote: false, postedAt: "2026-08-10" });

    // Different absolute dates parse correctly (single-digit day, zero-padded).
    const augFirst = gigs.find((g) => g.externalId === "product-development-lead-at-a-pre-launch-skincare-brand");
    expect(augFirst?.postedAt).toBe("2026-08-01");
    const julDate = gigs.find((g) => g.externalId === "sales-lead-at-a-high-finance-ai-startup");
    expect(julDate?.postedAt).toBe("2026-07-13");

    // rate/weeklyHours are never fabricated on this board — always left
    // unknown, per this story's design_decisions.
    for (const g of gigs) {
      expect(g.rate).toBeUndefined();
      expect(g.weeklyHours).toBeUndefined();
    }
  });

  it("throws (never returns []) when the fetch fails outright", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND fractionaljobs.io");
    }) as unknown as typeof fetch;

    await expect(fractionalJobsSource.fetch(cfg, profile)).rejects.toThrow(/fractionaljobs/);
  });

  it("throws on a non-2xx HTTP response instead of silently returning zero", async () => {
    global.fetch = vi.fn(async () => htmlResponse("", false, 503)) as unknown as typeof fetch;

    await expect(fractionalJobsSource.fetch(cfg, profile)).rejects.toThrow(/HTTP 503/);
  });

  it("throws on an unexpected response shape (genuine page-shape failure) rather than returning []", async () => {
    global.fetch = vi.fn(async () => htmlResponse("<html><body>not the jobs page</body></html>")) as unknown as typeof fetch;

    await expect(fractionalJobsSource.fetch(cfg, profile)).rejects.toThrow(/unexpected response shape/);
  });

  it("returns [] (never throws) when the page loads fine but genuinely has zero current listings", async () => {
    // The real #live-jobs container is present (a valid, real page shape),
    // just with zero job-item cards inside it — a legitimately quiet day,
    // distinct from the page-shape-failure case above.
    const quietPageHtml =
      '<html><body><div id="live-jobs"><div class="w-dyn-list"><div fs-cmsfilter-element="list" role="list" class="jobs-collection-list v2 w-dyn-items"></div></div></div></body></html>';
    global.fetch = vi.fn(async () => htmlResponse(quietPageHtml)) as unknown as typeof fetch;

    const gigs = await fractionalJobsSource.fetch(cfg, profile);
    expect(gigs).toEqual([]);
  });

  it("throws when job cards are present but none of them parse (markup drift) — distinct from the zero-listings case above", async () => {
    const brokenHtml =
      '<html><body><div id="live-jobs"><div role="listitem" class="job-item w-dyn-item">totally different markup now</div></div></body></html>';
    global.fetch = vi.fn(async () => htmlResponse(brokenHtml)) as unknown as typeof fetch;

    await expect(fractionalJobsSource.fetch(cfg, profile)).rejects.toThrow(/could not parse/);
  });

  it("is registered with auth: none", () => {
    expect(fractionalJobsSource.id).toBe("fractionaljobs");
    expect(fractionalJobsSource.auth).toBe("none");
  });
});
