import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../types.js";
import { fractionusSource } from "../fractionus.js";
import { closeDb, getGig, recordScan } from "../../store/index.js";

// A recorded, sanitized fixture of real fractionus.com/jobs responses,
// captured live while building this adapter
// (`.pHive/epics/adapter-batch-public-boards/docs/research-brief.md` §2's
// curl run). Hand-assembled composite: 5 real job-list-item HTML fragments
// (verbatim markup and values — company, title, location/work-arrangement
// tags, ISO date, and description blurb all real), pulled from a single
// live fetch of `/jobs` (53 real cards observed; these 5 were chosen to
// cover every branch this adapter parses: "Remote"/"On-site"/"Hybrid"
// arrangement tags, an HTML-entity title ("&amp;" -> "&"), and the card's
// already-ISO `data-date` text). Each fragment is truncated right after its
// own closing `</a></div>` to keep the fixture a reasonable size — safe
// because this adapter's parser is regex-based, not a DOM parser (same
// convention as builtin.test.ts's own fixture). Checked for PII before
// saving: generic public job-board listing text, nothing needed scrubbing.
// Zero network calls happen anywhere in this file.
const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const fixtureHtml = fs.readFileSync(path.join(fixturesDir, "fractionus-jobs.html"), "utf8");

function htmlResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: async () => body,
  } as unknown as Response;
}

const cfg: SourceConfig = { id: "fractionus", enabled: true };
const profile = { name: "t", roles: [], skills: [], timezone: "UTC" };

describe("fractionusSource", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("normalizes real Fractionus listings into Gig[] with real per-listing urls", async () => {
    const fetchMock = vi.fn(async (_url: string | URL) => htmlResponse(fixtureHtml));
    global.fetch = fetchMock as unknown as typeof fetch;

    const gigs = await fractionusSource.fetch(cfg, profile);

    expect(gigs).toHaveLength(5);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://fractionus.com/jobs");

    // "Remote" arrangement -> remote: true. Also exercises HTML-entity
    // decoding in the title ("&amp;" -> "&") and an already-ISO date.
    const monzo = gigs.find((g) => g.externalId === "fractional-compliance-advisory-manager-at-monzo");
    expect(monzo).toMatchObject({
      sourceId: "fractionus",
      externalId: "fractional-compliance-advisory-manager-at-monzo",
      title: "Compliance Advisory Manager - Investments, Pensions & Financial Promotions",
      company: "Monzo",
      url: "https://fractionus.com/jobs/fractional-compliance-advisory-manager-at-monzo",
      remote: true,
      postedAt: "2026-08-08",
    });
    // Never the /jobs search page — always the specific job's own permalink.
    expect(monzo?.url).not.toBe("https://fractionus.com/jobs");
    expect(monzo?.description).toMatch(/second line of defence/);

    // "On-site" arrangement -> remote: false.
    const oscar = gigs.find((g) => g.externalId === "fractional-senior-director-network-contracting-at-oscar");
    expect(oscar).toMatchObject({ company: "Oscar", remote: false, postedAt: "2026-08-08" });

    // "Hybrid" arrangement is genuinely mixed -> left unknown, never guessed.
    const cedar = gigs.find((g) => g.externalId === "fractional-cfo-at-cedar");
    expect(cedar).toMatchObject({ company: "Cedar", title: "Interim Chief Financial Officer", postedAt: "2026-08-06" });
    expect(cedar?.remote).toBeUndefined();

    const stripe = gigs.find((g) => g.externalId === "fractional-payment-advisory-partnerships-lead-at-stripe");
    expect(stripe).toMatchObject({ company: "Stripe", remote: true });

    const estendio = gigs.find((g) => g.externalId === "fractional-cgo-at-estendio");
    expect(estendio).toMatchObject({ company: "Estendio", remote: true, postedAt: "2026-08-07" });

    // fractionus-fractionaljobs-detail-enrichment-and-closed-detection
    // story: real finding that overturned this adapter's own prior belief
    // that the list card never carries rate/hours/status — this same
    // fixture already had the real markup all along (see the fixture's own
    // "div-block-14 price"/"days"/"fracitonal" blocks), it just wasn't read
    // until this story. cedar/estendio have a real price+days block ($75-
    // $150/hr, 10-20 hrs/week); monzo/oscar/stripe have a "Fractional
    // Contract" block instead (no numeric hours, but a real employmentType
    // signal). All five are status "Active" (none excluded).
    expect(cedar).toMatchObject({ rate: { min: 75, max: 150, unit: "hour" }, weeklyHours: 20 });
    expect(estendio).toMatchObject({ rate: { min: 75, max: 150, unit: "hour" }, weeklyHours: 20 });
    expect(monzo).toMatchObject({ employmentType: "fractional" });
    expect(oscar).toMatchObject({ employmentType: "fractional" });
    expect(stripe).toMatchObject({ employmentType: "fractional" });
  });

  it("throws (never returns []) when the fetch fails outright", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND fractionus.com");
    }) as unknown as typeof fetch;

    await expect(fractionusSource.fetch(cfg, profile)).rejects.toThrow(/fractionus/);
  });

  it("throws on a non-2xx HTTP response instead of silently returning zero", async () => {
    global.fetch = vi.fn(async () => htmlResponse("", false, 503)) as unknown as typeof fetch;

    await expect(fractionusSource.fetch(cfg, profile)).rejects.toThrow(/HTTP 503/);
  });

  it("throws on an unexpected response shape (genuine page-shape failure) rather than returning []", async () => {
    global.fetch = vi.fn(async () => htmlResponse("<html><body>not the jobs page</body></html>")) as unknown as typeof fetch;

    await expect(fractionusSource.fetch(cfg, profile)).rejects.toThrow(/unexpected response shape/);
  });

  it("returns [] (never throws) when the page loads fine but genuinely has zero current listings", async () => {
    // The real jobs-page heading is present (a valid, real page shape),
    // just with zero job-list-item cards — a legitimately quiet day,
    // distinct from the page-shape-failure case above.
    const quietPageHtml =
      '<html><body><h2 class="heading-style-h2-6 jobs">Explore &amp; Find Fractional Jobs</h2><div class="w-dyn-list"><div role="list" class="w-dyn-items"></div></div></body></html>';
    global.fetch = vi.fn(async () => htmlResponse(quietPageHtml)) as unknown as typeof fetch;

    const gigs = await fractionusSource.fetch(cfg, profile);
    expect(gigs).toEqual([]);
  });

  it("throws when job cards are present but none of them parse (markup drift) — distinct from the zero-listings case above", async () => {
    const brokenHtml =
      '<html><body><h2 class="heading-style-h2-6 jobs">Explore &amp; Find Fractional Jobs</h2><div role="listitem" class="job-list-item w-dyn-item">totally different markup now</div></body></html>';
    global.fetch = vi.fn(async () => htmlResponse(brokenHtml)) as unknown as typeof fetch;

    await expect(fractionusSource.fetch(cfg, profile)).rejects.toThrow(/could not parse/);
  });

  it("is registered with auth: none", () => {
    expect(fractionusSource.id).toBe("fractionus");
    expect(fractionusSource.auth).toBe("none");
  });
});

