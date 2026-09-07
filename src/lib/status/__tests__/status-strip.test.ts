import { describe, expect, it } from "vitest";
import {
  computeCycleCompleteness,
  computeLastScanIso,
  computeProfileComplete,
  computeSourceCounts,
  computeStatusStrip,
  formatRelativeTime,
} from "../status-strip";

// -- computeProfileComplete -------------------------------------------------

describe("computeProfileComplete", () => {
  it("is false when rawConfig is {} (no config.json yet — first run)", () => {
    expect(computeProfileComplete({})).toBe(false);
  });

  it("is false when profile.skills is missing", () => {
    expect(
      computeProfileComplete({ profile: { name: "Ada", roles: ["Fractional CTO"] } }),
    ).toBe(false);
  });

  it("is false when profile.skills is an empty array", () => {
    expect(
      computeProfileComplete({ profile: { name: "Ada", roles: ["Fractional CTO"], skills: [] } }),
    ).toBe(false);
  });

  it("is false when profile.name is blank", () => {
    expect(
      computeProfileComplete({ profile: { name: "", roles: ["Fractional CTO"], skills: ["TypeScript"] } }),
    ).toBe(false);
  });

  it("is false when profile.roles is an empty array", () => {
    expect(
      computeProfileComplete({ profile: { name: "Ada", roles: [], skills: ["TypeScript"] } }),
    ).toBe(false);
  });

  it("is true when name/roles/skills are all populated", () => {
    expect(
      computeProfileComplete({
        profile: { name: "Ada", roles: ["Fractional CTO"], skills: ["TypeScript", "AI"] },
      }),
    ).toBe(true);
  });

  it("is false (not throwing) when profile is a malformed non-object", () => {
    expect(computeProfileComplete({ profile: "not-an-object" })).toBe(false);
  });
});

// -- computeSourceCounts -----------------------------------------------------

describe("computeSourceCounts", () => {
  it("is {0, 0} when rawConfig has no sources array (e.g. {})", () => {
    expect(computeSourceCounts({})).toEqual({ configured: 0, needingAttention: 0 });
  });

  it("counts an enabled source (that genuinely needs settings) with no settings as needing attention", () => {
    // "gofractional" is a real KNOWN_SOURCES id with auth: "browser-session"
    // -- it genuinely needs settings.sessionStatePath to function.
    const result = computeSourceCounts({ sources: [{ id: "gofractional", enabled: true }] });
    expect(result).toEqual({ configured: 1, needingAttention: 1 });
  });

  it("counts an enabled source (that genuinely needs settings) with an empty settings object as needing attention", () => {
    const result = computeSourceCounts({ sources: [{ id: "gofractional", enabled: true, settings: {} }] });
    expect(result).toEqual({ configured: 1, needingAttention: 1 });
  });

  it("does not flag an enabled source with non-empty settings", () => {
    const result = computeSourceCounts({
      sources: [{ id: "gofractional", enabled: true, settings: { sessionStatePath: "/some/path.json" } }],
    });
    expect(result).toEqual({ configured: 1, needingAttention: 0 });
  });

  it("does not flag a disabled source regardless of settings", () => {
    const result = computeSourceCounts({ sources: [{ id: "gofractional", enabled: false }] });
    expect(result).toEqual({ configured: 1, needingAttention: 0 });
  });

  it("NEVER flags a KNOWN_SOURCES entry with auth:'none' for missing settings -- live-verified 2026-08-31: this was a real false positive against the owner's own config (6 of 9 real, working public-board sources were wrongly flagged)", () => {
    // braintrust/builtin/fractionaljobs/fractionus/fractionalfinders/linkedin
    // are all real KNOWN_SOURCES entries with auth: "none" -- genuinely
    // zero-config sources, checked here via one representative id.
    const result = computeSourceCounts({ sources: [{ id: "braintrust", enabled: true }] });
    expect(result).toEqual({ configured: 1, needingAttention: 0 });
  });

  it("still flags a source NOT present in KNOWN_SOURCES at all (a hand-added custom-llm/gmail-digest source) when it has no settings -- those genuinely need their own config", () => {
    const result = computeSourceCounts({ sources: [{ id: "my-custom-llm-source", enabled: true }] });
    expect(result).toEqual({ configured: 1, needingAttention: 1 });
  });

  it("mixes configured/needing-attention across multiple sources", () => {
    const result = computeSourceCounts({
      sources: [
        { id: "gofractional", enabled: true, settings: { sessionStatePath: "/x.json" } },
        { id: "ateam", enabled: true },
        { id: "braintrust", enabled: true }, // auth: "none" -- never flagged
        { id: "c", enabled: false },
      ],
    });
    expect(result).toEqual({ configured: 4, needingAttention: 1 });
  });

  it("does not throw on a malformed sources entry", () => {
    expect(() => computeSourceCounts({ sources: ["not-an-object", null, 42] })).not.toThrow();
    expect(computeSourceCounts({ sources: ["not-an-object", null, 42] })).toEqual({
      configured: 3,
      needingAttention: 0,
    });
  });
});

