// Trust math + the full auto-fire decision tree for the
// graduated-auto-fire-trust epic. See
// .pHive/epics/graduated-auto-fire-trust/docs/design-discussion.md §3.1/§3.3
// for the full rationale: graduation is a PURE COMPUTATION over
// application_drafts/gigs, never a separate stored counter, so it can never
// drift from the real approval history it represents.
//
// This module knows NOTHING about HOW a submission actually happens -- that
// isolation is deliberate (src/lib/submit/adapter.ts's SubmitAdapter
// registry, kept fully independent). evaluateAutoFire() only ever calls
// `adapter.submit(...)` through the registry's opaque interface.
import type { AutoFireDecision, AutoFireRuleConfig, Config, DraftContent, Gig, MatchBand, Tier } from "../types.js";
import { getDb, getDraft, getGig, recordAutoFireDecision } from "../store/index.js";
import type { DbOption } from "../store/index.js";
import { getSubmitAdapter } from "../submit/adapter.js";

/**
 * Counts every `application_drafts` row for gigs from `sourceId` tiered
 * `tier` whose status is `'approved'` OR `'submitted'` -- `'submitted'`
 * counts too because every submission this codebase can produce today was,
 * at minimum, approved along the way first (there is no other path to
 * `'submitted'` yet). Never counts `'draft'`/`'rejected'`/`'submitting'`.
 *
 * `opts.groupId` (group-aware-auto-fire-trust story): when set, ALSO
 * requires that gig's OWN `matched_group_tiers[groupId]` equal `tier` --
 * never the flat `gigs.tier` column, which may belong to a different
 * (e.g. primary) group entirely. This is what keeps a group-scoped rule's
 * graduation count isolated to THAT group's own approvals: a gig approved
 * because it was green for group A must never count toward group B's
 * scoped rule, even for the same sourceId+tier pair. Omitted (the default,
 * and every call site that predates this field) keeps counting purely
 * against the flat `gigs.tier` column, byte-identical to before.
 */
