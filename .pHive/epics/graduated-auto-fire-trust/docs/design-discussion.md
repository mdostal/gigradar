# Design Discussion: graduated-auto-fire-trust

## 0. Prelude

**NORTH STAR**: real per-source submission automation exists, but it never
fires on its own until the owner has earned it — per source, per role-area
tier, through real approval history plus whatever extra checks the owner
wants. This is the epic the `assisted-apply-drafting` epic's own north star
named as deliberately later ("a graduated auto-fire trust system... earned
after enough approved history") and it is now that epic.

Owner's exact spec (confirmed 2026-08-14, gigradar session):

1. **Unlock threshold** — auto-fire becomes available for a given
   source+tier only after the owner has manually approved **at least 3**
   draft responses for that source+tier, "and work with the system to get
   it tweaked and reasonable."
2. **Per-source/tier granularity** — trust is tracked independently per
   `(sourceId, tier)` pair, not globally. Green-tier Braintrust could
   graduate while yellow-tier LinkedIn stays manual.
3. **Owner-configurable verification rules** — beyond the 3-approval
   threshold, the owner defines their own additional checks that gate each
   individual auto-fire *event*, not just the graduation decision. This is
   the "4-check gate" named in the existing task backlog — the exact
   checks are NOT assumed fixed; this doc proposes a concrete default set
   below and asks the owner to confirm/adjust it as one of the open
   questions.
4. **BYOK, fully local** — no new work required here specifically; this is
   already how the whole app runs (`apiKey` resolved from the owner's own
   `env:`-referenced key in `config.json`, never a hosted key — see
   `src/lib/apply/draft.ts` and `docs/ARCHITECTURE.md`'s Secrets section).
   Called out here because it's *why* the owner is comfortable building
   real-submit automation at all: this never becomes a multi-tenant
   liability, only a single local user's own tool.

No relevant prior decisions in the shared KG beyond this project's own
epics.

## 1. What Are We Doing?

Two things, deliberately separated so the trust framework isn't blocked on
building fragile per-site submit automation, and so a submit adapter isn't
built without anywhere safe to plug into:

1. **The trust-graduation framework** (this epic's core): tracks approval
   history per `(sourceId, tier)`, computes whether that pair is
   "graduated," lets the owner define/edit verification rules in
   `/config`, and evaluates those rules against a specific draft right
   before it would fire. This is real, generic, OSS-core infrastructure —
   it works for ANY future submit adapter, not hardcoded to one source.
2. **One real submit adapter to prove it end to end** — GoFractional
   (task #43's own stated starting point). Without at least one real
   `SubmitAdapter`, "auto-fire" has nothing to fire — the trust framework
   would be unverifiable in practice, not just in theory. This doc treats
   #43 as **in scope for this epic**, as the minimum needed to ship
   something the owner can actually turn on — see Open Question 1 for the
   case to keep it a separate epic instead, and Scale Assessment for what
   that does to sizing either way.

Explicitly NOT in scope: submit adapters for any other source (A.Team,
Wellfound, Braintrust, etc. — later, source by source, once GoFractional's
adapter shape is proven); a general no-code "rule builder" UI beyond a
straightforward checklist editor; anything that removes the owner's
ability to see/edit a draft before an auto-fire event (auto-fire skips
*review*, never skips *drafting* — every fired application still has a
real `application_drafts` row with real content, same as a manually
approved one).

## 2. What I Found

- **No real submit automation exists anywhere in the codebase today.**
  `stageApplication()` (`src/lib/apply/runner.ts`) only ever drafts +
  persists (`saveDraft()`); `markDraftSubmitted()`
  (`src/lib/store/drafts.ts`) is the ONE place a draft's status becomes
  `'submitted'`, and today it is only ever called by a human clicking
  "Mark submitted" in the `/drafts` review UI after they've applied
  themselves, by hand, using the copy-ready draft content. There is
  nothing to accidentally trigger — building this is genuinely new
  surface area, not toggling on something dormant.
- **`application_drafts`** (`src/lib/store/schema.ts`) already has the
  exact shape a trust count needs: `gig_key`, `status`
  (`draft`/`approved`/`rejected`/`submitted`), `approved_at`. Joined to
  `gigs` (`source_id`, `tier`), a per-`(sourceId, tier)` approval count is
  a straightforward query — no new drafts-table columns needed.
- **No `(sourceId, tier)` trust-state table exists.** This needs one new
  table (or a computed view) to persist graduation state and hold the
  owner's verification-rule config for that pair.
- **GoFractional's own detail page is Cloudflare-gated**
  (`src/lib/sources/gofractional.ts`'s own header comment: "Performing
  security verification" interstitial even from an authenticated session,
  both via direct navigation and same-page click). A real submit adapter
  for GoFractional cannot simply POST a form — it needs the same
  `withBrowserSession()` headed-browser mechanism the fetch side already
  uses, driving a real page interaction, and needs to tolerate that
  interstitial (or fail loud and fall back to manual, per rule 2 in
  Data-integrity: no silent zero applies here too — no silent *fake*
  success either).
- **`Config.applyProfile`** (`src/lib/types.ts`) already carries the
  contact/bio fields a real form needs. It has no per-source form-field
  mapping yet (GoFractional's real apply form's field names/shape haven't
  been captured) — that capture is part of the GoFractional submit-adapter
  story, not something this doc can front-load without live-observing the
  real form.
- **Precedent for a pluggable per-source interface already exists**:
  `Source` (`src/lib/sources/source.ts`, `registerSource()`/`getSource()`)
  is the exact shape a `SubmitAdapter` registry should mirror — same
  registration pattern, same "throws rather than fakes success" contract,
  same origin-scoped `browser-session` reuse for sources that need it.

## 3. My Proposed Approach

### 3.1 Trust state — computed, not stored redundantly

Do NOT introduce a new mutable "trust counter" that could drift from the
drafts table it's derived from. Instead:

- **Graduation is a pure computation**: `approvedCount(sourceId, tier) =
  COUNT(*) FROM application_drafts JOIN gigs ON gig_key = gigs.key WHERE
  gigs.source_id = :sourceId AND gigs.tier = :tier AND
  application_drafts.status IN ('approved', 'submitted')` (submitted
  counts too — a submitted draft was, at minimum, once approved along the
  way in every path that exists today). `graduated = approvedCount >= 3`
  (the `3` is a `Config`-level default, owner-overridable — see 3.3).
- This makes graduation state self-healing and audit-proof: it's always
  derived from the real approval history, never a separate ledger that
  could say "graduated" while the underlying approvals don't actually
  support it.

### 3.2 What DOES need new persisted state: verification-rule config

The owner's rule *definitions* are real config, not derived from anything
— they need a home. Proposed: a new optional `Config.autoFire` section:

```ts
interface AutoFireRuleConfig {
  sourceId: string;
  tier: Tier; // "green" | "yellow" | "red" (red should realistically never appear here, but not hardcoded out)
  enabled: boolean; // owner's own on/off switch for this pair, independent of graduation
  minApprovals: number; // default 3, owner-overridable per pair
  checks: AutoFireCheck[]; // see 3.4 — the "4-check gate"
}

interface Config {
  // ...
  autoFire?: {
    /** Checked FIRST, before any per-pair rule — true stops every pair, full stop. See 3.3 and Open Question 4 (resolved). */
    killSwitch?: boolean;
    rules: AutoFireRuleConfig[];
  };
}
```

Omitted/absent `autoFire` => no auto-fire ever happens, for anything —
same "omission is a meaningful, valid do-nothing default" pattern every
other opt-in flag in this `Config` already follows
(`autoDraftOnScan`/`notifyOnGreenMatch`).

### 3.3 The graduation + fire decision, end to end

```
new green-tier gig arrives (scheduler cycle, same trigger as autoDraftOnScan)
  -> stageApplication() drafts it (existing, unchanged)
  -> evaluateAutoFire(gigKey, config):
       0. config.autoFire.killSwitch === true? Yes -> stop, nothing fires, full stop (resolved Open Question 4).
       1. Is there an AutoFireRuleConfig for (sourceId, tier)? No -> stop, stays a normal draft.
       2. rule.enabled? No -> stop.
       3. approvedCount(sourceId, tier) >= rule.minApprovals (graduation)? No -> stop.
       4. Does a registered SubmitAdapter exist for sourceId? No -> stop (nothing to fire with).
       5. Run rule.checks against THIS draft/gig (3.4). All pass? No -> stop, reasons logged (same "explainable rejections" rule as the gate).
       6. All passed -> call the SubmitAdapter, on success markDraftSubmitted() (existing, unchanged transaction), log the full decision trail.
```

Every stop point leaves the draft exactly where auto-fire found it — still
`'draft'` or `'approved'`, waiting for the owner like today. Auto-fire
only ever ADDS a path to `'submitted'`; it never removes the manual one.

### 3.4 Proposed default checks (the "4-check gate") — CONFIRM WITH OWNER

Not assumed fixed, per the owner's own spec — this is a starting proposal
for Open Question 2, chosen to mirror this project's existing safety
posture (assisted-apply-drafting's tier-red guardrail, the gate's
explainable-rejection rule) rather than invented from nothing:

1. **Tier check** — never fire on anything but green (this is stricter
   than drafting's own red-only guardrail, deliberately — auto-fire is a
   real-world action, drafting is not).
2. **Content sanity check** — the generated `DraftContent` isn't empty,
   isn't suspiciously short, and doesn't contain an obvious LLM refusal/
   error string (cheap, deterministic, catches the "the LLM call
   degraded silently" failure mode before it becomes a bad real
   application).
3. **Freshness check** — the gig is still `status = 'new'` (not already
   `applied`/`archived`/`ignored`) and hasn't gone `unavailable_since` (a
   delisted gig should never auto-fire, even mid-cycle).
4. **Rate-limit / cooldown check** — no more than N auto-fired
   applications per source per day (owner-configurable, conservative
   default e.g. 3/day) — the same spirit as the scheduler's own per-source
   exponential backoff, applied to outbound actions instead of fetches.

## 4. What Could Go Wrong

- **Critical — a submit adapter silently double-submits.** A crash or
  timeout between the real submit action succeeding and
  `markDraftSubmitted()` committing could leave a gig re-eligible next
  cycle, firing the SAME application twice against a real employer.
  Mitigation: the submit adapter's own success signal AND
  `markDraftSubmitted()` must be treated as one logical unit with a
  written-before-acted ordering — write a `submitting` intermediate state
  (or a dedicated log row) BEFORE calling the adapter, so a crash mid-fire
  is detectable and a retry can check "did this already fire" before
  trying again, rather than trusting the happy path never crashes.
- **High — GoFractional's Cloudflare interstitial breaks silently mid
  form-fill**, leaving a half-submitted state that's neither a clean
  success nor a clean failure. Mitigation: the submit adapter must treat
  "did the site actually confirm submission" (a real, observed
  confirmation signal, e.g. a specific post-submit page state) as the
  ONLY success signal — never infer success from "the button click didn't
  throw."
- **High — rule config drifts from what the owner thinks it says**, e.g.
  they lower `minApprovals` for one pair while debugging and forget to
  raise it back. Mitigation: every fire event's decision trail (which
  rule, which checks, their values at fire time) gets logged/persisted,
  not just a boolean — the owner can audit exactly why something fired.
- **Medium — this becomes attractive to build far bigger than the owner
  actually wants right now** (a generic rule DSL, multi-source parallel
  rollout, etc.) — scope creep risk flagged explicitly since the owner's
  own instruction was clear and narrow (3 approvals, per-pair, one
  adapter to prove it). This doc's proposed scope stays deliberately
  narrow; Open Question 1 asks the owner to confirm that's still right.
- **Low — a source changes its apply-form shape and the adapter silently
  fills the wrong fields.** Mitigation: same "throw rather than guess"
  posture every fetch adapter already follows — a field the adapter can't
  confidently locate should fail the submit attempt loudly, never fire
  with a best-guess field mapping.

## 5. Dependencies and Constraints

- Depends on `assisted-apply-drafting` (drafts must exist to have approval
  history) and `browser-session-auth` (a real submit needs the same headed
  session mechanism the fetch side uses) — both already shipped.
- No new external dependency needed beyond what `browser-session.ts`
  already pulls in (Playwright).
- Core/user-layer boundary: the trust-graduation engine and the
  `SubmitAdapter` interface/registry are generic OSS core. The owner's
  actual `autoFire.rules` values (which pairs, which thresholds) are their
  own local config, same as `needs`/`sources` today — never hardcoded.

## 6. Open Questions — RESOLVED (owner, 2026-08-14)

1. **GoFractional submit adapter in scope for this epic?** RESOLVED: yes,
   included. One epic ships both the trust framework and the first real
   submit adapter, so there's something the owner can actually turn on and
   validate end to end, not just a framework with nothing to plug into.
2. **Do the 4 proposed default checks match?** RESOLVED: yes, as proposed
   — tier=green only, draft content sanity check, gig still fresh/not
   delisted, per-source daily fire cap.
3. **Default per-source daily fire cap?** RESOLVED (unopposed default):
   3/day, owner-overridable per pair, same as originally proposed in 3.4.
4. **Global kill switch?** RESOLVED: yes. Add `Config.autoFire.killSwitch:
   boolean` (default `false`/absent = normal operation) — checked FIRST in
   `evaluateAutoFire()`, before any per-pair rule is even loaded. When
   `true`, no `(sourceId, tier)` pair fires, full stop, regardless of any
   per-pair `enabled`/graduation/check state. Surfaced as one prominent
   toggle at the top of the `/config` auto-fire section, separate from the
   per-pair rule list below it.

## 7. Verification Strategy

Automated: golden-fixture tests for `approvedCount()`/graduation math
(mirrors `gate.test.ts`'s per-rule fixture style), the full
`evaluateAutoFire()` decision tree (every stop-point independently
tested, same as `stageApplication()`'s existing guardrail tests), the
`markDraftSubmitted()`-adjacent "already fired, don't re-fire" check, and
a GoFractional `SubmitAdapter` test against a fixture-captured real apply
form (same live-verification bar every other adapter in this repo has
already cleared). Manual: the owner personally builds 3 real approval-
history entries for one real source+tier pair, watches it graduate in
`/config`, and confirms one real, deliberate test fire end to end before
trusting the scheduled path.

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~18-22 (new autoFire trust module + tests, Config/schema
    additions, new SubmitAdapter interface + registry, GoFractional submit
    adapter + tests + fixture, /config UI section for rule editing +
    trust-status display, scheduler wiring, drafts store additions for the
    submitting-intermediate-state safety check).
  Recommendation: LARGE — real-world side-effecting automation, a new
    cross-cutting persisted concept (trust state), a new pluggable adapter
    interface, and non-trivial UI. Recommend full H/V planning before
    stories.
```