// -- computeLastScanIso -------------------------------------------------------

describe("computeLastScanIso", () => {
  it("is null when no gigs have ever been scanned", () => {
    expect(computeLastScanIso([])).toBeNull();
  });

  it("returns the single gig's lastSeen when there's exactly one", () => {
    expect(computeLastScanIso([{ lastSeen: "2026-01-01T00:00:00.000Z" }])).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns the MOST RECENT lastSeen across gigs with varying timestamps", () => {
    const result = computeLastScanIso([
      { lastSeen: "2026-01-01T00:00:00.000Z" },
      { lastSeen: "2026-03-15T12:00:00.000Z" },
      { lastSeen: "2026-02-01T00:00:00.000Z" },
    ]);
    expect(result).toBe("2026-03-15T12:00:00.000Z");
  });
});

// -- formatRelativeTime --------------------------------------------------------

describe("formatRelativeTime", () => {
  const now = new Date("2026-01-10T12:00:00.000Z").getTime();

  it("formats a couple hours ago in human-relative form", () => {
    expect(formatRelativeTime("2026-01-10T10:00:00.000Z", now)).toBe("2 hours ago");
  });

  it("formats a few minutes ago", () => {
    expect(formatRelativeTime("2026-01-10T11:55:00.000Z", now)).toBe("5 minutes ago");
  });

  it("formats several days ago", () => {
    expect(formatRelativeTime("2026-01-07T12:00:00.000Z", now)).toBe("3 days ago");
  });

  it("falls back gracefully on an unparseable date instead of 'Invalid Date'", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("unknown time");
  });
});

// -- computeStatusStrip (integration of the above, per acceptance criteria) --

