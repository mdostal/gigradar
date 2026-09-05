import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config, Gig } from "../../types.js";
import { closeDb, getDb } from "../../store/db.js";
import { recordScan } from "../../store/gigs.js";
import { saveDraft, setDraftStatus } from "../../store/drafts.js";
import { setStatus } from "../../store/gigs.js";
import { listAutoFireDecisions } from "../../store/drafts.js";
import { registerSubmitAdapter } from "../../submit/adapter.js";
import {
  approvedCount,
  checkDailyCapNotExceeded,
  checkDraftContentSanity,
  checkGigIsFresh,
  checkMatchBandInBand,
  checkTierIsGreen,
  dailyFireCount,
  evaluateAutoFire,
  findAutoFireRule,
  isGraduated,
} from "../autofire.js";

let tmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-autofire-test-"));
  db = getDb({ path: path.join(tmpDir, "gigs.db") });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeGig(overrides: Partial<Gig> & { sourceId: string; externalId: string }): Gig {
  return {
    title: "Fractional CTO",
    url: `https://example.test/${overrides.sourceId}/${overrides.externalId}`,
    ...overrides,
  };
}

/** Seeds one gig (with a real tier) and an approved draft for it. */
function seedApprovedDraft(sourceId: string, externalId: string, tier: Gig["tier"]): void {
  recordScan([{ sourceId, gigs: [makeGig({ sourceId, externalId, tier })] }], { db, now: "2026-01-01T00:00:00.000Z" });
  const gigKey = `${sourceId}:${externalId}`;
  saveDraft(gigKey, { coverText: "hi", answers: {} }, { db, now: "2026-01-01T00:00:00.000Z" });
  setDraftStatus(gigKey, "approved", { db, now: "2026-01-01T00:00:00.000Z" });
}

function seedDraftWithStatus(
  sourceId: string,
  externalId: string,
  tier: Gig["tier"],
  status: "draft" | "rejected" | "submitted",
): void {
  recordScan([{ sourceId, gigs: [makeGig({ sourceId, externalId, tier })] }], { db, now: "2026-01-01T00:00:00.000Z" });
  const gigKey = `${sourceId}:${externalId}`;
  saveDraft(gigKey, { coverText: "hi", answers: {} }, { db, now: "2026-01-01T00:00:00.000Z" });
  if (status !== "draft") setDraftStatus(gigKey, status, { db, now: "2026-01-01T00:00:00.000Z" });
}

const RULE_3: Config["autoFire"] = {
  rules: [{ sourceId: "src-a", tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }],
};

describe("approvedCount", () => {
  it("counts approved AND submitted drafts, never draft/rejected", () => {
    seedDraftWithStatus("src-a", "1", "green", "draft");
    seedDraftWithStatus("src-a", "2", "green", "rejected");
    seedApprovedDraft("src-a", "3", "green");
    seedDraftWithStatus("src-a", "4", "green", "submitted");

    expect(approvedCount("src-a", "green", { db })).toBe(2);
  });

  it("only counts drafts for the matching (sourceId, tier) pair", () => {
    seedApprovedDraft("src-a", "1", "green");
    seedApprovedDraft("src-a", "2", "yellow"); // wrong tier
    seedApprovedDraft("src-b", "3", "green"); // wrong source

    expect(approvedCount("src-a", "green", { db })).toBe(1);
  });

  it("returns 0 when nothing has ever been approved for the pair", () => {
    expect(approvedCount("src-a", "green", { db })).toBe(0);
  });
});

describe("isGraduated — the owner's exact worked example (3-approval threshold)", () => {
  it("is false with 2 approvals when minApprovals is 3", () => {
    seedApprovedDraft("src-a", "1", "green");
    seedApprovedDraft("src-a", "2", "green");

    const config = { autoFire: RULE_3 } as Config;
    expect(isGraduated("src-a", "green", config, { db })).toBe(false);
  });

  it("is true once the 3rd approval lands", () => {
    seedApprovedDraft("src-a", "1", "green");
    seedApprovedDraft("src-a", "2", "green");
    seedApprovedDraft("src-a", "3", "green");

    const config = { autoFire: RULE_3 } as Config;
    expect(isGraduated("src-a", "green", config, { db })).toBe(true);
  });

  it("is false for a pair with no configured rule at all, no matter how many approvals exist", () => {
    seedApprovedDraft("src-a", "1", "green");
    seedApprovedDraft("src-a", "2", "green");
    seedApprovedDraft("src-a", "3", "green");

    const config = { autoFire: { rules: [] } } as unknown as Config;
    expect(isGraduated("src-a", "green", config, { db })).toBe(false);
  });

  it("is false when config.autoFire is entirely unset", () => {
    seedApprovedDraft("src-a", "1", "green");
    seedApprovedDraft("src-a", "2", "green");
    seedApprovedDraft("src-a", "3", "green");

    const config = {} as Config;
    expect(isGraduated("src-a", "green", config, { db })).toBe(false);
  });
});

