import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../types.js";
import { braintrustSource } from "../braintrust.js";

// Recorded, sanitized fixtures of a real `GET /api/jobs/?role=5` response
// captured live from app.usebraintrust.com's public (no-login) job board
// while building this adapter. The list endpoint never returns free-text
// description/contact fields, so there was nothing to scrub for PII — these
// are the untouched shapes (structure AND values) it actually returned,
// just subset down to a handful of rows covering every payment_type this
// adapter branches on (hourly / annual / per_task) plus an empty-hours-cap
// edge case. Zero network calls happen anywhere in this file.
const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const page1 = JSON.parse(fs.readFileSync(path.join(fixturesDir, "braintrust-jobs-role-5-page1.json"), "utf8"));
const page2 = JSON.parse(fs.readFileSync(path.join(fixturesDir, "braintrust-jobs-role-5-page2.json"), "utf8"));

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

const cfg: SourceConfig = { id: "braintrust", enabled: true };

describe("braintrustSource", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("normalizes real Braintrust listings into Gig[] with real per-listing urls", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("page=2")) return jsonResponse(page2);
      return jsonResponse(page1);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const gigs = await braintrustSource.fetch(cfg, {
      name: "t",
      roles: [],
      skills: [],
      timezone: "UTC",
    });

    // Followed pagination: page1 (4) + page2 (1) = 5, deduped by id.
    expect(gigs).toHaveLength(5);

    const pythonEngineer = gigs.find((g) => g.externalId === "17628");
    expect(pythonEngineer).toBeDefined();
    expect(pythonEngineer).toMatchObject({
      sourceId: "braintrust",
      externalId: "17628",
      title: "Python Engineer (China or USA - Remote)",
      company: "SuperAnnotate AI, Inc",
      url: "https://app.usebraintrust.com/jobs/17628/",
      rate: { min: 40, max: 60, unit: "hour" },
      weeklyHours: 20,
      postedAt: "2026-08-10",
    });
    // Never a search/listing page — always the specific job id.
    expect(pythonEngineer?.url).not.toMatch(/[?&]role=/);

    // annual payment_type maps to unit "year".
    const annualJob = gigs.find((g) => g.externalId === "17602");
    expect(annualJob?.rate).toEqual({ min: 125000, max: 130000, unit: "year" });

    // per_task has no honest hour/month/year mapping — left unknown, not guessed.
    const perTaskJob = gigs.find((g) => g.externalId === "17661");
    expect(perTaskJob?.rate).toBeUndefined();

    // Neither remote nor contractToHire is exposed by this API — must stay
    // unset rather than fabricated true/false.
    for (const g of gigs) {
      expect(g.remote).toBeUndefined();
      expect(g.contractToHire).toBeUndefined();
    }

    // Fetched page 2 by following `next` (upgraded from http:// to https://).
    const secondCallUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(secondCallUrl).toBe("https://app.usebraintrust.com/api/jobs/?page=2&role=5");
  });

  it("throws (never returns []) when the fetch fails outright", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND app.usebraintrust.com");
    }) as unknown as typeof fetch;

    await expect(braintrustSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(
      /braintrust/,
    );
  });

  it("throws on a non-2xx HTTP response instead of silently returning zero", async () => {
    global.fetch = vi.fn(async () => jsonResponse({}, false, 503)) as unknown as typeof fetch;

    await expect(braintrustSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it("throws on an unexpected response shape rather than returning zero", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ oops: "not a jobs page" })) as unknown as typeof fetch;

    await expect(braintrustSource.fetch(cfg, { name: "t", roles: [], skills: [], timezone: "UTC" })).rejects.toThrow(
      /unexpected response shape/,
    );
  });

  it("is registered with auth: none", () => {
    expect(braintrustSource.id).toBe("braintrust");
    expect(braintrustSource.auth).toBe("none");
  });
});
