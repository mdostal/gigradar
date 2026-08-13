# Research Brief: auto-draft-on-scan

## 1. Summary

Wires `assisted-apply-drafting`'s `stageApplication()` into
`scan-scheduler`'s cycle: an opt-in `Config.autoDraftOnScan` flag that,
when set, auto-generates real drafts for new green-tier matches during
each scheduled scan — so the owner wakes up to real, ready-to-review
drafts in `/drafts` instead of just a longer gig list. Directly serves
"give me top suggestions in the AM." Explicitly does NOT touch
submission — drafts still require the existing manual review/approve
flow; nothing new here weakens "assisted, not auto."

## 2. Key findings (confirmed by direct code read)

- `stageApplication(r: MatchResult, config: Config, apiKey: string,
  storeOpts): Promise<ApplicationDraft>` — throws for `tier === "red"`
  and for missing `Config.applyProfile`, both BEFORE any LLM call. `apiKey`
  is caller-resolved (never internal `process.env` access).
- `scan-scheduler`'s `runCycle(config)` already has the exact integration
  point: `const result = await runRadarFn(cycleConfig)` — `result.passed`
  is the `MatchResult[]` this epic filters and drafts from.
- **Critical, already-established fact**: the scheduler's `runCycle()`
  is reached via `loadConfig()` (the scheduler's own `idleTick()`/
  `activate()` path) — and `loadConfig()` IS the "CLI/cron path" that
  populates `process.env` from `.env` (per `assisted-apply-drafting`'s
  own collaborative-review finding on this exact distinction). This means
  `process.env.ANTHROPIC_API_KEY` is ALREADY populated by the time
  `runCycle()` executes — the scheduler can read it directly, the same
  way `runner.ts`'s own CLI `main()` does, WITHOUT needing the
  `readEnvVar()`-style resolution a Server Action context requires.
- `getDraft(gigKey)` already exists (`store/drafts.ts`) — the check for
  "does this gig already have a draft" (avoiding re-drafting the same gig
  every cycle) is a direct, already-built lookup, not new logic.

## 3. Patterns & conventions

- `Config.applyProfile`/`roleArea`/`schedule`'s established
  "optional, omitted = not configured, not an error" pattern is the
  template for `Config.autoDraftOnScan` too.
- Every per-source error in `runRadar()` is isolated (one source's
  failure doesn't stop the others) — the SAME discipline applies here:
  one gig's draft-generation failure must not stop the rest of that
  cycle's auto-drafting, let alone the scan itself.
- Real LLM API cost is already an accepted, named tradeoff for
  user-TRIGGERED actions (`profile-overview-ingestion`'s resume
  extraction, `assisted-apply-drafting`'s manual "Generate draft"
  button). Auto-drafting during a SCHEDULED (not per-click) cycle is a
  meaningful shift — cost is now incurred without a per-action click —
  which is exactly why this is opt-in, not default-on.

## 4. Constraints

- **Must not draft for the same gig twice.** Check `getDraft(gigKey)`
  before calling `stageApplication()`; skip gigs that already have one.
- **Must bound the number of auto-drafts per cycle** — a scan could
  surface many new green-tier matches at once (e.g. the very first scan
  after enabling this), and drafting all of them in one cycle would be a
  real, uncapped LLM cost spike. A fixed, reasonable per-cycle cap is
  needed.
- **A missing `ANTHROPIC_API_KEY` must not crash the scheduler** — logs
  once per cycle (not once per eligible gig) and skips auto-drafting for
  that cycle, exactly matching `stageApplication()`'s own
  throw-loud-but-scoped discipline, just caught at the scheduler level
  instead of propagating.

## 5. Risks

- **Medium — uncapped LLM spend on a large first scan.** Mitigated by
  the per-cycle cap (§4).
- **Low — auto-drafted content could be lower quality than a
  user-triggered draft** if the underlying `gig.description` is thin.
  Not a NEW risk this epic introduces — the same accuracy/grounding
  discipline `assisted-apply-drafting` already established applies
  identically here; this epic doesn't change `generateDraft()` itself at
  all.

## 6. Open questions

1. What's the per-cycle cap? Leaning: a fixed constant (5) rather than a
   new configurable field — keeps the schema surface smaller; can become
   configurable later if 5 proves wrong in practice, not speculatively
   built now.
2. Green-tier only, or green+yellow? Leaning: green-tier only for
   auto-drafting — yellow is "unknown, worth a look," a weaker signal;
   auto-drafting (spending real API cost) is reserved for the
   highest-confidence tier, while yellow-tier gigs remain
   manually-draftable via the existing dashboard button.
