import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../types.js";
import { builtinSource } from "../builtin.js";

// A recorded, sanitized fixture of real builtin.com `/jobs/dev-engineering`
// responses, captured live from the public (no-login) job board while
// building this adapter. It's a hand-assembled composite: 10 real job-card
// HTML fragments (verbatim markup and values, id/title/company/comp
// range/work-type/posted-time/description all real), pulled from three
// separate live page fetches (page 1, page 2, and page 5 of the same
// category — needed to capture every branch this adapter parses: Annually
// vs Hourly comp, Remote/Hybrid/In-Office work types, a missing-salary card,
// and every relative-posted-time shape observed live: "N Minutes/Hours/Days
// Ago", "Reposted ..." variants, and bare "Yesterday"). Each fragment is
// truncated right after its description block to keep the fixture a
// reasonable size — safe because this adapter's parser is regex-based, not
// a DOM parser, so well-formed/closed HTML past that point was never
// required. Checked for PII before saving: these are generic company job
// descriptions with no names/emails/phone numbers, so nothing needed
// scrubbing. Zero network calls happen anywhere in this file.
const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const fixtureHtml = fs.readFileSync(path.join(fixturesDir, "builtin-jobs-dev-engineering.html"), "utf8");

// A real BuiltIn job detail page (`/job/staff-backend-software-engineer/10611593`,
// the same live listing as the "annualJob" / General Motors card in the list
// fixture above), live-fetched while building this story. Trimmed right
// after the `<script type="application/ld+json">` block in `<head>` that
// this adapter's fetchDetailDescription() targets -- everything past that
// point (footer, related-jobs widgets, etc.) was never needed since parsing
// is regex-based, not a DOM parser. Checked for PII before saving: the only
// contact info present was General Motors' own generic public accommodation
// phone line, which has been redacted (1-800-XXX-XXXX) out of caution even
// though it's a generic corporate line published on every GM posting, not a
// person's. Zero network calls happen anywhere in this file.
const detailFixtureHtml = fs.readFileSync(path.join(fixturesDir, "builtin-job-detail.html"), "utf8");
const DETAIL_FIXTURE_URL = "https://builtin.com/job/staff-backend-software-engineer/10611593";
// The short list-card snippet for this same listing, as captured by the list fixture.
const LIST_SNIPPET_TEXT =
  "Design, develop, and maintain large-scale backend systems and APIs. Lead technical design and implementation of distributed, service-oriented and event-driven architectures. Perform code reviews, ensure security and performance, troubleshoot complex production incidents, and lead root-cause analysis and remediation. Hybrid role with 3 days in-office and ~20% domestic travel.";

function htmlResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: async () => body,
  } as unknown as Response;
}

const cfg: SourceConfig = { id: "builtin", enabled: true };

