import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../types.js";
import { fractionalJobsSource } from "../fractionaljobs.js";
import { closeDb, getGig, recordScan } from "../../store/index.js";

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

    // fractionus-fractionaljobs-detail-enrichment-and-closed-detection
    // story: this fixture's own "job-item_more-info" fields already carried
    // real weekly-hours (and, sometimes, rate) text all along — this
    // adapter's own prior comment had spotted them but chose not to parse
    // them. Real, live-observed shapes, several deliberately left unparsed:
    expect(remoteOnly?.weeklyHours).toBe(10); // "10 hrs" (single value, no dash)
    expect(remoteOnly?.rate).toBeUndefined(); // no rate text at all on this card
    expect(plainRemote).toMatchObject({ weeklyHours: 25 }); // "15 - 25 hrs" -> upper bound
    // "£93.75 - £125 / hr" -- a real, non-USD currency -- left unparsed
    // rather than misread as dollars.
    expect(hybrid).toMatchObject({ weeklyHours: 3, rate: undefined });
    expect(onsite).toMatchObject({ weeklyHours: 20 });
    // "$4K - $6K / mo" -- the one unambiguous monthly shape this adapter
    // parses (both numbers carry "K").
    expect(augFirst).toMatchObject({ weeklyHours: 10, rate: { min: 4000, max: 6000, unit: "month" } });
    // "$10K - $15K / mo OTE" -- a real trailing "OTE" qualifier -- left
    // unparsed rather than silently dropping the qualifier and guessing.
    expect(julDate).toMatchObject({ weeklyHours: 15, rate: undefined });
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

// fractionus-fractionaljobs-detail-enrichment-and-closed-detection story
// (crawler-fidelity-and-app-usability epic): unlike fractionus.ts, this
// board's compact list card has NO free closed-detection signal (the "This
// Role is Closed" banner only exists on the bigger DETAIL page template) —
// so a bounded, lazy per-listing detail-page fetch is this source's real
// mechanism for it, tested here against real, live-fetched (and one
// structurally-derived, honestly labeled) detail-page fixtures. Same
// isolated-temp-DB convention as fractionus.test.ts's own describe block
// below (this adapter also calls the store's bare `listGigs()`).
function jobsHomepageHtml(cardsHtml: string): string {
  return `<html><body><div id="live-jobs"><div class="w-dyn-list"><div fs-cmsfilter-element="list" role="list" class="jobs-collection-list v2 w-dyn-items">${cardsHtml}</div></div></div></body></html>`;
}

/** A minimal, real-shaped fractionaljobs list card — every field this adapter's regexes require, nothing more. Omitting `moreInfoFields` leaves location/hours/rate all unset, isolating the detail-page fetch's own contribution in tests that need it. */
function fractionalJobsCard(opts: { slug: string; company: string; title: string; moreInfoFields?: string[] }): string {
  const moreInfoHtml = (opts.moreInfoFields ?? []).map((f) => `<div class="text-inline">${f}</div>`).join("");
  return `<div role="listitem" class="job-item w-dyn-item"><div class="job-item_content"><div class="job-item_job-info"><div class="job-item_name_url"><div class="text-size-regular text-inline"><h3 class="text-size-regular text-inline">${opts.company}</h3><h3 class="text-size-regular text-inline"> - </h3><h3 class="text-size-regular text-inline">${opts.title}</h3><h3 class="text-size-regular text-inline"> </h3></div><a href="/jobs/${opts.slug}" target="_blank" class="job-item_link-to-job w-inline-block"></a></div><div class="job-item_more-info">${moreInfoHtml}<div class="hide"><div class="date">August 10, 2026</div><div class="job-id">${opts.slug}</div></div></div></div></div></div>`;
}

function htmlResponse2(body: string, ok = true, status = 200): Response {
  return { ok, status, statusText: ok ? "OK" : "Error", text: async () => body } as unknown as Response;
}

