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
import type { AutoFireDecision, AutoFireRuleConfig, Config, DraftContent, Tier } from "../types.js";
import { getDb, getDraft, getGig, recordAutoFireDecision } from "../store/index.js";
import type { DbOption } from "../store/index.js";
import { getSubmitAdapter } from "../submit/adapter.js";

/**
 * Counts every `application_drafts` row for gigs from `sourceId` tiered
 * `tier` whose status is `'approved'` OR `'submitted'` -- `'submitted'`
 * counts too because every submission this codebase can produce today was,
 * at minimum, approved along the way first (there is no other path to
 * `'submitted'` yet). Never counts `'draft'`/`'rejected'`/`'submitting'`.
 */
export function approvedCount(sourceId: string, tier: Tier, opts: DbOption = {}): number {
  const db = opts.db ?? getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM application_drafts
       JOIN gigs ON gigs.key = application_drafts.gig_key
       WHERE gigs.source_id = :source_id
         AND gigs.tier = :tier
         AND application_drafts.status IN ('approved', 'submitted')`,
    )
    .get({ source_id: sourceId, tier }) as { n: number };
  return row.n;
}

/** Finds the configured rule for `(sourceId, tier)`, or undefined if none exists. */
export function findAutoFireRule(sourceId: string, tier: Tier, config: Config): AutoFireRuleConfig | undefined {
  return config.autoFire?.rules.find((r) => r.sourceId === sourceId && r.tier === tier);
}

/**
 * True once `approvedCount(sourceId, tier)` reaches the pair's own
 * `minApprovals` threshold. False (never throws) when no rule is configured
 * for the pair at all -- an unconfigured pair can never be "graduated".
 */
export function isGraduated(sourceId: string, tier: Tier, config: Config, opts: DbOption = {}): boolean {
  const rule = findAutoFireRule(sourceId, tier, config);
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

  const tier = gig.tier;
  // Step 1: is there a configured rule for this (sourceId, tier) pair at all?
  // An untiered gig (never classified) can't match any rule -- no fallback
  // tier is substituted; this stops here rather than coincidentally
  // matching a rule configured for some other tier.
  const rule = tier ? findAutoFireRule(gig.sourceId, tier, config) : undefined;
  if (!rule) {
    return stop([`no auto-fire rule configured for (${gig.sourceId}, ${tier ?? "unset"})`]);
  }

  // Step 2: is this pair's rule enabled?
  if (!rule.enabled) {
    return stop(["auto-fire rule disabled for this (source, tier) pair"], rule);
  }

  // Step 3: has this pair graduated (enough real approval history)?
  if (!isGraduated(gig.sourceId, rule.tier, config, { db: opts.db })) {
    const count = approvedCount(gig.sourceId, rule.tier, { db: opts.db });
    return stop([`not yet graduated: ${count}/${rule.minApprovals} approvals`], rule);
  }

  // Step 4: is there anything registered to actually fire with?
  const adapter = getSubmitAdapter(gig.sourceId);
  if (!adapter) {
    return stop([`no SubmitAdapter registered for source "${gig.sourceId}"`], rule);
  }

  // Step 5: run the 4 default checks against THIS draft/gig.
  const draft = getDraft(gigKey, { db: opts.db });
  const failedChecks: string[] = [];
  if (!checkTierIsGreen(tier)) failedChecks.push(`tier check failed: tier is "${tier ?? "unset"}", not "green"`);
  if (!draft) {
    failedChecks.push("no draft exists for this gig");
  } else if (!checkDraftContentSanity(draft.content)) {
    failedChecks.push("draft content sanity check failed (empty, too short, or looks like a refusal)");
  }
  if (!checkGigIsFresh(gig.status, gig.unavailableSince)) {
    failedChecks.push(`freshness check failed: status="${gig.status}", unavailableSince=${gig.unavailableSince ?? "null"}`);
  }
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