describe("findAutoFireRule", () => {
  it("finds the rule matching (sourceId, tier) exactly", () => {
    const config = { autoFire: RULE_3 } as Config;
    expect(findAutoFireRule("src-a", "green", config)).toEqual(RULE_3!.rules[0]);
  });

  it("returns undefined for a pair with no matching rule", () => {
    const config = { autoFire: RULE_3 } as Config;
    expect(findAutoFireRule("src-a", "yellow", config)).toBeUndefined();
    expect(findAutoFireRule("src-b", "green", config)).toBeUndefined();
  });
});

describe("the 4 default checks (design-discussion.md §3.4)", () => {
  it("checkTierIsGreen", () => {
    expect(checkTierIsGreen("green")).toBe(true);
    expect(checkTierIsGreen("yellow")).toBe(false);
    expect(checkTierIsGreen("red")).toBe(false);
    expect(checkTierIsGreen(undefined)).toBe(false);
  });

  it("checkMatchBandInBand -- fails CLOSED on undefined, the deliberate opposite of the display-filter's resolveDisplayBand()", () => {
    expect(checkMatchBandInBand("in-band")).toBe(true);
    expect(checkMatchBandInBand("near-band")).toBe(false);
    expect(checkMatchBandInBand("out-of-band")).toBe(false);
    expect(checkMatchBandInBand(undefined)).toBe(false);
  });

  it("checkDraftContentSanity rejects empty/too-short/refusal-shaped content", () => {
    expect(checkDraftContentSanity({ coverText: "", answers: {} })).toBe(false);
    expect(checkDraftContentSanity({ coverText: "too short", answers: {} })).toBe(false);
    expect(checkDraftContentSanity({ coverText: "I cannot help with generating this kind of content.", answers: {} })).toBe(false);
    expect(
      checkDraftContentSanity({
        coverText: "Dear hiring team, I'm excited to apply for this fractional CTO role given my background.",
        answers: {},
      }),
    ).toBe(true);
  });

  it("checkGigIsFresh requires status 'new' and no unavailableSince", () => {
    expect(checkGigIsFresh("new", null)).toBe(true);
    expect(checkGigIsFresh("applied", null)).toBe(false);
    expect(checkGigIsFresh("new", "2026-01-01T00:00:00.000Z")).toBe(false);
  });

  it("checkDailyCapNotExceeded", () => {
    const gigKey = seedApprovedDraft2("src-a", "1", "green");
    const rule = { sourceId: "src-a", tier: "green" as const, enabled: true, minApprovals: 1, dailyCap: 2 };

    expect(checkDailyCapNotExceeded("src-a", rule, "2026-01-02T00:00:00.000Z", { db })).toBe(true);
    expect(dailyFireCount("src-a", "2026-01-02T00:00:00.000Z", { db })).toBe(0);

    recordFired(gigKey, "2026-01-01T12:00:00.000Z");
    recordFired(gigKey, "2026-01-01T13:00:00.000Z");

    expect(dailyFireCount("src-a", "2026-01-02T00:00:00.000Z", { db })).toBe(2);
    expect(checkDailyCapNotExceeded("src-a", rule, "2026-01-02T00:00:00.000Z", { db })).toBe(false);
    // Outside the trailing-24h window from the earlier fires -- cap resets.
    expect(checkDailyCapNotExceeded("src-a", rule, "2026-01-03T00:00:00.000Z", { db })).toBe(true);
  });

  function seedApprovedDraft2(sourceId: string, externalId: string, tier: Gig["tier"]): string {
    seedApprovedDraft(sourceId, externalId, tier);
    return `${sourceId}:${externalId}`;
  }

  function recordFired(gigKey: string, at: string): void {
    db.prepare(
      `INSERT INTO autofire_decisions (gig_key, decided_at, fired, reasons, rule_snapshot) VALUES (?, ?, 1, '["fired"]', NULL)`,
    ).run(gigKey, at);
  }
});

