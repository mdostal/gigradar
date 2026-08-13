# Design Discussion: auto-draft-on-scan

## 0. Prelude

**NORTH STAR**: "give me top suggestions in the AM" — the owner wants
real, ready-to-review drafts waiting, not just a longer list of raw gigs,
after an overnight scheduled scan. Explicitly NOT auto-submission — the
owner's own graduated-trust model (stated earlier this session) still
gates actual sending; this epic only automates the DRAFTING step.

No relevant prior decisions in the shared KG beyond this project's own
epics (same cross-project noise pattern every prior query hit — disregarded).

## 1. What Are We Doing?

An opt-in `Config.autoDraftOnScan` flag. When set, each scheduled scan
cycle (`scan-scheduler`) auto-generates a real draft
(`stageApplication()`, unmodified) for new green-tier matches — capped
at 5 per cycle, skipping gigs that already have a draft, isolating one
gig's draft failure from the rest of the cycle, and skipping entirely
(with one clear log line, not per-gig spam) if `ANTHROPIC_API_KEY` isn't
configured.

"Done": enabling `autoDraftOnScan` and running the scheduler overnight
produces real drafts in `/drafts` by morning, for real new green-tier
matches, ready for a fast review-and-approve pass — no new gig ever gets
auto-SUBMITTED, only auto-DRAFTED.

## 2. What I Found

- `scan-scheduler`'s `runCycle()` already has the exact integration
  point (`result.passed` from `runRadarFn()`).
- Critical, confirmed fact: the scheduler's own `loadConfig()` call
  ALREADY populates `process.env.ANTHROPIC_API_KEY` (it's the same
  "CLI/cron path" `assisted-apply-drafting`'s own design already
  identified) — no new API-key resolution mechanism needed, just read
  `process.env` directly, matching `runner.ts`'s CLI `main()` exactly.
- `getDraft(gigKey)` already exists — the "don't re-draft the same gig"
  check is a direct lookup, not new logic.
- `stageApplication()`'s existing guardrails (never red, never without
  `applyProfile`) are REUSED unmodified — this epic adds a caller, not
  new gating logic.

## 3. My Proposed Approach

1. **`Config.autoDraftOnScan?: boolean`** (new, optional, default
   `undefined`/off) — matches `roleArea`/`schedule`'s established
   optional-section pattern. Opt-in, not default-on, given the real LLM
   cost shift from "user-triggered click" to "runs automatically on a
   schedule."