describe("computeStatusStrip", () => {
  const now = new Date("2026-01-10T12:00:00.000Z").getTime();

  it("renders '0 sources configured' (not a crash or blank) given zero sources", () => {
    const status = computeStatusStrip([], {}, now);
    expect(status.sourcesLabel).toBe("0 sources configured");
  });

  it("shows 'Profile: needs setup' when profile.skills is empty/missing", () => {
    const status = computeStatusStrip([], { profile: { name: "Ada", roles: ["CTO"], skills: [] } }, now);
    expect(status.profileLabel).toBe("Profile: needs setup");
  });

  it("shows 'Profile: complete' when name/roles/skills are all populated", () => {
    const status = computeStatusStrip(
      [],
      { profile: { name: "Ada", roles: ["CTO"], skills: ["TypeScript"] } },
      now,
    );
    expect(status.profileLabel).toBe("Profile: complete");
  });

  it("shows 'Last scan: never run' when no gigs have ever been scanned", () => {
    const status = computeStatusStrip([], {}, now);
    expect(status.lastScanLabel).toBe("Last scan: never run");
  });

  it("shows the most recent last_seen in human-relative form given varying timestamps", () => {
    const status = computeStatusStrip(
      [
        { lastSeen: "2026-01-01T00:00:00.000Z" },
        { lastSeen: "2026-01-10T10:00:00.000Z" },
        { lastSeen: "2026-01-05T00:00:00.000Z" },
      ],
      {},
      now,
    );
    expect(status.lastScanLabel).toBe("Last scan: 2 hours ago");
  });

  it("renders the full strip (ENOENT-tolerant) without throwing when rawConfig is {} (no config.json yet)", () => {
    expect(() => computeStatusStrip([], {}, now)).not.toThrow();
    const status = computeStatusStrip([], {}, now);
    expect(status).toEqual({
      sourcesLabel: "0 sources configured",
      profileLabel: "Profile: needs setup",
      lastScanLabel: "Last scan: never run",
      cycleStatus: "unknown",
      incompleteSourceCount: 0,
    });
  });

  it("includes the '(M need attention)' suffix when sources need attention", () => {
    const status = computeStatusStrip(
      [],
      { sources: [{ id: "a", enabled: true }, { id: "b", enabled: true, settings: { x: "y" } }] },
      now,
    );
    expect(status.sourcesLabel).toBe("2 sources configured (1 need attention)");
  });

  // -- status-strip-reflects-cycle-completion story (real-usability-
  // verification-and-fixes epic) -- proves BOTH directions per this
  // story's own acceptance criteria: a fully-completed last cycle renders
  // an honest "up to date" label, and a partial one (real errors/timeouts/
  // backoff-skips) renders an honest "N source(s) didn't complete" label,
  // driven by the scheduler's/manual-sweep's own real per-cycle signal
  // (getLastScanCycle()'s result, passed in as `lastCycle`) -- NOT a wider
  // MAX(lastSeen) window or a cosmetic-only copy change.
  const gigsWithOneScan = [{ lastSeen: "2026-01-10T10:00:00.000Z" }];

  it("falls back to the plain (pre-cycle-tracking) timestamp label when no cycle has EVER been recorded (lastCycle omitted) -- an install that predates this signal, never a false 'up to date' claim", () => {
    const status = computeStatusStrip(gigsWithOneScan, {}, now);
    expect(status.lastScanLabel).toBe("Last scan: 2 hours ago");
    expect(status.cycleStatus).toBe("unknown");
    expect(status.incompleteSourceCount).toBe(0);
  });

  it("shows an honest 'up to date' label when the last recorded cycle had zero incomplete sources (a REAL fully-completed cycle)", () => {
    const status = computeStatusStrip(gigsWithOneScan, {}, now, { sourcesTotal: 8, incompleteSourceIds: [] });
    expect(status.lastScanLabel).toBe("Last scan: up to date (2 hours ago)");
    expect(status.cycleStatus).toBe("full");
    expect(status.incompleteSourceCount).toBe(0);
  });

  it("shows an honest 'partially updated' label naming the count when the last recorded cycle had real errored/timed-out/skipped sources", () => {
    const status = computeStatusStrip(gigsWithOneScan, {}, now, {
      sourcesTotal: 10,
      incompleteSourceIds: ["gofractional", "ateam"],
    });
    expect(status.lastScanLabel).toBe("Last scan: partially updated (2 hours ago) — 2 sources didn't complete");
    expect(status.cycleStatus).toBe("partial");
    expect(status.incompleteSourceCount).toBe(2);
  });

  it("singularizes the partial-cycle suffix for exactly one incomplete source", () => {
    const status = computeStatusStrip(gigsWithOneScan, {}, now, { sourcesTotal: 10, incompleteSourceIds: ["gofractional"] });
    expect(status.lastScanLabel).toBe("Last scan: partially updated (2 hours ago) — 1 source didn't complete");
  });

  it("a partial-cycle signal never overrides 'Last scan: never run' when no gig has ever been scanned at all", () => {
    const status = computeStatusStrip([], {}, now, { sourcesTotal: 10, incompleteSourceIds: ["gofractional"] });
    expect(status.lastScanLabel).toBe("Last scan: never run");
  });
});

// -- computeCycleCompleteness -------------------------------------------------

describe("computeCycleCompleteness", () => {
  it("is 'unknown' (never 'full') when no cycle has ever been recorded -- claiming completion with zero real evidence is exactly the falsely-reassuring label this story removes", () => {
    expect(computeCycleCompleteness(null)).toEqual({ cycleStatus: "unknown", incompleteSourceCount: 0 });
  });

  it("is 'full' when the last recorded cycle's incompleteSourceIds is empty", () => {
    expect(computeCycleCompleteness({ sourcesTotal: 5, incompleteSourceIds: [] })).toEqual({
      cycleStatus: "full",
      incompleteSourceCount: 0,
    });
  });

  it("is 'partial' with the real count when the last recorded cycle has >=1 incomplete source", () => {
    expect(computeCycleCompleteness({ sourcesTotal: 5, incompleteSourceIds: ["a", "b", "c"] })).toEqual({
      cycleStatus: "partial",
      incompleteSourceCount: 3,
    });
  });
});
