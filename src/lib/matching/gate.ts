import type { EngagementProfile, EngagementType, Gig, Needs, Profile, MatchResult } from "../types.js";

/**
 * Deterministic, explainable GO/NO-GO gate. Every gig gets a pass/fail plus a
 * reason for each rule checked — so the output is a shortlist AND a record of
 * why each rejection happened (the whole point of the original gig-radar).
 *
 * Ported from the private gig-radar `gate.mjs`, then extended by the
 * engagement-profiles story: hours <= max (or <= maxAtHighRate when rate >=
 * highRate) and rate >= minRate are now evaluated PER `EngagementProfile`,
 * not against one flat set of Needs numbers — see effectiveEngagementType()
 * and matchProfiles() below. A gig can clear more than one profile at once
 * (MatchResult.matchedProfiles lists every one it cleared, not just the
 * first) — e.g. a gig could satisfy both a "Fractional/contract" profile
 * and a separate "Contract-to-hire" profile.
 *
 * Pure function — no I/O, fully unit-testable.
 */
export function gate(gig: Gig, needs: Needs, profile: Profile): MatchResult {
  const reasons: string[] = [];
  let pass = true;
  const fail = (msg: string) => { pass = false; reasons.push("✗ " + msg); };
  const ok = (msg: string) => reasons.push("✓ " + msg);

  // ---- engagement type + rate + hours (per-profile) ----
  const { matched, applicable, profileReasons } = matchProfiles(gig, needs.engagementProfiles);
  reasons.push(...profileReasons);
  if (matched.length === 0) {
    if (applicable.length === 0) {
      const type = effectiveEngagementType(gig);
      fail(
        type
          ? `engagement type "${type}" not accepted by any configured profile`
          : "no configured profile applies (no hourly profile configured, and this gig's engagement type couldn't be determined)",
      );
    } else {
      fail("did not clear any applicable profile's rate/hours threshold");
    }
  } else {
    ok(`matched profile${matched.length > 1 ? "s" : ""}: ${matched.map((m) => m.profile.label).join(", ")}`);
  }
  const matchedProfiles = matched.map((m) => m.profile.id);

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

  return {
    gig,
    pass,
    reasons,
    score: pass ? scoreOf(gig, matched, fit) : 0,
    matchedProfiles,
  };
}

/**
 * A gig's real engagement type, from the strongest available signal:
 * 1. `gig.contractToHire === true` -> "contract-to-hire" (takes priority
 *    over `employmentType` — a CTH listing IS a contract listing, but the
 *    CTH-specific signal is more precise and this project has always
 *    treated it as its own distinct thing, pre-dating this story).
 * 2. `gig.employmentType`, when a source set it explicitly (e.g. BuiltIn's
 *    real JobPosting JSON-LD `employmentType: "FULL_TIME"`).
 * 3. `gig.rate.unit === "year"` -> inferred "full-time". A $/year rate with
 *    no other signal is a strong real-world tell (confirmed against 74 real
 *    tracked listings, all genuinely full-time W2 posts).
 * 4. Otherwise `undefined` — no signal, handled permissively by
 *    matchProfiles() (falls back to hourly profiles, matching this
 *    project's pre-existing behavior for the common unlabeled case).
 */
export function effectiveEngagementType(gig: Gig): EngagementType | undefined {
  if (gig.contractToHire === true) return "contract-to-hire";
  if (gig.employmentType) return gig.employmentType;
  if (gig.rate?.unit === "year") return "full-time";
  return undefined;
}

interface ProfileMatch {
  profile: EngagementProfile;
  rate: number | null;
}

/**
 * Checks `gig` against every profile it's applicable to (its effective
 * engagement type is in `profile.types`, OR the type is undetermined and
 * the profile is hourly-denominated — see effectiveEngagementType() case 4)
 * and returns which of those applicable profiles it actually cleared
 * (rate + hours), plus one human-readable reason line per applicable
 * profile tried (pass or fail) for the caller to fold into MatchResult.reasons.
 */