// fractionus-fractionaljobs-detail-enrichment-and-closed-detection story
// (crawler-fidelity-and-app-usability epic): closed-detection and the
// bounded/lazy detail-page fallback both need real store state (a gig's
// PRIOR tier/status) to test — its own isolated temp DB, same
// `vi.stubEnv("GIGRADAR_DB_PATH", ...)` + `closeDb()` convention as
// scheduler/__tests__/index.test.ts's own "runCycle raises an issue per
// source error" describe block, since `fractionus.ts` itself calls the
// store's bare `listGigs()` (no injectable `db` option — `Source.fetch()`'s
// own fixed signature has no room for one).
function jobsPageHtml(cardsHtml: string): string {
  return `<html><body><h2 class="heading-style-h2-6 jobs">Explore &amp; Find Fractional Jobs</h2><div class="w-dyn-list"><div role="list" class="w-dyn-items">${cardsHtml}</div></div></body></html>`;
}

/** A minimal, real-shaped fractionus list card — every field this adapter's regexes require, nothing more. */
function fractionusCard(opts: {
  slug: string;
  title: string;
  status?: string;
  price?: { min: number; max: number };
  days?: { min: number; max: number };
  fracitonal?: boolean;
}): string {
  const statusHtml =
    opts.status !== undefined
      ? `<div data-status-badge="true" class="w-layout-blockcontainer blog-post4-header_category-link-copy-c w-container"><div class="text-block-32 text-size-tiny">${opts.status}</div></div>`
      : "";
  const priceHtml = opts.price
    ? `<div class="div-block-14 price"><p class="paragraph">$</p><p class="paragraph">${opts.price.min}</p><p class="paragraph dash"> - </p><p class="paragraph">$</p><p class="paragraph-2">${opts.price.max}</p><p class="paragraph hour w-dyn-bind-empty"></p></div>`
    : "";
  const daysHtml = opts.days
    ? `<div class="div-block-14 days"><p class="paragraph">${opts.days.min}</p><p class="paragraph dash"> - </p><p class="paragraph-2">${opts.days.max}</p><p class="paragraph week w-dyn-bind-empty"></p><p class="paragraph week"> hrs/week</p></div>`
    : "";
  const fracitonalHtml = opts.fracitonal
    ? `<div class="div-block-14 fracitonal"><p class="paragraph week w-dyn-bind-empty"></p><p class="paragraph fracitonal">Fractional Contract</p></div>`
    : "";
  return `<div role="listitem" class="job-list-item w-dyn-item"><a href="/jobs/${opts.slug}" class="margin-bottom margin-xxlarge-copy w-inline-block">
    <h3 class="heading-style-h5-2-copy">${opts.title}</h3>
    ${statusHtml}
    <div class="blog-post4-header_title-wrapper-right">${priceHtml}${daysHtml}${fracitonalHtml}</div>
  </a></div>`;
}

