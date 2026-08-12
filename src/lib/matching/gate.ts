import type { Gig, Needs, Profile, MatchResult } from "../types.js";

/**
 * Deterministic, explainable GO/NO-GO gate. Every gig gets a pass/fail plus a
 * reason for each rule checked — so the output is a shortlist AND a record of
 * why each rejection happened (the whole point of the original gig-radar).
 *
 * Ported from the private gig-radar `gate.mjs`:
 *   hours <= max (or <= maxAtHighRate when rate >= highRate) ·
 *   rate >= minRate (>= highRate for the high-rate hours tier) ·
 *   fresh stage · not contract-to-hire · role/skill fit.
 *
 * Pure function — no I/O, fully unit-testable.
 */
export function gate(gig: Gig, needs: Needs, profile: Profile): MatchResult {
  const reasons: string[] = [];
  let pass = true;
  const fail = (msg: string) => { pass = false; reasons.push("✗ " + msg); };
  const ok = (msg: string) => reasons.push("✓ " + msg);

  // ---- rate ----
  const hourly = normalizeHourly(gig);
  if (hourly == null) {
    ok("rate not published — passing rate check, confirm on the call");
  } else if (hourly >= needs.highRate) {
    ok(`rate $${hourly}/hr ≥ high-rate $${needs.highRate}`);
  } else if (hourly >= needs.minRate) {
    ok(`rate $${hourly}/hr ≥ floor $${needs.minRate}`);
  } else {
    fail(`rate $${hourly}/hr below floor $${needs.minRate}`);
  }

  // ---- hours (coupled to rate: high rate unlocks more hours) ----
  if (gig.weeklyHours != null) {
    const cap = (hourly != null && hourly >= needs.highRate)
      ? needs.maxHoursAtHighRate
      : needs.maxHours;
    if (gig.weeklyHours <= cap) ok(`${gig.weeklyHours} hrs/wk ≤ cap ${cap}`);
    else fail(`${gig.weeklyHours} hrs/wk over cap ${cap}${hourly != null && hourly < needs.highRate ? ` (raise-rate to unlock ${needs.maxHoursAtHighRate})` : ""}`);
  }

  // ---- contract-to-hire ----
  if (!needs.allowContractToHire && gig.contractToHire) fail("contract-to-hire (excluded)");

  // ---- stage freshness ----
  if (needs.freshStageOnly && gig.stage && gig.stage !== "fresh" && gig.stage !== "unknown") {
    fail(`stage "${gig.stage}" not fresh`);
  }

  // ---- remote ----
  if (needs.remoteOnly && gig.remote === false) fail("not remote");

  // ---- fit ----
  const fit = fitScore(gig, profile);
  if (fit > 0) ok(`role/skill fit (${Math.round(fit * 100)}%)`);
  else fail("no role/skill keyword match");
  if (fit === 0) pass = false;

  return { gig, pass, reasons, score: pass ? scoreOf(gig, needs, fit) : 0 };
}

/** Convert whatever rate a source gives into an hourly number, or null. */
function normalizeHourly(gig: Gig): number | null {
  const r = gig.rate;
  if (!r) return null;
  const val = r.min ?? r.max;
  if (val == null) return null;
  if (r.unit === "hour") return val;
  if (r.unit === "month" && gig.weeklyHours) return Math.round(val / (gig.weeklyHours * 4.33));
  // yearly / unknown -> can't compare cleanly; treat as unknown
  return null;
}

/** Keyword overlap between the gig and the user's roles+skills. 0..1. */
function fitScore(gig: Gig, profile: Profile): number {
  const hay = `${gig.title} ${gig.description ?? ""}`.toLowerCase();
  const needles = [...profile.roles, ...profile.skills].map((s) => s.toLowerCase());
  if (needles.length === 0) return 1; // no filter set => everything "fits"
  const hits = needles.filter((n) => n.length > 2 && hay.includes(n)).length;
  return Math.min(1, hits / Math.max(3, Math.ceil(needles.length / 3)));
}

/** Rank passers: reward higher rate, fewer hours, fresher, better fit. */
function scoreOf(gig: Gig, needs: Needs, fit: number): number {
  const hourly = normalizeHourly(gig) ?? needs.minRate;
  const rateScore = Math.min(1, hourly / (needs.highRate * 1.5));
  const hoursScore = gig.weeklyHours ? Math.max(0, 1 - gig.weeklyHours / needs.maxHoursAtHighRate) : 0.5;
  const freshScore = gig.stage === "fresh" ? 1 : 0.6;
  return Number((0.45 * rateScore + 0.25 * fit + 0.2 * hoursScore + 0.1 * freshScore).toFixed(3));
}