export function approvedCount(sourceId: string, tier: Tier, opts: DbOption & { groupId?: string } = {}): number {
  const db = opts.db ?? getDb();
  // Which column decides "was this gig tiered `tier`" -- the flat
  // `gigs.tier` column (byte-identical to before this story) when
  // unscoped, or that SPECIFIC group's own tier when scoped. These are
  // deliberately NOT ANDed together: a group-scoped rule cares about that
  // group's own tier only, regardless of what the (possibly different,
  // e.g. primary) group's flat tier happens to be.
  const tierCondition =
    opts.groupId !== undefined ? `json_extract(gigs.matched_group_tiers, '$.' || :group_id) = :tier` : `gigs.tier = :tier`;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM application_drafts
       JOIN gigs ON gigs.key = application_drafts.gig_key
       WHERE gigs.source_id = :source_id
         AND ${tierCondition}
         AND application_drafts.status IN ('approved', 'submitted')`,
    )
    .get({ source_id: sourceId, tier, ...(opts.groupId !== undefined ? { group_id: opts.groupId } : {}) }) as { n: number };
  return row.n;
}

/**
 * Finds the configured rule for `(sourceId, tier)`, optionally scoped to
 * `groupId` (group-aware-auto-fire-trust story).
 *
 * - `groupId` omitted: matches ONLY an unscoped rule (`groupId: undefined`)
 *   for the pair -- a caller with no group context can never accidentally
 *   pick up a rule someone explicitly scoped to a specific group. This is
 *   exactly the pre-existing lookup behavior (every rule had no `groupId`
 *   concept at all), so an old call site with no groupId argument is
 *   completely unaffected by this story.
 * - `groupId` given: prefers an EXACT match on `(sourceId, tier, groupId)`;
 *   if none exists, falls back to an unscoped rule for the pair (unscoped
 *   still means "any group," so it applies here too). A rule scoped to a
 *   DIFFERENT groupId never matches, even for the same sourceId+tier.
 */
export function findAutoFireRule(sourceId: string, tier: Tier, config: Config, groupId?: string): AutoFireRuleConfig | undefined {
  const rules = config.autoFire?.rules ?? [];
  if (groupId !== undefined) {
    const exact = rules.find((r) => r.sourceId === sourceId && r.tier === tier && r.groupId === groupId);
    if (exact) return exact;
  }
  return rules.find((r) => r.sourceId === sourceId && r.tier === tier && r.groupId === undefined);
}

/**
 * True once `approvedCount(sourceId, tier, { groupId })` reaches the
 * pair's own `minApprovals` threshold. False (never throws) when no rule
 * is configured for the pair (scoped to `groupId` if given) at all -- an
 * unconfigured pair can never be "graduated". `groupId` omitted matches
 * `findAutoFireRule()`'s own omitted-groupId behavior above (unscoped
 * rules only) -- byte-identical to this function's pre-existing behavior.
 */
export function isGraduated(sourceId: string, tier: Tier, config: Config, opts: DbOption & { groupId?: string } = {}): boolean {
  const rule = findAutoFireRule(sourceId, tier, config, opts.groupId);
  if (!rule) return false;
  return approvedCount(sourceId, tier, opts) >= rule.minApprovals;
}

// ---------------------------------------------------------------------------
// The 4 default checks (design-discussion.md §3.4), each independently
// exported/testable -- mirrors matching/gate.ts's own per-rule-helper style.
// ---------------------------------------------------------------------------

/** Check 1: never fire on anything but green -- stricter than drafting's own tier==="red" guardrail, deliberately: auto-fire is a real-world action. */
export function checkTierIsGreen(tier: Tier | undefined): boolean {
  return tier === "green";
}

/**
 * rate-band-match-quality epic, auto-draft-respects-band story. Sibling
 * check to checkTierIsGreen() above -- tier answers "right kind of role"
 * (keyword-only, no rate awareness), this answers "is the rate actually
 * in range" (matching/match-band.ts's computeMatchBand()). Additive: both
 * must pass, this never replaces the tier check. `undefined` (a gig
 * scanned before this epic shipped, or never re-scanned since) is NOT
 * in-band -- fail CLOSED, the deliberate opposite of dashboard-filter.ts's
 * resolveDisplayBand() (which fails OPEN for the same undefined case,
 * since that backs a display filter where hiding a legitimate historical
 * gig by default is the worse outcome). Automation firing a real
 * submission on stale/unclassified rate data is the worse outcome here --
 * different risk profile, deliberately different default.
 */
export function checkMatchBandInBand(matchBand: MatchBand | undefined): boolean {
  return matchBand === "in-band";
}

const REFUSAL_MARKERS = [/^i cannot/i, /^i can't/i, /^i'm sorry, but i (cannot|can't)/i, /^as an ai/i];

/**
 * Check 2: the generated content isn't empty, isn't suspiciously short, and
 * doesn't look like an LLM refusal/error string that slipped through --
 * catches "the LLM call degraded silently" before it becomes a real,
 * broken application.
 */
export function checkDraftContentSanity(content: DraftContent): boolean {
  const text = content.coverText.trim();
  if (text.length < 40) return false;
  return !REFUSAL_MARKERS.some((re) => re.test(text));
}

/** Check 3: the gig is still 'new' (not applied/archived/ignored) and hasn't gone unavailable_since -- a delisted or already-handled gig must never auto-fire. */
export function checkGigIsFresh(status: string, unavailableSince: string | null): boolean {
  return status === "new" && unavailableSince === null;
}

/**
 * Counts `fired: true` autofire_decisions for `sourceId` within the 24h
 * window ending at `now` -- a rolling window, not a calendar-day bucket (a
 * rolling window can't be gamed by firing a batch right at midnight).
 */
export function dailyFireCount(sourceId: string, now: string, opts: DbOption = {}): number {
  const db = opts.db ?? getDb();
  const cutoff = new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM autofire_decisions
       JOIN gigs ON gigs.key = autofire_decisions.gig_key
       WHERE gigs.source_id = :source_id
         AND autofire_decisions.fired = 1
         AND autofire_decisions.decided_at >= :cutoff`,
    )
    .get({ source_id: sourceId, cutoff }) as { n: number };
  return row.n;
}