describe("builtinSource", () => {
  const originalFetch = global.fetch;
  const NOW = "2026-08-10T12:00:00.000Z";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("normalizes real BuiltIn listings into Gig[] with real per-listing urls", async () => {
    // Every listing's detail page also gets fetched now (for the fuller
    // description) — respond with a page that has no recognizable
    // JobPosting JSON-LD so every listing falls back to its list-card
    // snippet, keeping this test's assertions about the snippet-derived
    // fields below unaffected by the new detail-fetch behavior (which gets
    // its own dedicated tests further down).
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === "https://builtin.com/jobs/dev-engineering") return htmlResponse(fixtureHtml);
      return htmlResponse("<html><body>detail page, no ld+json here</body></html>");
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const gigs = await builtinSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

    expect(gigs).toHaveLength(10);
    // Fetched the default category with no ?page= param (robots.txt
    // disallows `*?page=` for generic bots — see builtin.ts's doc comment).
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://builtin.com/jobs/dev-engineering");
    // Every listing's own detail page got fetched too (1 category fetch + 10 detail fetches).
    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain(DETAIL_FIXTURE_URL);

    const annualJob = gigs.find((g) => g.externalId === "10611593");
    expect(annualJob).toMatchObject({
      sourceId: "builtin",
      externalId: "10611593",
      title: "Staff Backend Software Engineer",
      company: "General Motors",
      url: "https://builtin.com/job/staff-backend-software-engineer/10611593",
      rate: { min: 265000, max: 311000, unit: "year" },
      postedAt: "2026-08-10", // "21 Minutes Ago" relative to frozen NOW
    });
    // Never a search/category page — always the specific job's own permalink.
    expect(annualJob?.url).not.toMatch(/\/jobs\//);

    // "Remote" work type -> remote: true.
    const remoteJob = gigs.find((g) => g.externalId === "8532064");
    expect(remoteJob).toMatchObject({
      company: "Deepgram",
      remote: true,
      rate: { min: 150000, max: 220000, unit: "year" },
      postedAt: "2026-08-09", // "Reposted Yesterday"
    });

    // "In-Office" work type -> remote: false.
    const officeJob = gigs.find((g) => g.externalId === "9729265");
    expect(officeJob).toMatchObject({ company: "Boeing", remote: false, postedAt: "2026-08-10" });

    // Mixed/ambiguous work types ("Hybrid", "Remote or Hybrid") are left
    // unknown rather than guessed true/false.
    const hybridJob = gigs.find((g) => g.externalId === "10611593");
    expect(hybridJob?.remote).toBeUndefined();
    const remoteOrHybridJob = gigs.find((g) => g.externalId === "10404766");
    expect(remoteOrHybridJob?.remote).toBeUndefined();

    // Hourly comp maps to unit "hour", not "year".
    const hourlyJob = gigs.find((g) => g.externalId === "8050091");
    expect(hourlyJob).toMatchObject({
      company: "Sierra Space",
      rate: { min: 61, max: 119, unit: "hour" },
      postedAt: "2026-08-07", // "Reposted 3 Days Ago"
    });

    // No salary shown on the card at all -> rate left unknown, not guessed.
    const noSalaryJob = gigs.find((g) => g.externalId === "10169188");
    expect(noSalaryJob).toMatchObject({ company: "Cloudflare" });
    expect(noSalaryJob?.rate).toBeUndefined();

    // Bare "N Days Ago" (no "Reposted" prefix) and "N Days Ago" both parse.
    const daysAgoJob = gigs.find((g) => g.externalId === "10587397");
    expect(daysAgoJob?.postedAt).toBe("2026-08-06"); // "4 Days Ago"
    const elevenDaysAgoJob = gigs.find((g) => g.externalId === "4993252");
    expect(elevenDaysAgoJob?.postedAt).toBe("2026-07-30"); // "Reposted 11 Days Ago"

    // Not exposed by the list card at all -> must stay unset, never fabricated.
    for (const g of gigs) {
      expect(g.weeklyHours).toBeUndefined();
      expect(g.contractToHire).toBeUndefined();
    }
  });

  it("throws (never returns []) when the fetch fails outright", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND builtin.com");
    }) as unknown as typeof fetch;

    await expect(builtinSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(
      /builtin/,
    );
  });

  it("throws on a non-2xx HTTP response instead of silently returning zero", async () => {
    global.fetch = vi.fn(async () => htmlResponse("", false, 503)) as unknown as typeof fetch;

    await expect(builtinSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it("throws on an unexpected response shape rather than returning zero", async () => {
    global.fetch = vi.fn(async () => htmlResponse("<html><body>not a jobs page</body></html>")) as unknown as typeof fetch;

    await expect(builtinSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(
      /unexpected response shape/,
    );
  });

  it("throws when job cards are present but none of them parse (markup drift)", async () => {
    // A #jobs-list container with a job-card marker whose internal markup no
    // longer matches any of the field regexes below it — simulates BuiltIn
    // changing its card HTML rather than the category being legitimately
    // empty (that case is a real bug worth surfacing, not a silent zero).
    const brokenHtml = '<div id="jobs-list"><div id="job-card-1">totally different markup now</div></div>';
    global.fetch = vi.fn(async () => htmlResponse(brokenHtml)) as unknown as typeof fetch;

    await expect(builtinSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(
      /could not parse/,
    );
  });

  it("is registered with auth: none", () => {
    expect(builtinSource.id).toBe("builtin");
    expect(builtinSource.auth).toBe("none");
  });

  describe("detail-page description capture", () => {
    const CATEGORY_URL = "https://builtin.com/jobs/dev-engineering";
    const UNRECOGNIZED_DETAIL_HTML = "<html><body>detail page, no ld+json here</body></html>";

    it("uses the full detail-page description instead of the list-card snippet when the detail fetch succeeds", async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u === CATEGORY_URL) return htmlResponse(fixtureHtml);
        if (u === DETAIL_FIXTURE_URL) return htmlResponse(detailFixtureHtml);
        return htmlResponse(UNRECOGNIZED_DETAIL_HTML); // other listings: no fixture, not under test here
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const gigs = await builtinSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });
      const gig = gigs.find((g) => g.externalId === "10611593");

      // The real, full description text from the detail page's JobPosting
      // JSON-LD — present only in the detail page, never in the list-card snippet.
      expect(gig?.description).toContain("Eight (8) years of experience as a Software Engineer");
      expect(gig?.description).toContain("REQUIREMENTS");
      // Not the short list-card snippet, and meaningfully longer than it.
      expect(gig?.description).not.toBe(LIST_SNIPPET_TEXT);
      expect(gig?.description?.length ?? 0).toBeGreaterThan(LIST_SNIPPET_TEXT.length * 5);
      // HTML markup from the description's own source (<br>, <strong>, etc.)
      // was stripped down to plain text, not left as raw markup.
      expect(gig?.description).not.toMatch(/<[a-z]/i);
    });

    it("falls back to the list-card snippet when the detail-page fetch returns a network error", async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u === CATEGORY_URL) return htmlResponse(fixtureHtml);
        if (u === DETAIL_FIXTURE_URL) throw new Error("getaddrinfo ENOTFOUND builtin.com");
        return htmlResponse(UNRECOGNIZED_DETAIL_HTML);
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      // The overall scan does NOT fail because one listing's detail fetch errored.
      const gigs = await builtinSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });
      expect(gigs).toHaveLength(10);

      const gig = gigs.find((g) => g.externalId === "10611593");
      // Falls back to the original list-card snippet — never left unset
      // when SOME description (the snippet) was available.
      expect(gig?.description).toBe(LIST_SNIPPET_TEXT);
    });

    it("extracts the real JobPosting employmentType (FULL_TIME -> 'full-time') when the detail fetch succeeds", async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u === CATEGORY_URL) return htmlResponse(fixtureHtml);
        if (u === DETAIL_FIXTURE_URL) return htmlResponse(detailFixtureHtml);
        return htmlResponse(UNRECOGNIZED_DETAIL_HTML);
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const gigs = await builtinSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });
      const gig = gigs.find((g) => g.externalId === "10611593");

      expect(gig?.employmentType).toBe("full-time");
    });

    it("maps CONTRACTOR -> 'contract', and leaves an unmapped/unrecognized employmentType value unset (never guessed)", async () => {
      const contractorHtml = detailFixtureHtml.replace('"employmentType":"FULL_TIME"', '"employmentType":"CONTRACTOR"');
      const partTimeHtml = detailFixtureHtml.replace('"employmentType":"FULL_TIME"', '"employmentType":"PART_TIME"');

      global.fetch = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u === CATEGORY_URL) return htmlResponse(fixtureHtml);
        if (u === DETAIL_FIXTURE_URL) return htmlResponse(contractorHtml);
        return htmlResponse(UNRECOGNIZED_DETAIL_HTML);
      }) as unknown as typeof fetch;
      const contractorGigs = await builtinSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });
      expect(contractorGigs.find((g) => g.externalId === "10611593")?.employmentType).toBe("contract");

      global.fetch = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u === CATEGORY_URL) return htmlResponse(fixtureHtml);
        if (u === DETAIL_FIXTURE_URL) return htmlResponse(partTimeHtml);
        return htmlResponse(UNRECOGNIZED_DETAIL_HTML);
      }) as unknown as typeof fetch;
      const partTimeGigs = await builtinSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });
      expect(partTimeGigs.find((g) => g.externalId === "10611593")?.employmentType).toBeUndefined();
    });

    it("leaves employmentType unset when the detail-page fetch fails (same graceful-degradation path as description)", async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u === CATEGORY_URL) return htmlResponse(fixtureHtml);
        if (u === DETAIL_FIXTURE_URL) throw new Error("getaddrinfo ENOTFOUND builtin.com");
        return htmlResponse(UNRECOGNIZED_DETAIL_HTML);
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const gigs = await builtinSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });
      const gig = gigs.find((g) => g.externalId === "10611593");
      expect(gig?.employmentType).toBeUndefined();
    });

    it("falls back to the list-card snippet when the detail page has an unrecognized shape (no JobPosting JSON-LD found)", async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u === CATEGORY_URL) return htmlResponse(fixtureHtml);
        // A real 200 response, but not a shape this adapter recognizes —
        // distinct from a network error, and distinct from the list-fetch's
        // own throw-on-shape-failure behavior (unchanged, tested above):
        // this must return undefined, not throw.
        if (u === DETAIL_FIXTURE_URL) return htmlResponse(UNRECOGNIZED_DETAIL_HTML);
        return htmlResponse(UNRECOGNIZED_DETAIL_HTML);
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const gigs = await builtinSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });
      expect(gigs).toHaveLength(10);

      const gig = gigs.find((g) => g.externalId === "10611593");
      expect(gig?.description).toBe(LIST_SNIPPET_TEXT);
    });

    it("never has more than 4 detail-page requests in flight at once, across 25 listings", async () => {
      const LISTING_COUNT = 25;
      const cards = Array.from({ length: LISTING_COUNT }, (_, i) => {
        const id = String(90000000 + i);
        return `<div id="job-card-${id}"><a href="/job/synthetic-job-${i}/${id}" data-id="job-card-title">Synthetic Job ${i}</a></div>`;
      }).join("\n");
      const syntheticListHtml = `<div id="jobs-list">${cards}</div>`;

      let concurrent = 0;
      let maxConcurrent = 0;
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u === CATEGORY_URL) return htmlResponse(syntheticListHtml);
        // A detail-page request: track how many are in flight at once. All
        // requests within one Promise.all() batch invoke this mock
        // synchronously before any of them resolves, so if the adapter ever
        // batched more than DETAIL_FETCH_BATCH_SIZE (4) at a time, this
        // counter would observe it.
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await Promise.resolve();
        await Promise.resolve();
        concurrent--;
        return htmlResponse(UNRECOGNIZED_DETAIL_HTML);
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const gigs = await builtinSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

      expect(gigs).toHaveLength(LISTING_COUNT);
      // 1 category fetch + 25 detail fetches.
      expect(fetchMock).toHaveBeenCalledTimes(LISTING_COUNT + 1);
      // Real batching happened (hit the cap)...
      expect(maxConcurrent).toBe(4);
      // ...and never exceeded it, even with 25 listings to process.
      expect(maxConcurrent).toBeLessThanOrEqual(4);
    });
  });
});
