import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../types.js";
import { fractionusSource } from "../fractionus.js";

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

    // rate/weeklyHours are never fabricated on this board — always left
    // unknown, per this story's design_decisions.
    for (const g of gigs) {
      expect(g.rate).toBeUndefined();
      expect(g.weeklyHours).toBeUndefined();
    }
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
