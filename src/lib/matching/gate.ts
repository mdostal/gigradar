import type { EngagementProfile, EngagementType, Gig, Needs, Profile, MatchResult, RoleAreaConfig } from "../types.js";
import { tier } from "./tiering.js";

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
 * gate-fit-check-too-strict epic (gate-uses-role-area-tier-for-fit story):
 * the "fit" check below (fitScore(), literal phrase-overlap between
 * Profile.roles/skills and the gig's title+description) used to be the
 * ONLY way a gig could clear the role/skill fit requirement — but that
 * free text was never designed to be the sole source of truth for role
 * relevance, and a real gig can be a correct match without literally
 * sharing a phrase with it (e.g. "Chief Technology Officer" vs. the
 * user's own "Fractional CTO"). The optional `roleArea` parameter lets a
 * caller also pass a group's own, already-configured, already-tested
 * `RoleAreaConfig` (matching/tiering.ts) as a second, independent way to
 * clear the SAME check: fit only hard-fails when the phrase-overlap check
 * ALSO finds nothing AND (no roleArea was given OR that roleArea's own
 * tier() call doesn't come back "green"). Deliberately NOT `!== "red"` —
 * tier() returns YELLOW for a group with no roleArea keywords configured
 * at all (EMPTY_ROLE_AREA_CONFIG) just as readily as for a genuinely
 * unrecognized gig, so treating YELLOW as a pass here would rubber-stamp
 * every gig for any group that hasn't filled in roleArea keywords,
 * silently defeating the fit check for that group. Requiring an ACTIVE,
 * POSITIVE "green" match (a real coreTitles/keywords hit) keeps this
 * purely additive — an OR against the existing check — so nothing that
 * passed before can newly fail, and a group with no roleArea configured
 * gets byte-identical old behavior (no escape hatch at all); see
 * design-discussion.md in gate-fit-check-too-strict for the full
 * root-cause writeup.
 *
 * Pure function — no I/O, fully unit-testable.
 */
export function gate(gig: Gig, needs: Needs, profile: Profile, roleArea?: RoleAreaConfig): MatchResult {
  const { pass, reasons, matched, fit } = evaluateGate(gig, needs, profile, roleArea);
  return {
    gig,
    pass,
    reasons,
    score: pass ? scoreOf(gig, matched, fit) : 0,
    matchedProfiles: matched.map((m) => m.profile.id),
  };
}

/**
 * gate-reasons-in-dashboard story. One structured, per-rule verdict the
 * dashboard renders (gig detail panel's "Why this gig passed/failed"
 * section, the All Gigs ⚠ tooltip's failed-rule list). Produced by the SAME
 * evaluateGate() pass gate() itself uses -- each check is pushed in the
 * exact branch that pushes gate()'s own legacy `reasons` string, so the
 * structured view can never disagree with the real verdict.
 *
 * `id` is stable per rule kind (`engagement-type`, `profile:<profile id>`,
 * `fresh-stage`, `remote`, `role-fit`, `role-area`); `label` is the
 * user-facing rule name, taken from the user's own config where one exists
 * (an engagement profile's own label). Which rules appear at all is driven
 * by the config passed in: one row per configured engagement profile (never
 * a hardcoded list), fresh-stage/remote only when that Needs flag is on,
 * role-area only when a RoleAreaConfig was passed.
 *
 * `blocking` is true when this rule's `fail` alone decides the gate verdict
 * (engagement-type, fresh-stage, remote, role-fit, and -- only when NO
 * profile cleared -- each applicable profile row). It is false for a
 * profile row that failed while another profile cleared, and for the
 * role-area tier (a classification shown next to the gate, never part of
 * its pass/fail -- see tiering.ts).
 */
export type GateRuleOutcome = "pass" | "fail" | "skipped" | "info";

export interface GateRuleCheck {
  id: string;
  label: string;
  outcome: GateRuleOutcome;
  reason: string;
  blocking: boolean;
}

export interface GateExplanation {
  pass: boolean;
  rules: GateRuleCheck[];
}

/** Structured, per-rule explanation of gate()'s verdict -- see GateRuleCheck. Pure. */
export function explainGate(gig: Gig, needs: Needs, profile: Profile, roleArea?: RoleAreaConfig): GateExplanation {
  const { pass, rules } = evaluateGate(gig, needs, profile, roleArea);
  return { pass, rules };
}

function evaluateGate(
  gig: Gig,
  needs: Needs,
  profile: Profile,
  roleArea?: RoleAreaConfig,
): { pass: boolean; reasons: string[]; rules: GateRuleCheck[]; matched: ProfileMatch[]; fit: number } {
  const reasons: string[] = [];
  const rules: GateRuleCheck[] = [];
  let pass = true;
  const fail = (msg: string) => { pass = false; reasons.push("✗ " + msg); };
  const ok = (msg: string) => reasons.push("✓ " + msg);
  const rule = (id: string, label: string, outcome: GateRuleOutcome, reason: string, blocking: boolean) =>
    rules.push({ id, label, outcome, reason, blocking });

  // ---- engagement type + rate + hours (per-profile) ----
  const { matched, applicable, profileReasons, profileOutcomes } = matchProfiles(gig, needs.engagementProfiles);
  reasons.push(...profileReasons);
  const type = effectiveEngagementType(gig);
  const acceptedTypes = [...new Set(needs.engagementProfiles.flatMap((p) => p.types))];
  if (matched.length === 0) {
    if (applicable.length === 0) {
      fail(
        type
          ? `engagement type "${type}" not accepted by any configured profile`
          : "no configured profile applies (no hourly profile configured, and this gig's engagement type couldn't be determined)",
      );
      rule(
        "engagement-type",
        "Engagement type",
        "fail",
        type
          ? `${type} is excluded — none of your profiles accept it${acceptedTypes.length ? ` (accepted: ${acceptedTypes.join(", ")})` : ""}`
          : "engagement type isn't stated and you have no hourly profile to check it against",
        true,
      );
    } else {
      fail("did not clear any applicable profile's rate/hours threshold");
      rule("engagement-type", "Engagement type", "pass", engagementTypePassReason(type, applicable), false);
    }
  } else {
    ok(`matched profile${matched.length > 1 ? "s" : ""}: ${matched.map((m) => m.profile.label).join(", ")}`);
    rule("engagement-type", "Engagement type", "pass", engagementTypePassReason(type, applicable), false);
  }
  const anyCleared = matched.length > 0;
  for (const p of needs.engagementProfiles) {
    const o = profileOutcomes.find((x) => x.profile === p);
    const id = `profile:${p.id}`;
    if (!o) {
      rule(id, p.label, "skipped", notApplicableReason(p, type), false);
    } else if (o.kind === "rate-unpublished") {
      rule(id, p.label, "pass", "rate not published — passing, confirm on the call", false);
    } else if (o.kind === "below-floor") {
      rule(id, p.label, "fail", `${money(o.rate, p)} is below your ${money(p.minRate, p)} floor`, !anyCleared);
    } else if (o.kind === "over-hours-cap") {
      rule(
        id,
        p.label,
        "fail",
        `${o.hours} hrs/wk is over your ${o.cap} hrs/wk cap` +
          (o.rate < p.highRate ? ` (at ${money(p.highRate, p)}+ the cap rises to ${p.maxHoursAtHighRate})` : ""),
        !anyCleared,
      );
    } else {
      const atHigh = o.rate >= p.highRate;
      rule(
        id,
        p.label,
        "pass",
        `${money(o.rate, p)} clears your ${money(atHigh ? p.highRate : p.minRate, p)} ${atHigh ? "high-rate tier" : "floor"}` +
          (o.cap !== undefined && gig.weeklyHours != null ? `; ${gig.weeklyHours} hrs/wk within your ${o.cap} hrs/wk cap` : ""),
        false,
      );
    }
  }

  // ---- stage freshness ----
  if (needs.freshStageOnly && gig.stage && gig.stage !== "fresh" && gig.stage !== "unknown") {
    fail(`stage "${gig.stage}" not fresh`);
    rule("fresh-stage", "Fresh listings only", "fail", `listing stage is "${gig.stage}" — you only accept fresh listings`, true);
  } else if (needs.freshStageOnly) {
    rule("fresh-stage", "Fresh listings only", "pass", gig.stage === "fresh" ? "listing is fresh" : "listing stage not stated — not rejected", false);
  }

  // ---- remote ----
  if (needs.remoteOnly && gig.remote === false) {
    fail("not remote");
    rule("remote", "Remote only", "fail", "listing is not remote — you require remote", true);
  } else if (needs.remoteOnly) {
    rule("remote", "Remote only", "pass", gig.remote === true ? "listing is remote" : "remote not stated — not rejected", false);
  }

  // ---- fit ----
  const { score: fit, hits } = fitMatch(gig, profile);
  const roleAreaTier = roleArea ? tier(gig, roleArea) : undefined;
  if (fit > 0) {
    ok(`role/skill fit (${Math.round(fit * 100)}%)`);
    rule(
      "role-fit",
      "Role/skill fit",
      "pass",
      hits.length === 0
        ? "no roles/skills configured — every gig fits"
        : `matches your ${hits.map((h) => `"${h}"`).join(", ")} (${Math.round(fit * 100)}%)`,
      false,
    );
  } else {
    if (roleAreaTier && roleAreaTier.tier === "green") {
      ok(`role/skill fit backed by this group's own role-area tier (green)`);
      rule("role-fit", "Role/skill fit", "pass", "no role/skill phrase in the listing, but its role-area tier is green", false);
    } else {
      fail("no role/skill keyword match");
      rule("role-fit", "Role/skill fit", "fail", "none of your roles/skills appear in the title or description", true);
    }
  }

  // ---- role-area tier (informational, never part of the verdict) ----
  if (roleAreaTier && roleArea) {
    const m = roleAreaTier.match;
    if (m?.kind === "redKeyword") {
      rule("role-area", "Role area", "fail", `title matches your red keyword "${m.term}" (tier only — doesn't block the gate)`, false);
    } else if (m?.kind === "coreTitle") {
      rule("role-area", "Role area", "pass", `title matches your core title "${m.term}"`, false);
    } else if (m?.kind === "keyword") {
      rule("role-area", "Role area", "pass", `matches your keyword "${m.term}"`, false);
    } else {
      rule("role-area", "Role area", "info", "no core title, red keyword, or keyword matched — yellow, surfaced for review", false);
    }
  }

  return { pass, reasons, rules, matched, fit };
}

function money(n: number, p: EngagementProfile): string {
  return `$${n.toLocaleString("en-US")}${p.rateUnit === "hour" ? "/hr" : "/yr"}`;
}

function engagementTypePassReason(type: EngagementType | undefined, applicable: EngagementProfile[]): string {
  const labels = applicable.map((p) => p.label).join(", ");
  return type ? `${type} is accepted by: ${labels}` : `engagement type not stated — checked against your hourly profiles: ${labels}`;
}

function notApplicableReason(p: EngagementProfile, type: EngagementType | undefined): string {
  return type
    ? `covers ${p.types.join(", ")} only; this gig is ${type}`
    : "salaried profile; this gig's engagement type isn't stated, so only hourly profiles are checked";
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

/**
 * Exported (rate-band-match-quality epic, match-band-core story) so
 * matching/match-band.ts can reuse the EXACT same rate/hours comparison
 * this function already does, rather than reimplementing it and risking
 * silent drift between what gate() actually enforces and what the
 * in-band/near-band/out-of-band classifier reports.
 */
export interface ProfileMatch {
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
export function matchProfiles(
  gig: Gig,
  profiles: EngagementProfile[],
): { matched: ProfileMatch[]; applicable: EngagementProfile[]; profileReasons: string[]; profileOutcomes: ProfileOutcome[] } {
  const type = effectiveEngagementType(gig);
  const applicable = profiles.filter((p) => (type ? p.types.includes(type) : p.rateUnit === "hour"));

  const matched: ProfileMatch[] = [];
  const profileReasons: string[] = [];
  const profileOutcomes: ProfileOutcome[] = [];

  for (const p of applicable) {
    const rate = normalizeRate(gig, p.rateUnit);
    const unitLabel = p.rateUnit === "hour" ? "/hr" : "/yr";

    if (rate == null) {
      matched.push({ profile: p, rate: null });
      profileReasons.push(`✓ [${p.label}] rate not published — passing, confirm on the call`);
      profileOutcomes.push({ profile: p, kind: "rate-unpublished" });
      continue;
    }

    const clearsRate = rate >= p.minRate;
    if (!clearsRate) {
      profileReasons.push(`✗ [${p.label}] $${rate.toLocaleString()}${unitLabel} below floor $${p.minRate.toLocaleString()}${unitLabel}`);
      profileOutcomes.push({ profile: p, kind: "below-floor", rate });
      continue;
    }

    // EngagementProfileSchema's .refine() guarantees maxHours/
    // maxHoursAtHighRate are set whenever rateUnit === "hour" — the `!`s
    // below encode that schema-level invariant, not an unchecked guess.
    let cap: number | undefined;
    if (p.rateUnit === "hour" && gig.weeklyHours != null) {
      cap = rate >= p.highRate ? p.maxHoursAtHighRate! : p.maxHours!;
      if (gig.weeklyHours > cap) {
        profileReasons.push(
          `✗ [${p.label}] ${gig.weeklyHours} hrs/wk over cap ${cap}` +
            (rate < p.highRate ? ` (raise-rate to unlock ${p.maxHoursAtHighRate})` : ""),
        );
        profileOutcomes.push({ profile: p, kind: "over-hours-cap", rate, hours: gig.weeklyHours, cap });
        continue;
      }
    }

    matched.push({ profile: p, rate });
    const tierLabel = rate >= p.highRate ? "high-rate" : "floor";
    profileReasons.push(`✓ [${p.label}] $${rate.toLocaleString()}${unitLabel} ≥ ${tierLabel} $${(rate >= p.highRate ? p.highRate : p.minRate).toLocaleString()}${unitLabel}`);
    profileOutcomes.push({ profile: p, kind: "cleared", rate, cap });
  }

  return { matched, applicable, profileReasons, profileOutcomes };
}

/**
 * gate-reasons-in-dashboard story. The structured twin of each
 * `profileReasons` line above -- pushed in the same branch, one per
 * applicable profile tried, so evaluateGate() can phrase per-rule reasons
 * for the dashboard without re-deriving (or string-parsing) the comparison.
 * A configured profile with no entry here wasn't applicable to this gig's
 * engagement type.
 */
export type ProfileOutcome =
  | { profile: EngagementProfile; kind: "rate-unpublished" }
  | { profile: EngagementProfile; kind: "below-floor"; rate: number }
  | { profile: EngagementProfile; kind: "over-hours-cap"; rate: number; hours: number; cap: number }
  | { profile: EngagementProfile; kind: "cleared"; rate: number; cap?: number };

/**
 * match-warning-tooltip-clarity-and-reliability story (crawler-fidelity-and-
 * app-usability epic). The dashboard's ⚠ "didn't clear a profile" indicator
 * (src/app/dashboard-client.tsx) used to show one flat, misleading message
 * for every such gig — but two genuinely different situations land here:
 * a source that simply never published a rate/hours figure for this gig
 * (so gate() had nothing to compare against ANY profile, hourly or salaried
 * — see `applicable.length === 0` below) vs. a gig whose real, published
 * numbers (or explicit engagement type) actually failed the user's
 * configured thresholds. Reuses the EXACT SAME `matchProfiles()`/
 * `effectiveEngagementType()` gate() itself calls above — no re-derivation
 * of the rate/hours/type comparison logic a third time in the UI layer
 * (same "reuse tiering.ts, don't reimplement" discipline as the
 * gate-fit-check-too-strict epic's gate-uses-role-area-tier-for-fit story).
 *
 * Returns `undefined` when the gig DID clear a profile — nothing to explain.
 */
export type ProfileMismatchKind = "rate-not-comparable" | "real-mismatch";

export function explainProfileMismatch(gig: Gig, profiles: EngagementProfile[]): ProfileMismatchKind | undefined {
  const { matched, applicable } = matchProfiles(gig, profiles);
  if (matched.length > 0) return undefined;
  // Mirrors gate()'s own `applicable.length === 0` branch above: no
  // configured profile even applies AND the gig's engagement type couldn't
  // be determined at all (no rate.unit, no explicit employmentType, no
  // contractToHire) — the "we have nothing to compare" case. Anything else
  // (a type-mismatch gate() DOES know about, or a real applicable profile
  // whose numeric rate/hours genuinely failed) is a real, substantive
  // mismatch worth the owner's attention.
  return applicable.length === 0 && effectiveEngagementType(gig) === undefined ? "rate-not-comparable" : "real-mismatch";
}

/** Convert whatever rate a source gives into `targetUnit` ("hour" or "year"), or null if it can't be compared cleanly. Never cross-converts hour<->year (too speculative — see this project's standing "never fabricate" posture). */
/** Exported for match-band.ts's reuse — see matchProfiles()'s own export doc comment above. */
export function normalizeRate(gig: Gig, targetUnit: "hour" | "year"): number | null {
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

/** Keyword overlap between the gig and the user's roles+skills. `score` 0..1; `hits` are the configured roles/skills found (original casing). */
function fitMatch(gig: Gig, profile: Profile): { score: number; hits: string[] } {
  const hay = `${gig.title} ${gig.description ?? ""}`.toLowerCase();
  const needles = [...profile.roles, ...profile.skills];
  if (needles.length === 0) return { score: 1, hits: [] }; // no filter set => everything "fits"
  const hits = needles.filter((n) => n.length > 2 && hay.includes(n.toLowerCase()));
  return { score: Math.min(1, hits.length / Math.max(3, Math.ceil(needles.length / 3))), hits };
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