function matchProfiles(
  gig: Gig,
  profiles: EngagementProfile[],
): { matched: ProfileMatch[]; applicable: EngagementProfile[]; profileReasons: string[] } {
  const type = effectiveEngagementType(gig);
  const applicable = profiles.filter((p) => (type ? p.types.includes(type) : p.rateUnit === "hour"));

  const matched: ProfileMatch[] = [];
  const profileReasons: string[] = [];

  for (const p of applicable) {
    const rate = normalizeRate(gig, p.rateUnit);
    const unitLabel = p.rateUnit === "hour" ? "/hr" : "/yr";

    if (rate == null) {
      matched.push({ profile: p, rate: null });
      profileReasons.push(`✓ [${p.label}] rate not published — passing, confirm on the call`);
      continue;
    }

    const clearsRate = rate >= p.minRate;
    if (!clearsRate) {
      profileReasons.push(`✗ [${p.label}] $${rate.toLocaleString()}${unitLabel} below floor $${p.minRate.toLocaleString()}${unitLabel}`);
      continue;
    }

    // EngagementProfileSchema's .refine() guarantees maxHours/
    // maxHoursAtHighRate are set whenever rateUnit === "hour" — the `!`s
    // below encode that schema-level invariant, not an unchecked guess.
    if (p.rateUnit === "hour" && gig.weeklyHours != null) {
      const cap = rate >= p.highRate ? p.maxHoursAtHighRate! : p.maxHours!;
      if (gig.weeklyHours > cap) {
        profileReasons.push(
          `✗ [${p.label}] ${gig.weeklyHours} hrs/wk over cap ${cap}` +
            (rate < p.highRate ? ` (raise-rate to unlock ${p.maxHoursAtHighRate})` : ""),
        );
        continue;
      }
    }

    matched.push({ profile: p, rate });
    const tierLabel = rate >= p.highRate ? "high-rate" : "floor";
    profileReasons.push(`✓ [${p.label}] $${rate.toLocaleString()}${unitLabel} ≥ ${tierLabel} $${(rate >= p.highRate ? p.highRate : p.minRate).toLocaleString()}${unitLabel}`);
  }

  return { matched, applicable, profileReasons };
}

/** Convert whatever rate a source gives into `targetUnit` ("hour" or "year"), or null if it can't be compared cleanly. Never cross-converts hour<->year (too speculative — see this project's standing "never fabricate" posture). */
function normalizeRate(gig: Gig, targetUnit: "hour" | "year"): number | null {
  const r = gig.rate;
  if (!r) return null;
  const val = r.min ?? r.max;
  if (val == null) return null;
  if (targetUnit === "hour") {
    if (r.unit === "hour") return val;
    if (r.unit === "month" && gig.weeklyHours) return Math.round(val / (gig.weeklyHours * 4.33));
    return null;
  }
  // targetUnit === "year"
  if (r.unit === "year") return val;
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

/**
 * Rank passers: reward higher rate (relative to whichever profile it
 * matched with the best clearance), fewer hours, fresher, better fit.
 * Only ever called with `pass === true` (see gate()), which requires
 * `matched.length > 0` — the `matched[0]` lookup is safe in practice; the
 * 0.5 mid-score fallback below only guards TypeScript's static array-index
 * typing, not a real reachable case.
 */
function scoreOf(gig: Gig, matched: ProfileMatch[], fit: number): number {
  const first = matched[0];
  if (!first) return Number((0.25 * fit + 0.1 * (gig.stage === "fresh" ? 1 : 0.6) + 0.35).toFixed(3));
  const { profile: best, rate: matchedRate } = first;
  const rate = matchedRate ?? normalizeRate(gig, best.rateUnit) ?? best.minRate;
  const rateScore = Math.min(1, rate / (best.highRate * 1.5));
  // best.maxHoursAtHighRate! -- see matchProfiles()'s identical comment on this schema-level invariant.
  const hoursScore =
    best.rateUnit === "hour" && gig.weeklyHours ? Math.max(0, 1 - gig.weeklyHours / best.maxHoursAtHighRate!) : 0.5;
  const freshScore = gig.stage === "fresh" ? 1 : 0.6;
  return Number((0.45 * rateScore + 0.25 * fit + 0.2 * hoursScore + 0.1 * freshScore).toFixed(3));
}
