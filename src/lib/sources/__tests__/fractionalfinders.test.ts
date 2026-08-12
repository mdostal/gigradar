import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../types.js";
import { fractionalFindersSource } from "../fractionalfinders.js";

// A recorded, sanitized fixture of real fractionalfinders.com/jobs
// responses, captured live while building this adapter
// (`.pHive/epics/adapter-batch-public-boards/docs/research-brief.md` §2's
// curl run). Hand-assembled composite: 4 real job-items HTML fragments
// (verbatim markup and values — company, title, work-arrangement text
// (where present), and posted date all real), pulled from a single live
// fetch of `/jobs` (only 16 real cards observed live — this is
// deliberately the SMALLEST of the three boards, see fractionalfinders.ts's
// file-level comment). These 4 were chosen to cover every branch this
// adapter parses: a "Remote" work-arrangement tag present, AND (on two of
// the four) the tag genuinely ABSENT from the real card — not a parse
// failure, just not always shown. Each fragment is truncated right after
// its own `post-date-txt` block (dropping the huge rich-text job
// description that follows in the real page) to keep the fixture a
// reasonable size — safe because this adapter's parser is regex-based, not
// a DOM parser (same convention as builtin.test.ts's own fixture). Checked
// for PII before saving: generic public job-board listing text (including
// one company name with real non-ASCII characters, "AORA Educação" —
// public company name, not personal data), nothing needed scrubbing. Zero
// network calls happen anywhere in this file.
const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const fixtureHtml = fs.readFileSync(path.join(fixturesDir, "fractionalfinders-jobs.html"), "utf8");

function htmlResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: async () => body,
  } as unknown as Response;
}

const cfg: SourceConfig = { id: "fractionalfinders", enabled: true };
const profile = { name: "t", roles: [], skills: [], timezone: "UTC" };

describe("fractionalFindersSource", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("normalizes real FractionalFinders listings into Gig[] with real per-listing urls", async () => {
    const fetchMock = vi.fn(async (_url: string | URL) => htmlResponse(fixtureHtml));
    global.fetch = fetchMock as unknown as typeof fetch;

    const gigs = await fractionalFindersSource.fetch(cfg, profile);

    expect(gigs).toHaveLength(4);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://www.fractionalfinders.com/jobs");

    // "Remote" arrangement tag present -> remote: true. Also exercises a
    // real non-ASCII company name (no HTML entity involved).
    const aora = gigs.find((g) => g.externalId === "aora-educacao");
    expect(aora).toMatchObject({
      sourceId: "fractionalfinders",
      externalId: "aora-educacao",
      title: "Chief Operating Officer",
      company: "AORA Educação",
      url: "https://www.fractionalfinders.com/jobs/aora-educacao",
      remote: true,
      postedAt: "2026-08-12",
    });
    // Never the /jobs search page — always the specific job's own permalink.
    expect(aora?.url).not.toBe("https://www.fractionalfinders.com/jobs");

    // The work-arrangement tag is genuinely absent on this real card (not
    // every listing shows one) -> remote left unknown, never guessed.
    const rutherford = gigs.find((g) => g.externalId === "rutherford-briant-recruitment");
    expect(rutherford).toMatchObject({
      company: "Rutherford Briant Recruitment",
      title: "Interim Managing Director",
      postedAt: "2026-08-12",
    });
    expect(rutherford?.remote).toBeUndefined();

    const animatous = gigs.find((g) => g.externalId === "animatous-2");
    expect(animatous).toMatchObject({ company: "Animatous", remote: true });

    const butlerRose = gigs.find((g) => g.externalId === "butler-rose-3");
    expect(butlerRose).toMatchObject({ company: "Butler Rose", postedAt: "2026-08-10" });
    expect(butlerRose?.remote).toBeUndefined();

    // rate/weeklyHours are never fabricated on this board — always left
    // unknown, per this story's design_decisions.
    for (const g of gigs) {
      expect(g.rate).toBeUndefined();
      expect(g.weeklyHours).toBeUndefined();
    }
  });

  it("throws (never returns []) when the fetch fails outright", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND fractionalfinders.com");
    }) as unknown as typeof fetch;

    await expect(fractionalFindersSource.fetch(cfg, profile)).rejects.toThrow(/fractionalfinders/);
  });

  it("throws on a non-2xx HTTP response instead of silently returning zero", async () => {
    global.fetch = vi.fn(async () => htmlResponse("", false, 503)) as unknown as typeof fetch;

    await expect(fractionalFindersSource.fetch(cfg, profile)).rejects.toThrow(/HTTP 503/);
  });

  it("throws on an unexpected response shape (genuine page-shape failure) rather than returning []", async () => {
    global.fetch = vi.fn(async () => htmlResponse("<html><body>not the jobs page</body></html>")) as unknown as typeof fetch;

    await expect(fractionalFindersSource.fetch(cfg, profile)).rejects.toThrow(/unexpected response shape/);
  });

  it("returns [] (never throws) when the page loads fine but genuinely has zero/few current listings — this is FractionalFinders' NORMAL state, not a break", async () => {
    // The real .job-list-wrapper container is present (a valid, real page
    // shape), just with zero job-items cards inside it. This board only had
    // 16 live listings during planning — a quiet page here is a legitimate,
    // expected state for its size, distinct from the page-shape-failure
    // case above (this is the exact scenario this story's design_decisions
    // calls out by name).
    const quietPageHtml =
      '<html><body><div class="job-list-wrapper"><div class="jobs-cms-wrap w-dyn-list"><div role="list" class="jobs-cms-list w-dyn-items"></div></div></div></body></html>';
    global.fetch = vi.fn(async () => htmlResponse(quietPageHtml)) as unknown as typeof fetch;

    const gigs = await fractionalFindersSource.fetch(cfg, profile);
    expect(gigs).toEqual([]);
  });

  it("throws when job cards are present but none of them parse (markup drift) — distinct from the zero-listings case above", async () => {
    const brokenHtml =
      '<html><body><div class="job-list-wrapper"><div slug="" role="listitem" class="job-items w-dyn-item">totally different markup now</div></div></body></html>';
    global.fetch = vi.fn(async () => htmlResponse(brokenHtml)) as unknown as typeof fetch;

    await expect(fractionalFindersSource.fetch(cfg, profile)).rejects.toThrow(/could not parse/);
  });

  it("is registered with auth: none", () => {
    expect(fractionalFindersSource.id).toBe("fractionalfinders");
    expect(fractionalFindersSource.auth).toBe("none");
  });
});