describe("fractionalJobsSource: detail-page fetch + closed-detection", () => {
  const cfg2: SourceConfig = { id: "fractionaljobs", enabled: true };
  const profile2 = { name: "t", roles: [], skills: [], timezone: "UTC" };
  const originalFetch = global.fetch;
  let tmpDir: string;

  beforeEach(() => {
    vi.useRealTimers();
    closeDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-fractionaljobs-detail-test-"));
    vi.stubEnv("GIGRADAR_DB_PATH", path.join(tmpDir, "gigs.db"));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    closeDb();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("excludes a listing whose DETAIL page shows the real, confirmed Closed signal, and the existing archival sweep then correctly archives it", async () => {
    const closedDetailHtml = fs.readFileSync(path.join(fixturesDir, "fractionaljobs-job-detail-closed.html"), "utf8");
    const listHtml = jobsHomepageHtml(
      fractionalJobsCard({ slug: "cfo-advisor-at-a-saas-for-accounting-firms", company: "A SaaS For Accounting Firms", title: "CFO Advisor" }) +
        fractionalJobsCard({ slug: "unrelated-open-role-at-other-co", company: "Other Co", title: "Unrelated Open Role" }),
    );
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === "https://www.fractionaljobs.io/") return htmlResponse2(listHtml);
      if (u === "https://www.fractionaljobs.io/jobs/cfo-advisor-at-a-saas-for-accounting-firms") return htmlResponse2(closedDetailHtml);
      throw new Error(`unexpected fetch: ${u}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    recordScan([
      {
        sourceId: "fractionaljobs",
        gigs: [
          {
            sourceId: "fractionaljobs",
            externalId: "cfo-advisor-at-a-saas-for-accounting-firms",
            title: "CFO Advisor",
            url: "https://www.fractionaljobs.io/jobs/cfo-advisor-at-a-saas-for-accounting-firms",
            tier: "green",
          },
        ],
      },
    ]);

    const gigs = await fractionalJobsSource.fetch(cfg2, profile2);
    expect(gigs.find((g) => g.externalId === "cfo-advisor-at-a-saas-for-accounting-firms")).toBeUndefined();

    recordScan([{ sourceId: "fractionaljobs", gigs }]);
    const stored = getGig("fractionaljobs:cfo-advisor-at-a-saas-for-accounting-firms");
    expect(stored).toMatchObject({ status: "archived", outcomeReason: "expired_unapplied" });
    expect(stored?.unavailableSince).not.toBeNull();
  });

  it("populates rate+hours from a real, still-open DETAIL page for a green-tiered listing (first differently-shaped example: a real, parseable rate)", async () => {
    const openDetailHtml = fs.readFileSync(path.join(fixturesDir, "fractionaljobs-job-detail-open.html"), "utf8");
    const listHtml = jobsHomepageHtml(
      fractionalJobsCard({ slug: "cfo-advisor-at-a-saas-for-accounting-firms", company: "A SaaS For Accounting Firms", title: "CFO Advisor" }),
    );
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === "https://www.fractionaljobs.io/") return htmlResponse2(listHtml);
      if (u === "https://www.fractionaljobs.io/jobs/cfo-advisor-at-a-saas-for-accounting-firms") return htmlResponse2(openDetailHtml);
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    recordScan([
      {
        sourceId: "fractionaljobs",
        gigs: [
          {
            sourceId: "fractionaljobs",
            externalId: "cfo-advisor-at-a-saas-for-accounting-firms",
            title: "CFO Advisor",
            url: "https://www.fractionaljobs.io/jobs/cfo-advisor-at-a-saas-for-accounting-firms",
            tier: "green",
          },
        ],
      },
    ]);

    const gigs = await fractionalJobsSource.fetch(cfg2, profile2);
    expect(gigs[0]).toMatchObject({ rate: { min: 200, max: 250, unit: "hour" }, weeklyHours: 2 });
  });

  it("populates ONLY hours (never guessing a rate from a literal 'Unknown') from a real, still-open DETAIL page (second differently-shaped example, proving this generalizes beyond one card shape)", async () => {
    const openNoRateDetailHtml = fs.readFileSync(path.join(fixturesDir, "fractionaljobs-job-detail-open-no-rate.html"), "utf8");
    const listHtml = jobsHomepageHtml(
      fractionalJobsCard({ slug: "chief-technology-officer-at-elevaid", company: "Elevaid", title: "Chief Technology Officer" }),
    );
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === "https://www.fractionaljobs.io/") return htmlResponse2(listHtml);
      if (u === "https://www.fractionaljobs.io/jobs/chief-technology-officer-at-elevaid") return htmlResponse2(openNoRateDetailHtml);
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    recordScan([
      {
        sourceId: "fractionaljobs",
        gigs: [
          {
            sourceId: "fractionaljobs",
            externalId: "chief-technology-officer-at-elevaid",
            title: "Chief Technology Officer",
            url: "https://www.fractionaljobs.io/jobs/chief-technology-officer-at-elevaid",
            tier: "yellow",
          },
        ],
      },
    ]);

    const gigs = await fractionalJobsSource.fetch(cfg2, profile2);
    expect(gigs[0]).toMatchObject({ weeklyHours: 20, rate: undefined });
  });

  it("never fetches a detail page for a listing that hasn't cleared tiering yet — bounded/lazy, not automatic", async () => {
    const listHtml = jobsHomepageHtml(
      fractionalJobsCard({ slug: "cfo-advisor-at-a-saas-for-accounting-firms", company: "A SaaS For Accounting Firms", title: "CFO Advisor" }),
    );
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === "https://www.fractionaljobs.io/") return htmlResponse2(listHtml);
      throw new Error(`unexpected fetch (should never fire for an untiered gig): ${String(url)}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const gigs = await fractionalJobsSource.fetch(cfg2, profile2);
    expect(gigs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps the bounded detail-page fetch at MAX_DETAIL_FETCHES_PER_SCAN even when many listings are eligible", async () => {
    const slugs = Array.from({ length: 20 }, (_, i) => `some-role-${i}-at-acme`);
    const listHtml = jobsHomepageHtml(slugs.map((slug) => fractionalJobsCard({ slug, company: "Acme", title: "Some Role" })).join(""));
    const detailFetchedUrls = new Set<string>();
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === "https://www.fractionaljobs.io/") return htmlResponse2(listHtml);
      detailFetchedUrls.add(u);
      return htmlResponse2(fs.readFileSync(path.join(fixturesDir, "fractionaljobs-job-detail-open.html"), "utf8"));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    recordScan([
      {
        sourceId: "fractionaljobs",
        gigs: slugs.map((slug) => ({
          sourceId: "fractionaljobs",
          externalId: slug,
          title: "Some Role",
          url: `https://www.fractionaljobs.io/jobs/${slug}`,
          tier: "green",
        })),
      },
    ]);

    await fractionalJobsSource.fetch(cfg2, profile2);
    expect(detailFetchedUrls.size).toBe(15);
    expect(fetchMock).toHaveBeenCalledTimes(1 + 15);
  });
});
