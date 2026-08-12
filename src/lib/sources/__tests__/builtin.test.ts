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
    const fetchMock = vi.fn(async (_url: string | URL) => htmlResponse(fixtureHtml));
    global.fetch = fetchMock as unknown as typeof fetch;

    const gigs = await builtinSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" });

    expect(gigs).toHaveLength(10);
    // Fetched the default category with no ?page= param (robots.txt
    // disallows `*?page=` for generic bots — see builtin.ts's doc comment).
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://builtin.com/jobs/dev-engineering");

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
});