2. **Scheduler integration** (`src/scheduler/index.ts`'s `runCycle()`):
   after `runRadarFn()` returns `result`, if `config.autoDraftOnScan` is
   true:
   - Resolve `apiKey` from `process.env.ANTHROPIC_API_KEY` (already
     populated, per §2). **Both prerequisites checked once per cycle,
     not per-gig (added post-grill, resolves H1 below)**: if
     `ANTHROPIC_API_KEY` is unset OR `config.applyProfile` is unset, log
     ONE clear line for the whole cycle naming which prerequisite is
     missing ("auto-draft enabled but ANTHROPIC_API_KEY is not set —
     skipping" / "auto-draft enabled but no apply profile is configured
     — skipping") and skip auto-drafting entirely for this cycle — never
     per-gig spam, never a fatal error. The original draft only checked
     the API key here, leaving a realistic misconfiguration (API key set,
     apply profile never filled in) to repeat
     `stageApplication()`'s own per-gig error every single eligible gig,
     every single cycle, forever.
   - **Green-tier only, capped at 5 per cycle (resolves research brief
     open questions #1 and #2)**: filter `result.passed` to `tier ===
     "green"` AND `getDraft(gigKey(...)) === undefined`, take the first
     5. **"Already drafted" scope stated explicitly (added post-grill,
     resolves H2 below)**: ANY existing draft row for a gig — regardless
     of its status (`draft`/`approved`/`rejected`/`submitted`) — blocks
     future auto-drafting for that same gig. A gig the user explicitly
     REJECTED is never automatically re-drafted, even if its underlying
     data changes later — never silently overwriting a decision the user
     already made, whatever that decision was. (The user can still
     manually re-request a draft via the existing dashboard button if
     they want to reconsider a rejected one — this epic doesn't change
     that path.)
   - For each eligible gig, call `stageApplication(matchResult, config,
     apiKey)` — catching and logging any per-gig error WITHOUT stopping
     the rest of that cycle's auto-drafting or the scan itself — matches
     the established per-source error-isolation discipline already used
     for `runRadar()`'s own scan errors. (`stageApplication()`'s own
     red-tier/missing-`applyProfile` guardrails are now structurally
     unreachable here, since the cycle-level checks above already
     excluded both cases before any gig is attempted — this per-gig catch
     remains as defense-in-depth, not the primary mechanism.)
   - Log a one-line summary appended to the cycle's existing log output:
     "N gigs auto-drafted this cycle."
3. **Nothing about `stageApplication()`, `generateDraft()`, or the
   review/approve UI changes** — this epic is purely a new, gated CALLER
   of already-built, already-tested functionality.

## 4. What Could Go Wrong

- **Medium — uncapped LLM spend on a large first scan** if a user enables
  this after already having many unseen green-tier matches queued up.
  Mitigated by the 5-per-cycle cap (§3 step 2) — the backlog drains over
  several cycles, not one expensive burst.
- **Low — a bug in the "already drafted" check could re-draft (and
  re-spend) on the same gig every cycle.** Mitigated by a dedicated
  regression test asserting a gig with an existing draft is never passed
  to `stageApplication()` again.
- **Low — this doesn't change anything about submission.** Explicitly
  named: auto-DRAFTING is not auto-SUBMITTING; the existing manual
  review/approve/mark-submitted flow (`assisted-apply-drafting`) is
  completely unmodified and still the only path to an actual application
  being marked sent.

## 5. Dependencies and Constraints

- No new dependencies.
- Depends on `assisted-apply-drafting` (`stageApplication()`,
  `getDraft()`) and `scan-scheduler` (`runCycle()`'s integration point) —
  both already merged, both reused unmodified.

## 6. Open Questions

1. ~~Per-cycle cap?~~ — **resolved**: fixed constant, 5 — §3 step 2.
2. ~~Green-only or green+yellow?~~ — **resolved**: green-tier only — §3
   step 2.

## 6a. Grill Findings Addressed

Grill round 1 (`.pHive/epics/auto-draft-on-scan/docs/grill-record.md`,
`unresolved_count: 2`) surfaced 2 findings, both resolved:

- **H1** (missing-`applyProfile` would spam per-gig, unlike the missing-
  API-key case) — resolved in §3 step 2: both prerequisites now get the
  identical once-per-cycle check-and-skip treatment.
- **H2** (unstated which draft statuses count as "already handled") —
  resolved in §3 step 2: ANY existing draft, any status, blocks future
  auto-drafting for that gig — stated explicitly, not left implicit.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest
  Platforms: Node.js
  Automated: scheduler integration tests (extending the existing
    scan-scheduler test suite) — covers: autoDraftOnScan=false/unset
    means zero stageApplication() calls (no behavior change for existing
    users); a missing ANTHROPIC_API_KEY logs once and skips cleanly, no
    crash; the already-has-a-draft gig is never re-drafted; the 5-per-cycle
    cap is enforced when more than 5 eligible gigs exist in one cycle; a
    yellow-tier or red-tier match is never auto-drafted; one gig's
    stageApplication() failure (mocked) doesn't stop the rest of that
    cycle's auto-drafting. Mocked Anthropic client throughout — no real
    API calls in the automated suite.
  Manual: enable autoDraftOnScan in the owner's real config, run the
    scheduler for real, confirm real drafts appear in /drafts after a
    real scan cycle finds new green-tier matches.
  Not verifying: anything about submission/auto-apply — explicitly
    unchanged, out of scope.
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~3-4 (Config schema addition, scheduler/index.ts
    integration, its test file)
  Subsystems: a new, gated caller wiring two already-built subsystems
    (scan-scheduler, assisted-apply-drafting) together — no changes to
    either subsystem's own internals
  Migration required: no — purely additive, opt-in, off by default
  Cross-team coordination: no
  Unknowns: 0 remaining (both open questions resolved above)

  RECOMMENDATION: Small, single story, skip H/V
  RATIONALE: This is integration glue between two already-shipped,
    already-tested systems, not new capability design. No structural
    unknowns remain.
```