function htmlResponse2(body: string, ok = true, status = 200): Response {
  return { ok, status, statusText: ok ? "OK" : "Error", text: async () => body } as unknown as Response;
}

describe("fractionusSource: detail-enrichment + closed-detection", () => {
  const cfg2: SourceConfig = { id: "fractionus", enabled: true };
  const profile2 = { name: "t", roles: [], skills: [], timezone: "UTC" };
  const originalFetch = global.fetch;
  let tmpDir: string;

  beforeEach(() => {
    closeDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-fractionus-detail-test-"));
    vi.stubEnv("GIGRADAR_DB_PATH", path.join(tmpDir, "gigs.db"));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    closeDb();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("excludes a Closed listing straight from its OWN list card (real bug report gig: fractional-cto-at-emanate-technology) with zero extra fetches, and the existing archival sweep then correctly archives it", async () => {
    // The real, live-fetched list-card markup for this exact gig
    // (2026-09-07) — still returned by the source's own /jobs page, but its
    // own status badge already says "Closed". A second, unrelated open card
    // is also present -- recordScan()'s own delisting sweep only runs for
    // a source batch that returned >=1 gig this scan (see store/gigs.ts's
    // "no silent zero" rule); real /jobs scans always have plenty of other
    // cards, this just keeps that same real precondition true here.
    const html = jobsPageHtml(
      fractionusCard({
        slug: "fractional-cto-at-emanate-technology",
        title: "CTO (Fractional - Permanent 0.6 FTE)",
        status: "Closed",
        price: { min: 150, max: 300 },
        days: { min: 10, max: 20 },
      }) + fractionusCard({ slug: "fractional-cfo-at-other-co", title: "Unrelated Open Role", status: "Active" }),
    );
    const fetchMock = vi.fn(async () => htmlResponse2(html));
    global.fetch = fetchMock as unknown as typeof fetch;

    // gigradar's own real, pre-fix state for this gig: still 'new', never
    // flagged unavailable, tiered green from an earlier scan.
    recordScan([
      {
        sourceId: "fractionus",
        gigs: [
          {
            sourceId: "fractionus",
            externalId: "fractional-cto-at-emanate-technology",
            title: "CTO (Fractional - Permanent 0.6 FTE)",
            url: "https://fractionus.com/jobs/fractional-cto-at-emanate-technology",
            tier: "green",
          },
        ],
      },
    ]);

    const gigs = await fractionusSource.fetch(cfg2, profile2);

    // Excluded — never even considered for the bounded detail-page
    // fallback (the closed card is filtered out before that stage).
    expect(gigs.find((g) => g.externalId === "fractional-cto-at-emanate-technology")).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1); // the list page only — zero extra fetches needed

    // Feeding this scan's (now-missing) results into the EXISTING
    // recordScan() delisting sweep is exactly what heals the real gig —
    // no new archival mechanism, reusing store/gigs.ts's own mechanism.
    recordScan([{ sourceId: "fractionus", gigs }]);

    const stored = getGig("fractionus:fractional-cto-at-emanate-technology");
    expect(stored).toMatchObject({
      status: "archived",
      outcomeReason: "expired_unapplied", // was 'new' -- never applied before it closed
    });
    expect(stored?.unavailableSince).not.toBeNull();
  });

  it("archives a listing that closes AFTER we already applied with the existing 'withdrawn' outcome reason, not 'expired_unapplied'", async () => {
    const html = jobsPageHtml(
      fractionusCard({ slug: "fractional-cfo-at-acme", title: "Fractional CFO", status: "Filled" }) +
        fractionusCard({ slug: "fractional-cfo-at-other-co", title: "Unrelated Open Role", status: "Active" }),
    );
    global.fetch = vi.fn(async () => htmlResponse2(html)) as unknown as typeof fetch;

    recordScan([
      {
        sourceId: "fractionus",
        gigs: [{ sourceId: "fractionus", externalId: "fractional-cfo-at-acme", title: "Fractional CFO", url: "https://fractionus.com/jobs/fractional-cfo-at-acme", tier: "green" }],
      },
    ]);
    const { setStatus } = await import("../../store/index.js");
    setStatus("fractionus:fractional-cfo-at-acme", "applied");

    const gigs = await fractionusSource.fetch(cfg2, profile2);
    expect(gigs.find((g) => g.externalId === "fractional-cfo-at-acme")).toBeUndefined();
    recordScan([{ sourceId: "fractionus", gigs }]);

    expect(getGig("fractionus:fractional-cfo-at-acme")).toMatchObject({ status: "archived", outcomeReason: "withdrawn" });
  });

  it("falls back to a bounded, lazy per-listing DETAIL-page fetch when an already green-tiered listing's own list card has no rate — real, live-fetched detail-page fixture", async () => {
    const detailHtml = fs.readFileSync(path.join(fixturesDir, "fractionus-job-detail-open.html"), "utf8");
    const listHtml = jobsPageHtml(
      fractionusCard({ slug: "fractional-cfo-at-find-great-people-fgp", title: "Interim Chief Financial Officer", status: "Active" }),
    );
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === "https://fractionus.com/jobs") return htmlResponse2(listHtml);
      if (u === "https://fractionus.com/jobs/fractional-cfo-at-find-great-people-fgp") return htmlResponse2(detailHtml);
      throw new Error(`unexpected fetch: ${u}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    recordScan([
      {
        sourceId: "fractionus",
        gigs: [
          {
            sourceId: "fractionus",
            externalId: "fractional-cfo-at-find-great-people-fgp",
            title: "Interim Chief Financial Officer",
            url: "https://fractionus.com/jobs/fractional-cfo-at-find-great-people-fgp",
            tier: "green",
          },
        ],
      },
    ]);

    const gigs = await fractionusSource.fetch(cfg2, profile2);
    const gig = gigs.find((g) => g.externalId === "fractional-cfo-at-find-great-people-fgp");
    expect(gig).toMatchObject({ rate: { min: 75, max: 150, unit: "hour" }, weeklyHours: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // the list page, plus exactly one bounded detail-page fetch
  });

  it("never fetches a detail page for a listing that hasn't cleared tiering yet — bounded/lazy, not automatic", async () => {
    const listHtml = jobsPageHtml(
      fractionusCard({ slug: "fractional-cfo-at-find-great-people-fgp", title: "Interim Chief Financial Officer", status: "Active" }),
    );
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === "https://fractionus.com/jobs") return htmlResponse2(listHtml);
      throw new Error(`unexpected fetch (should never fire for an untiered gig): ${String(url)}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    // No prior recordScan() at all -- this gig has never been tiered.

    const gigs = await fractionusSource.fetch(cfg2, profile2);
    expect(gigs[0]?.rate).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never fetches a detail page for an already-archived listing, even if it's still on the list page — nothing left to learn", async () => {
    const listHtml = jobsPageHtml(fractionusCard({ slug: "fractional-cfo-at-acme", title: "Fractional CFO", status: "Active" }));
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === "https://fractionus.com/jobs") return htmlResponse2(listHtml);
      throw new Error(`unexpected fetch (should never fire for an archived gig): ${String(url)}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    recordScan([
      {
        sourceId: "fractionus",
        gigs: [{ sourceId: "fractionus", externalId: "fractional-cfo-at-acme", title: "Fractional CFO", url: "https://fractionus.com/jobs/fractional-cfo-at-acme", tier: "green" }],
      },
    ]);
    const { setStatus } = await import("../../store/index.js");
    setStatus("fractionus:fractional-cfo-at-acme", "archived");

    await fractionusSource.fetch(cfg2, profile2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps the bounded detail-page fetch at MAX_DETAIL_FETCHES_PER_SCAN even when many listings are eligible", async () => {
    const slugs = Array.from({ length: 20 }, (_, i) => `fractional-role-${i}-at-acme`);
    const listHtml = jobsPageHtml(slugs.map((slug) => fractionusCard({ slug, title: "Some Role", status: "Active" })).join(""));
    const detailFetchedUrls = new Set<string>();
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === "https://fractionus.com/jobs") return htmlResponse2(listHtml);
      detailFetchedUrls.add(u);
      return htmlResponse2(
        fractionusCard({ slug: "irrelevant", title: "irrelevant", status: "Active", price: { min: 100, max: 100 } }),
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    recordScan([
      {
        sourceId: "fractionus",
        gigs: slugs.map((slug) => ({
          sourceId: "fractionus",
          externalId: slug,
          title: "Some Role",
          url: `https://fractionus.com/jobs/${slug}`,
          tier: "green",
        })),
      },
    ]);

    await fractionusSource.fetch(cfg2, profile2);
    // 20 candidates are eligible (all green-tiered, none have a card-level
    // rate) but the bound caps the actual fetch count well below that.
    expect(detailFetchedUrls.size).toBe(15);
    expect(fetchMock).toHaveBeenCalledTimes(1 + 15);
  });
});
