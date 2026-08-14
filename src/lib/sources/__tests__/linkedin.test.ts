import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Profile, SourceConfig } from "../../types.js";
import { linkedinSource } from "../linkedin.js";

// A real, trimmed fixture of LinkedIn's public "guest" job search page
// (`/jobs/search/?keywords=fractional%20CTO&f_JT=C%2CP`), live-fetched with
// a bare `curl`/Node `fetch()` — zero cookies, zero authentication — while
// building this adapter. Confirmed live: this page is fully server-rendered
// (the same 60 real listings come back from a cookieless fetch as from a
// real headed browser), so this is genuinely what production sees, not a
// JS-rendered shape this adapter could never actually get via fetch().
// Trimmed to the first 10 of 60 real cards to keep the fixture a reasonable
// size (regex-based parsing, not a DOM parser, so a well-formed document
// past that point was never required). Checked for PII before saving: real
// but entirely public job-posting content (titles/companies/locations same
// as anyone sees on linkedin.com/jobs without logging in) — the one
// "session_key" match anywhere in the file is LinkedIn's own generic,
// empty sign-in form INPUT FIELD markup (id="csm-v2_session_key"), not a
// real credential or session value. Zero network calls happen in this file.
const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const fixtureHtml = fs.readFileSync(path.join(fixturesDir, "linkedin-search.html"), "utf8");

function htmlResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: async () => body,
  } as unknown as Response;
}

const cfg: SourceConfig = { id: "linkedin", enabled: true };
const profile: Profile = { name: "t", roles: [], skills: [], timezone: "UTC" };

describe("linkedinSource", () => {
  it("is registered with auth: none", () => {
    expect(linkedinSource.auth).toBe("none");
  });

  it("normalizes real LinkedIn guest-search cards into Gig[] with real ids/titles/companies/urls", async () => {
    global.fetch = vi.fn(async () => htmlResponse(fixtureHtml)) as unknown as typeof fetch;

    const gigs = await linkedinSource.fetch(cfg, profile);

    expect(gigs).toHaveLength(10);
    const first = gigs.find((g) => g.externalId === "4417204712");
    expect(first).toMatchObject({
      sourceId: "linkedin",
      externalId: "4417204712",
      title: "Payments Domain Expert",
      company: "Vytwo Technologies Inc.",
      url: "https://www.linkedin.com/jobs/view/payments-domain-expert-at-vytwo-technologies-inc-4417204712",
      postedAt: "2026-05-27",
    });
  });

  it("strips ephemeral tracking query params (position/pageNum/refId/trackingId) from Gig.url, keeping only the real listing path", async () => {
    global.fetch = vi.fn(async () => htmlResponse(fixtureHtml)) as unknown as typeof fetch;

    const gigs = await linkedinSource.fetch(cfg, profile);

    for (const gig of gigs) {
      expect(gig.url).not.toContain("?");
      expect(gig.url).toMatch(/^https:\/\/www\.linkedin\.com\/jobs\/view\//);
    }
  });

  it("never fabricates rate or weeklyHours — LinkedIn's guest cards show neither", async () => {
    global.fetch = vi.fn(async () => htmlResponse(fixtureHtml)) as unknown as typeof fetch;

    const gigs = await linkedinSource.fetch(cfg, profile);

    for (const gig of gigs) {
      expect(gig.rate).toBeUndefined();
      expect(gig.weeklyHours).toBeUndefined();
    }
  });

  it("de-dups by job id within a single fetch", async () => {
    const doubled = fixtureHtml + fixtureHtml; // same 10 cards, twice
    global.fetch = vi.fn(async () => htmlResponse(doubled)) as unknown as typeof fetch;

    const gigs = await linkedinSource.fetch(cfg, profile);

    expect(gigs).toHaveLength(10);
  });

  it("uses settings.searchKeywords and settings.jobType to build the search URL, defaulting to generic tool-purpose values when unset", async () => {
    const fetchMock = vi.fn(async (_url: string | URL) => htmlResponse(fixtureHtml));
    global.fetch = fetchMock as unknown as typeof fetch;

    await linkedinSource.fetch({ id: "linkedin", enabled: true, settings: { searchKeywords: "fractional COO", jobType: "C" } }, profile);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("keywords=fractional%20COO");
    expect(calledUrl).toContain("f_JT=C");

    fetchMock.mockClear();
    await linkedinSource.fetch(cfg, profile); // no settings at all
    const defaultUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(defaultUrl).toContain("keywords=fractional"); // DEFAULT_SEARCH_KEYWORDS, generic to the tool's own purpose
    expect(defaultUrl).toContain("f_JT=C%2CP"); // DEFAULT_JOB_TYPE
  });

  it("throws (never returns []) when the fetch fails outright", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND linkedin.com");
    }) as unknown as typeof fetch;

    await expect(linkedinSource.fetch(cfg, profile)).rejects.toThrow(/network error/);
  });

  it("throws on a non-2xx HTTP response instead of silently returning zero", async () => {
    global.fetch = vi.fn(async () => htmlResponse("blocked", false, 999)) as unknown as typeof fetch;

    await expect(linkedinSource.fetch(cfg, profile)).rejects.toThrow(/HTTP 999/);
  });

  it("throws on an unexpected response shape (no job-card markers) rather than returning zero", async () => {
    global.fetch = vi.fn(async () => htmlResponse("<html><body>not linkedin</body></html>")) as unknown as typeof fetch;

    await expect(linkedinSource.fetch(cfg, profile)).rejects.toThrow(/unexpected response shape/);
  });

  it("throws when job-card markers are present but none of them parse (markup drift)", async () => {
    const brokenHtml = fixtureHtml.replace(/base-search-card__title/g, "totally-different-class-now");
    global.fetch = vi.fn(async () => htmlResponse(brokenHtml)) as unknown as typeof fetch;

    await expect(linkedinSource.fetch(cfg, profile)).rejects.toThrow(/found \d+ job card\(s\) but could not parse any/);
  });
});