/** Check 4: no more than `rule.dailyCap` auto-fires for this source in the trailing 24h. */
export function checkDailyCapNotExceeded(sourceId: string, rule: AutoFireRuleConfig, now: string, opts: DbOption = {}): boolean {
  return dailyFireCount(sourceId, now, opts) < rule.dailyCap;
}

/**
 * group-aware-auto-fire-trust story. Resolves which `(tier, groupId, rule)`
 * `evaluateAutoFire()` should actually run its checks against for `gig`.
 *
 * **The one real precedence decision this story makes** (see
 * `.pHive/epics/group-scoped-automation-fixes/docs/design-discussion.md`
 * §2 and the story's own acceptance criteria -- do not re-litigate it): a
 * gig can be green-tier for SEVERAL of the owner's groups at once
 * (`Gig.matchedGroupTiers`), and more than one of those groups might have
 * its own applicable rule (an explicitly `groupId`-scoped one, or a shared
 * unscoped one that matches every group). Rather than firing on every
 * applicable rule at once (an over-fire risk this is a real-world
 * submission system can't tolerate) or picking one via `matchedGroupTiers`'
 * own object-key order (a plain JS object -- nothing about that order is a
 * deliberate, owner-visible decision), this walks `config.groups` in ITS
 * OWN declared array order -- the exact "first match, in declared order"
 * precedence `matching/tiering.ts`'s `tier()` and `matching/rank-bucket.ts`'s
 * `assignRankBucket()` already use for every other multi-candidate decision
 * in this codebase, and the same order `apply/runner.ts` already treats
 * `groups[0]` as "primary" -- and returns the FIRST group (in that order)
 * that has BOTH a matched tier for this gig AND an ENABLED, applicable
 * rule.
 *
 * A group with an applicable-but-DISABLED rule is skipped in favor of a
 * LATER group's enabled one: an owner who explicitly disabled one group's
 * rule must never silently block a different, already-graduated group's
 * rule from firing -- that would be a real under-fire regression with no
 * visible cause. Only when NO group has an enabled rule does this fall
 * back to the first applicable-but-disabled rule found, so the returned
 * decision still explains itself as "disabled" rather than a generic
 * "no rule configured".
 *
 * A gig with no `matchedGroupTiers` at all (predates the
 * multi-group-architecture epic, or any hand-built test fixture) falls
 * back to EXACTLY the pre-existing single-candidate behavior: one
 * candidate, `groupId: undefined`, tier from the flat `Gig.tier` -- this is
 * what keeps every existing (no-groupId) rule's behavior byte-identical
 * after this story ships, the acceptance criterion this module's own tests
 * regression-test directly.
 */
function resolveAutoFireCandidate(
  gig: Gig,
  config: Config,
): { tier: Tier | undefined; groupId: string | undefined; rule: AutoFireRuleConfig | undefined } {
  const groupTiers = gig.matchedGroupTiers;
  const candidates: { tier: Tier; groupId: string | undefined }[] = [];

  if (groupTiers && Object.keys(groupTiers).length > 0) {
    const seen = new Set<string>();
    for (const g of config.groups ?? []) {
      const t = groupTiers[g.id];
      if (t !== undefined) {
        candidates.push({ tier: t, groupId: g.id });
        seen.add(g.id);
      }
    }
    // Defensive: a groupId stamped on the gig at scan time but no longer
    // present in config.groups (the owner renamed/removed the group since)
    // is still considered -- just after every currently-configured group,
    // in whatever order Object.entries() happens to return, since there is
    // no declared order left to anchor it to.
    for (const [gid, t] of Object.entries(groupTiers)) {
      if (!seen.has(gid)) candidates.push({ tier: t, groupId: gid });
    }
  } else if (gig.tier) {
    candidates.push({ tier: gig.tier, groupId: undefined });
  }

  let firstApplicable: { tier: Tier; groupId: string | undefined; rule: AutoFireRuleConfig } | undefined;
  for (const c of candidates) {
    const rule = findAutoFireRule(gig.sourceId, c.tier, config, c.groupId);
    if (!rule) continue;
    if (rule.enabled) {
      return { tier: c.tier, groupId: c.groupId, rule };
    }
    if (!firstApplicable) firstApplicable = { ...c, rule };
  }
  if (firstApplicable) return firstApplicable;

  // No group had ANY applicable rule -- report using the highest-precedence
  // candidate (if any), so the "no rule configured" reason below still
  // names a real tier/group, matching this function's single-candidate
  // message shape from before this story.
  const fallback = candidates[0];
  return { tier: fallback?.tier, groupId: fallback?.groupId, rule: undefined };
}

