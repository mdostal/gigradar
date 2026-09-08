import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../types.js";
import { axialSearchSource } from "../axialsearch.js";

// A recorded, sanitized fixture of real axialsearch.com/jobs responses,
// captured live while building this adapter (owner's own direction,
// 2026-09-08: "add axial search to the job board, this seems another
// solid fractional finder"). 3 real job cards (verbatim markup and real
// values — title, location, salary, and posted-date text), pulled from a
// live fetch of the real /jobs page and page 6 of a real 56-listing
// board, chosen to cover every branch this adapter parses: a full-time
// annual-salary listing posted "Today", a fractional hourly listing
// posted "N days ago", and a full-time listing posted "30+ days ago".
// Checked for PII before saving: generic public job-board listing text
// (title/location/salary/date), nothing needed scrubbing. Zero network
// calls happen anywhere in this file.
const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const page1Html = fs.readFileSync(path.join(fixturesDir, "axialsearch-jobs-page1.html"), "utf8");
const EMPTY_PAGE_HTML = "<!doctype html><html><head><title>AI Transformation Jobs | Axial Search</title></head><body></body></html>";

function htmlResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: async () => body,
  } as unknown as Response;
}

const cfg: SourceConfig = { id: "axialsearch", enabled: true };
const profile = { name: "t", roles: [], skills: [], timezone: "UTC" };

describe("axialSearchSource", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:00:00.000Z"));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("normalizes real Axial Search listings into Gig[] with real per-listing urls, stopping pagination at the first empty page", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === "https://axialsearch.com/jobs") return htmlResponse(page1Html);
      if (u === "https://axialsearch.com/jobs?page=2") return htmlResponse(EMPTY_PAGE_HTML);
      throw new Error(`unexpected url in test: ${u}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const gigs = await axialSearchSource.fetch(cfg, profile);

    expect(gigs).toHaveLength(3);
    // Fetched page 1 with no query string, then page 2 (which came back
    // empty), then stopped — never a page 3.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://axialsearch.com/jobs");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://axialsearch.com/jobs?page=2");

    const fullTimeToday = gigs.find((g) => g.externalId === "director-ai-strategy-united-states-1");
    expect(fullTimeToday).toMatchObject({
      sourceId: "axialsearch",
      externalId: "director-ai-strategy-united-states-1",
      title: "Director, AI Strategy",
      url: "https://axialsearch.com/jobs/director-ai-strategy-united-states-1",
      rate: { min: 210000, max: 380000, unit: "year" },
      employmentType: "full-time",
      postedAt: "2026-09-08", // "Today" against the frozen system time above
    });
    // No company field exists anywhere on this board — see the adapter's
    // own file-level comment.
    expect(fullTimeToday?.company).toBeUndefined();
    // Never the /jobs listing page itself — always the specific job's own permalink.
    expect(fullTimeToday?.url).not.toBe("https://axialsearch.com/jobs");

    const fractionalHourly = gigs.find((g) => g.externalId === "fractional-head-of-ai-united-states-2");
    expect(fractionalHourly).toMatchObject({
      title: "Fractional Head of AI",
      rate: { min: 140, max: 590, unit: "hour" },
      employmentType: "fractional",
      postedAt: "2026-08-31", // 8 days before the frozen system time above
    });

    const thirtyPlus = gigs.find((g) => g.externalId === "director-product-austin-175");
    expect(thirtyPlus).toMatchObject({
      title: "Director, Product",
      rate: { min: 240000, max: 390000, unit: "year" },
      employmentType: "full-time",
      // "30+ days ago" is treated as exactly 30 days — a safe lower bound,
      // never guessed higher. Frozen system time is 2026-09-08.
      postedAt: "2026-08-09",
    });
  });

  it("carries the raw parsed item (including location, which has no dedicated Gig field) for debugging", async () => {
    global.fetch = vi.fn(async () => htmlResponse(page1Html)) as unknown as typeof fetch;
    const gigs = await axialSearchSource.fetch(cfg, profile);
    const gig = gigs.find((g) => g.externalId === "director-product-austin-175");
    expect(gig?.raw).toMatchObject({ location: "Austin, TX" });
  });

  it("returns an empty array when the real jobs page genuinely has zero listings, without throwing", async () => {
    global.fetch = vi.fn(async () => htmlResponse(EMPTY_PAGE_HTML)) as unknown as typeof fetch;
    const gigs = await axialSearchSource.fetch(cfg, profile);
    expect(gigs).toEqual([]);
  });

  it("throws when the response isn't recognizably Axial's own jobs page (interstitial/error page)", async () => {
    global.fetch = vi.fn(async () => htmlResponse("<html><body>Service Unavailable</body></html>")) as unknown as typeof fetch;
    await expect(axialSearchSource.fetch(cfg, profile)).rejects.toThrow(/unexpected response shape/);
  });

  it("throws on a non-ok HTTP response rather than silently returning []", async () => {
    global.fetch = vi.fn(async () => htmlResponse("", false, 503)) as unknown as typeof fetch;
    await expect(axialSearchSource.fetch(cfg, profile)).rejects.toThrow(/HTTP 503/);
  });

  it("throws when real card markers are present but none can be parsed (markup drift), rather than silently returning []", async () => {
    const brokenHtml =
      '<!doctype html><html><head><title>AI Transformation Jobs | Axial Search</title></head><body><a class="jr" href="/jobs/some-slug"><div>no title or salary markup here</div></a></body></html>';
    global.fetch = vi.fn(async () => htmlResponse(brokenHtml)) as unknown as typeof fetch;
    await expect(axialSearchSource.fetch(cfg, profile)).rejects.toThrow(/could not parse any of them/);
  });

  it("dedupes by externalId across pages", async () => {
    // Same real card appearing twice (defensive — live pagination showed
    // zero real overlap, but this adapter dedupes anyway, matching this
    // project's other adapters' own convention).
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === "https://axialsearch.com/jobs") return htmlResponse(page1Html);
      if (u === "https://axialsearch.com/jobs?page=2") return htmlResponse(page1Html);
      if (u === "https://axialsearch.com/jobs?page=3") return htmlResponse(EMPTY_PAGE_HTML);
      throw new Error(`unexpected url in test: ${u}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const gigs = await axialSearchSource.fetch(cfg, profile);
    expect(gigs).toHaveLength(3); // not 6 — the duplicate page's items collapsed
  });

  it("leaves rate/employmentType unset for a salary-text shape it doesn't recognize, rather than guessing", async () => {
    const html =
      '<!doctype html><html><head><title>AI Transformation Jobs | Axial Search</title></head><body><a class="jr" href="/jobs/some-slug"><h3 class="jr-title">Some Role</h3><p class="jr-loc-wide">Remote</p><div class="jr-salary">Competitive</div><div class="jr-posted">Today</div></a></body></html>';
    global.fetch = vi.fn(async () => htmlResponse(html)) as unknown as typeof fetch;
    const gigs = await axialSearchSource.fetch(cfg, profile);
    expect(gigs).toHaveLength(1);
    expect(gigs[0]?.rate).toBeUndefined();
    expect(gigs[0]?.employmentType).toBeUndefined();
  });
});