describe("evaluateAutoFire — the full decision tree, every stop point independently tested", () => {
  const GOOD_CONTENT = {
    coverText: "Dear hiring team, I'm excited to apply for this fractional CTO role given my background.",
    answers: {},
  };
  const ADAPTER_ID = "test-evaluate-autofire-adapter";
  const CONFIG: Config = {
    autoFire: { rules: [{ sourceId: "src-a", tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }] },
  } as Config;

  registerSubmitAdapter({ id: ADAPTER_ID, submit: async () => ({ ok: true, confirmation: "n/a" }) });

  function seedReadyGig(sourceId: string, externalId: string): string {
    // rate-band-match-quality epic: matchBand: "in-band" alongside tier --
    // checkMatchBandInBand() fails closed on undefined, so every "step 5:
    // X check fails"/"step 6: all pass" test below (which isolates ONE
    // specific failure at a time) needs this gig to genuinely be in-band,
    // same as it's genuinely tier: "green".
    recordScan([{ sourceId, gigs: [makeGig({ sourceId, externalId, tier: "green", matchBand: "in-band" })] }], { db, now: "2026-01-01T00:00:00.000Z" });
    return `${sourceId}:${externalId}`;
  }

  it("step 0: kill switch stops everything, regardless of a passing pair", () => {
    const gigKey = seedReadyGig(ADAPTER_ID, "1");
    seedApprovedDraft(ADAPTER_ID, "0a", "green");
    seedApprovedDraft(ADAPTER_ID, "0b", "green");
    seedApprovedDraft(ADAPTER_ID, "0c", "green");
    saveDraft(gigKey, GOOD_CONTENT, { db, now: "2026-01-01T00:00:00.000Z" });
    const config: Config = {
      autoFire: { killSwitch: true, rules: [{ sourceId: ADAPTER_ID, tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }] },
    } as Config;

    const decision = evaluateAutoFire(gigKey, config, { db, now: "2026-01-02T00:00:00.000Z" });

    expect(decision.fired).toBe(false);
    expect(decision.reasons).toEqual(["kill switch enabled"]);
    expect(listAutoFireDecisions(gigKey, { db })).toHaveLength(1);
  });

  it("no such gig", () => {
    const decision = evaluateAutoFire("nonexistent:1", CONFIG, { db, now: "2026-01-01T00:00:00.000Z" });
    expect(decision.fired).toBe(false);
    expect(decision.reasons[0]).toMatch(/no such gig/);
  });

  it("step 1: no configured rule for this (source, tier) pair", () => {
    const gigKey = seedReadyGig("no-rule-source", "1");
    const decision = evaluateAutoFire(gigKey, CONFIG, { db, now: "2026-01-01T00:00:00.000Z" });
    expect(decision.fired).toBe(false);
    expect(decision.reasons[0]).toMatch(/no auto-fire rule configured/);
  });

  it("step 2: rule disabled", () => {
    const gigKey = seedReadyGig("src-a", "1");
    const config: Config = {
      autoFire: { rules: [{ sourceId: "src-a", tier: "green", enabled: false, minApprovals: 1, dailyCap: 3 }] },
    } as Config;
    const decision = evaluateAutoFire(gigKey, config, { db, now: "2026-01-01T00:00:00.000Z" });
    expect(decision.fired).toBe(false);
    expect(decision.reasons).toEqual(["auto-fire rule disabled for this (source, tier) pair"]);
  });

  it("step 3: not yet graduated", () => {
    const gigKey = seedReadyGig("src-a", "1");
    const decision = evaluateAutoFire(gigKey, CONFIG, { db, now: "2026-01-01T00:00:00.000Z" });
    expect(decision.fired).toBe(false);
    expect(decision.reasons[0]).toMatch(/not yet graduated: 0\/3 approvals/);
  });

  it("step 4: graduated + enabled but no SubmitAdapter registered for the source", () => {
    seedApprovedDraft("src-no-adapter", "a", "green");
    seedApprovedDraft("src-no-adapter", "b", "green");
    seedApprovedDraft("src-no-adapter", "c", "green");
    const gigKey = seedReadyGig("src-no-adapter", "1");
    const config: Config = {
      autoFire: { rules: [{ sourceId: "src-no-adapter", tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }] },
    } as Config;

    const decision = evaluateAutoFire(gigKey, config, { db, now: "2026-01-01T00:00:00.000Z" });
    expect(decision.fired).toBe(false);
    expect(decision.reasons[0]).toMatch(/no SubmitAdapter registered/);
  });

  it("step 5: tier check fails even when the pair's own rule targets a non-green tier (stricter-than-the-rule safety net)", () => {
    const config: Config = {
      autoFire: { rules: [{ sourceId: ADAPTER_ID, tier: "yellow", enabled: true, minApprovals: 1, dailyCap: 3 }] },
    } as Config;
    recordScan([{ sourceId: ADAPTER_ID, gigs: [makeGig({ sourceId: ADAPTER_ID, externalId: "yellow-1", tier: "yellow" })] }], {
      db,
      now: "2026-01-01T00:00:00.000Z",
    });
    const gigKey = `${ADAPTER_ID}:yellow-1`;
    saveDraft(gigKey, GOOD_CONTENT, { db, now: "2026-01-01T00:00:00.000Z" });
    setDraftStatus(gigKey, "approved", { db, now: "2026-01-01T00:00:00.000Z" }); // graduates it (minApprovals: 1)

    const decision = evaluateAutoFire(gigKey, config, { db, now: "2026-01-02T00:00:00.000Z" });
    expect(decision.fired).toBe(false);
    expect(decision.reasons.some((r) => r.includes("tier check failed"))).toBe(true);
  });

  it("step 5: match-band check fails for a green-tier gig that's out-of-band (the real, live-confirmed trigger for this epic)", () => {
    seedApprovedDraft(ADAPTER_ID, "mb-a", "green");
    seedApprovedDraft(ADAPTER_ID, "mb-b", "green");
    seedApprovedDraft(ADAPTER_ID, "mb-c", "green");
    recordScan([{ sourceId: ADAPTER_ID, gigs: [makeGig({ sourceId: ADAPTER_ID, externalId: "mb-1", tier: "green", matchBand: "out-of-band" })] }], {
      db,
      now: "2026-01-01T00:00:00.000Z",
    });
    const gigKey = `${ADAPTER_ID}:mb-1`;
    saveDraft(gigKey, GOOD_CONTENT, { db, now: "2026-01-01T00:00:00.000Z" });
    const config: Config = {
      autoFire: { rules: [{ sourceId: ADAPTER_ID, tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }] },
    } as Config;

    const decision = evaluateAutoFire(gigKey, config, { db, now: "2026-01-02T00:00:00.000Z" });
    expect(decision.fired).toBe(false);
    expect(decision.reasons.some((r) => r.includes("match-band check failed"))).toBe(true);
  });

  it("step 5: match-band check fails CLOSED for a green-tier gig scanned before this epic shipped (no matchBand at all)", () => {
    seedApprovedDraft(ADAPTER_ID, "nb-a", "green");
    seedApprovedDraft(ADAPTER_ID, "nb-b", "green");
    seedApprovedDraft(ADAPTER_ID, "nb-c", "green");
    // No matchBand field at all -- makeGig()'s default shape, mirroring a
    // pre-epic gig exactly.
    recordScan([{ sourceId: ADAPTER_ID, gigs: [makeGig({ sourceId: ADAPTER_ID, externalId: "nb-1", tier: "green" })] }], {
      db,
      now: "2026-01-01T00:00:00.000Z",
    });
    const gigKey = `${ADAPTER_ID}:nb-1`;
    saveDraft(gigKey, GOOD_CONTENT, { db, now: "2026-01-01T00:00:00.000Z" });
    const config: Config = {
      autoFire: { rules: [{ sourceId: ADAPTER_ID, tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }] },
    } as Config;

    const decision = evaluateAutoFire(gigKey, config, { db, now: "2026-01-02T00:00:00.000Z" });
    expect(decision.fired).toBe(false);
    expect(decision.reasons.some((r) => r.includes("match-band check failed"))).toBe(true);
  });

  it("step 5: no draft exists for the gig", () => {
    seedApprovedDraft(ADAPTER_ID, "nd-a", "green");
    seedApprovedDraft(ADAPTER_ID, "nd-b", "green");
    seedApprovedDraft(ADAPTER_ID, "nd-c", "green");
    const gigKey = seedReadyGig(ADAPTER_ID, "no-draft-1");
    const config: Config = {
      autoFire: { rules: [{ sourceId: ADAPTER_ID, tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }] },
    } as Config;

    const decision = evaluateAutoFire(gigKey, config, { db, now: "2026-01-01T00:00:00.000Z" });
    expect(decision.fired).toBe(false);
    expect(decision.reasons).toContain("no draft exists for this gig");
  });

  it("step 5: draft content sanity check fails", () => {
    seedApprovedDraft(ADAPTER_ID, "cs-a", "green");
    seedApprovedDraft(ADAPTER_ID, "cs-b", "green");
    seedApprovedDraft(ADAPTER_ID, "cs-c", "green");
    const gigKey = seedReadyGig(ADAPTER_ID, "cs-1");
    saveDraft(gigKey, { coverText: "too short", answers: {} }, { db, now: "2026-01-01T00:00:00.000Z" });
    const config: Config = {
      autoFire: { rules: [{ sourceId: ADAPTER_ID, tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }] },
    } as Config;

    const decision = evaluateAutoFire(gigKey, config, { db, now: "2026-01-01T00:00:00.000Z" });
    expect(decision.fired).toBe(false);
    expect(decision.reasons.some((r) => r.includes("content sanity check failed"))).toBe(true);
  });

  it("step 5: freshness check fails for a gig that's already been marked applied", () => {
    seedApprovedDraft(ADAPTER_ID, "fr-a", "green");
    seedApprovedDraft(ADAPTER_ID, "fr-b", "green");
    seedApprovedDraft(ADAPTER_ID, "fr-c", "green");
    const gigKey = seedReadyGig(ADAPTER_ID, "fr-1");
    saveDraft(gigKey, GOOD_CONTENT, { db, now: "2026-01-01T00:00:00.000Z" });
    setStatus(gigKey, "applied", { db });
    const config: Config = {
      autoFire: { rules: [{ sourceId: ADAPTER_ID, tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }] },
    } as Config;

    const decision = evaluateAutoFire(gigKey, config, { db, now: "2026-01-01T00:00:00.000Z" });
    expect(decision.fired).toBe(false);
    expect(decision.reasons.some((r) => r.includes("freshness check failed"))).toBe(true);
  });

  it("step 5: daily cap check fails", () => {
    seedApprovedDraft(ADAPTER_ID, "dc-a", "green");
    seedApprovedDraft(ADAPTER_ID, "dc-b", "green");
    seedApprovedDraft(ADAPTER_ID, "dc-c", "green");
    const gigKey = seedReadyGig(ADAPTER_ID, "dc-1");
    saveDraft(gigKey, GOOD_CONTENT, { db, now: "2026-01-01T00:00:00.000Z" });
    const config: Config = {
      autoFire: { rules: [{ sourceId: ADAPTER_ID, tier: "green", enabled: true, minApprovals: 3, dailyCap: 1 }] },
    } as Config;
    db.prepare(
      `INSERT INTO autofire_decisions (gig_key, decided_at, fired, reasons, rule_snapshot) VALUES (?, ?, 1, '["fired"]', NULL)`,
    ).run(gigKey, "2026-01-01T00:00:00.000Z");

    const decision = evaluateAutoFire(gigKey, config, { db, now: "2026-01-01T06:00:00.000Z" });
    expect(decision.fired).toBe(false);
    expect(decision.reasons.some((r) => r.includes("daily fire cap reached"))).toBe(true);
  });

  it("step 6: every check passes -- decision says fire, rule snapshot attached, persisted", () => {
    seedApprovedDraft(ADAPTER_ID, "ok-a", "green");
    seedApprovedDraft(ADAPTER_ID, "ok-b", "green");
    seedApprovedDraft(ADAPTER_ID, "ok-c", "green");
    const gigKey = seedReadyGig(ADAPTER_ID, "ok-1");
    saveDraft(gigKey, GOOD_CONTENT, { db, now: "2026-01-01T00:00:00.000Z" });
    const rule = { sourceId: ADAPTER_ID, tier: "green" as const, enabled: true, minApprovals: 3, dailyCap: 3 };
    const config: Config = { autoFire: { rules: [rule] } } as Config;

    const decision = evaluateAutoFire(gigKey, config, { db, now: "2026-01-02T00:00:00.000Z" });

    expect(decision.fired).toBe(true);
    expect(decision.reasons).toEqual(["all checks passed"]);
    expect(decision.ruleSnapshot).toEqual(rule);
    const persisted = listAutoFireDecisions(gigKey, { db });
    expect(persisted[0]).toEqual(decision);
  });

  it("every evaluateAutoFire() call persists exactly one autofire_decisions row, whatever the outcome", () => {
    const gigKey = seedReadyGig("no-rule-source-2", "1");
    evaluateAutoFire(gigKey, CONFIG, { db, now: "2026-01-01T00:00:00.000Z" });
    evaluateAutoFire(gigKey, CONFIG, { db, now: "2026-01-02T00:00:00.000Z" });
    expect(listAutoFireDecisions(gigKey, { db })).toHaveLength(2);
  });
});