// ---------------------------------------------------------------------------
// The full decision tree (design-discussion.md §3.3, steps 0-6). Deliberately
// only ever CHECKS whether a SubmitAdapter is registered (step 4) -- it never
// calls adapter.submit() itself. Actually firing (adapter.submit() +
// markDraftSubmitting()/markDraftSubmitted()/markDraftFailed()) is the
// orchestration layer's job (a later story), which calls this function
// first and only proceeds to fire when the returned decision says so. This
// keeps the decision engine fully independent of "how a submission actually
// happens," matching src/lib/submit/adapter.ts's own isolation.
// ---------------------------------------------------------------------------

/**
 * Decides whether `gigKey` should auto-fire right now, and WHY either way.
 * Every call persists exactly one `autofire_decisions` row via
 * recordAutoFireDecision(), fired or not -- the audit trail is unconditional.
 */
export function evaluateAutoFire(gigKey: string, config: Config, opts: DbOption & { now?: string } = {}): AutoFireDecision {
  const now = opts.now ?? new Date().toISOString();

  const stop = (reasons: string[], ruleSnapshot?: AutoFireRuleConfig): AutoFireDecision => {
    const decision: AutoFireDecision = { gigKey, decidedAt: now, fired: false, reasons, ruleSnapshot };
    recordAutoFireDecision(decision, { db: opts.db, now });
    return decision;
  };

  // Input validation FIRST, before any policy decision -- autofire_decisions.gig_key
  // has a real FK to gigs(key) (schema.ts), so there is nothing valid to persist a
  // decision against for a gigKey that doesn't exist. Not a real production path
  // (the orchestration layer only ever calls this right after staging a real
  // draft for a real gig) -- this guards against a bad gigKey outright, never
  // silently, but without violating the FK by trying to log against nothing.
  const gig = getGig(gigKey, { db: opts.db });
  if (!gig) {
    return { gigKey, decidedAt: now, fired: false, reasons: [`no such gig: ${gigKey}`] };
  }

  // Step 0: global kill switch -- checked before any per-pair rule is even loaded.
  if (config.autoFire?.killSwitch === true) {
    return stop(["kill switch enabled"]);
  }

  // Step 1: is there a configured rule applicable to this gig at all? --
  // resolveAutoFireCandidate() (see its own doc comment above) walks every
  // group this gig matched (falling back to the flat, primary-group
  // `Gig.tier` for a gig with no `matchedGroupTiers` at all, byte-identical
  // to this step's pre-existing single-candidate behavior) and picks the
  // first one with an applicable rule, preferring an enabled one.
  const { tier, groupId, rule } = resolveAutoFireCandidate(gig, config);
  if (!rule) {
    return stop([`no auto-fire rule configured for (${gig.sourceId}, ${tier ?? "unset"}${groupId !== undefined ? `, group "${groupId}"` : ""})`]);
  }

  // Step 2: is this pair's rule enabled?
  if (!rule.enabled) {
    return stop([`auto-fire rule disabled for this (source, tier) pair${rule.groupId !== undefined ? ` (group "${rule.groupId}")` : ""}`], rule);
  }

  // Step 3: has this pair graduated (enough real approval history)? Scoped
  // to `rule.groupId` -- the WINNING RULE's own configured group, not
  // necessarily the candidate group that surfaced it (an unscoped rule
  // matched via a specific group's candidacy still counts approvals across
  // every group, exactly as it always has -- see findAutoFireRule()'s own
  // doc comment). This is what keeps a group-scoped rule's graduation count
  // isolated to that group's own approvals, never mixed with an unscoped or
  // different-group rule's count.
  if (!isGraduated(gig.sourceId, rule.tier, config, { db: opts.db, groupId: rule.groupId })) {
    const count = approvedCount(gig.sourceId, rule.tier, { db: opts.db, groupId: rule.groupId });
    return stop([`not yet graduated: ${count}/${rule.minApprovals} approvals${rule.groupId !== undefined ? ` for group "${rule.groupId}"` : ""}`], rule);
  }

  // Step 4: is there anything registered to actually fire with?
  const adapter = getSubmitAdapter(gig.sourceId);
  if (!adapter) {
    return stop([`no SubmitAdapter registered for source "${gig.sourceId}"`], rule);
  }

  // Step 5: run the 4 default checks against THIS draft/gig. `matchBand`
  // is read from the SAME winning group's own `matchedGroupBands` when this
  // decision resolved to a specific group (mirrors runAutoDraft()'s own
  // isGreenInBandForAnyGroup() principle: "the SAME group must satisfy
  // BOTH checks") -- falling back to the flat `Gig.matchBand` exactly as
  // before when groupId is undefined (the no-matchedGroupTiers/unscoped-
  // candidate case), so this is byte-identical for every existing gig/rule.
  const draft = getDraft(gigKey, { db: opts.db });
  const matchBand = groupId !== undefined ? gig.matchedGroupBands?.[groupId] : gig.matchBand;
  const failedChecks: string[] = [];
  if (!checkTierIsGreen(tier)) failedChecks.push(`tier check failed: tier is "${tier ?? "unset"}", not "green"`);
  if (!checkMatchBandInBand(matchBand)) failedChecks.push(`match-band check failed: matchBand is "${matchBand ?? "unset"}", not "in-band"`);
  if (!draft) {
    failedChecks.push("no draft exists for this gig");
  } else if (!checkDraftContentSanity(draft.content)) {
    failedChecks.push("draft content sanity check failed (empty, too short, or looks like a refusal)");
  }
  if (!checkGigIsFresh(gig.status, gig.unavailableSince)) {
    failedChecks.push(`freshness check failed: status="${gig.status}", unavailableSince=${gig.unavailableSince ?? "null"}`);
  }
  // group-aware-auto-fire-trust story: deliberately NOT group-scoped, unlike
  // approvedCount()/isGraduated() above -- the daily cap is a source-wide
  // rate limit (design-discussion.md §3 explicitly keeps the graduated-trust
  // MECHANISM, only WHICH gigs a rule considers, in scope for this story). A
  // group-scoped rule's fires still count toward the SAME source's global
  // cap, which is the conservative direction: it prevents an owner from
  // effectively multiplying a source's daily fire budget by adding several
  // per-group rules on it, rather than loosening anything.
  if (!checkDailyCapNotExceeded(gig.sourceId, rule, now, { db: opts.db })) {
    failedChecks.push(`daily fire cap reached (${rule.dailyCap}/day) for source "${gig.sourceId}"`);
  }
  if (failedChecks.length > 0) {
    return stop(failedChecks, rule);
  }

  // Step 6: every check passed -- this decision says FIRE. The caller
  // (orchestration layer) is responsible for actually invoking
  // adapter.submit() and the markDraftSubmitting/Submitted/Failed sequence.
  const decision: AutoFireDecision = { gigKey, decidedAt: now, fired: true, reasons: ["all checks passed"], ruleSnapshot: rule };
  recordAutoFireDecision(decision, { db: opts.db, now });
  return decision;
}
