# Horizontal Plan: graduated-auto-fire-trust

Layers this epic touches, bottom to top. Each layer's own contract is kept
independent of the others' internals — the same layering discipline
`docs/ARCHITECTURE.md` already uses for FIND vs INTERACT.

## L1 — Data model

- `src/lib/store/schema.ts`: add a `'submitting'` intermediate status value
  to `application_drafts.status`'s CHECK constraint (between `'approved'`
  and `'submitted'`) — the double-submit safety net from design-discussion
  §4. Add a new `autofire_decisions` table: one append-only row per
  `evaluateAutoFire()` call, win or lose — `gig_key`, `decided_at`,
  `fired` (0/1), `reasons` (JSON array of strings, same shape
  `MatchResult.reasons` already uses), `rule_snapshot` (JSON — the
  `AutoFireRuleConfig` values in effect at decision time, so a later
  config edit can never retroactively change what an old audit entry
  claims fired under). This is the "decision trail" design-discussion §4
  commits to for the config-drift risk.
- `src/lib/store/db.ts`: `ensureColumn()`-style migration for the new
  status value + `ensureTable()`-equivalent for `autofire_decisions`
  (mirrors the existing `employment_type`/`matched_profile_ids` migration
  pattern already in this file).
- `src/lib/store/drafts.ts`: new `markDraftSubmitting(gigKey)` /
  `markDraftFailed(gigKey, reason)` alongside the existing
  `markDraftSubmitted()` — same atomic-transaction discipline.
- `src/lib/types.ts` + `src/lib/config/schema.ts`: `Config.autoFire`
  (`killSwitch`, `rules: AutoFireRuleConfig[]`) per design-discussion §3.2.

## L2 — Trust/decision engine

- New `src/lib/apply/autofire.ts`: `approvedCount(sourceId, tier, opts)`
  (pure SQL read, no side effects), `isGraduated(sourceId, tier, config)`,
  `evaluateAutoFire(gigKey, config, opts): AutoFireDecision` (the full
  6-step tree from design-discussion §3.3, steps 0-6), each of the 4
  default checks (§3.4) as its own small exported function so they're
  independently unit-testable, same style `gate.ts`'s per-rule internal
  helpers already use.
- This layer knows NOTHING about how a submission actually happens —
  it only decides yes/no and returns a decision object; L3 executes it.

## L3 — Submit adapters (the "how to actually apply" layer)

- New `src/lib/submit/adapter.ts`: `SubmitAdapter` interface
  (`id`, `submit(gig, draft, applyProfile): Promise<SubmitResult>`) +
  `registerSubmitAdapter()`/`getSubmitAdapter()` registry — deliberately
  mirrors `src/lib/sources/source.ts`'s existing shape (registration
  pattern, "throw rather than fake success" contract).
- New `src/lib/submit/gofractional.ts`: the first real adapter. Drives
  `withBrowserSession()` (existing, `browser-session.ts`) to fill and
  submit GoFractional's real apply form; treats ONLY a real, observed
  post-submit confirmation state as success (design-discussion §4's
  Cloudflare-interstitial mitigation) — anything else throws, never
  infers success from "didn't throw."

## L4 — Orchestration wiring

- `src/lib/apply/runner.ts` or `src/scheduler/index.ts` (whichever already
  owns the `autoDraftOnScan` trigger point — same cycle,
  immediately-following step): after a draft is staged, call
  `evaluateAutoFire()`; if it says fire, call the registered
  `SubmitAdapter`, persist the decision row (L1) either way.

## L5 — Config UI

- `src/app/config/config-client.tsx`: new "Auto-fire" section —
  kill-switch toggle (prominent, top of section), per-`(sourceId, tier)`
  rule list (enabled toggle, minApprovals, daily cap) with each pair's
  CURRENT approved-count/graduation status shown inline (read-only,
  computed via a new Server Action reading L2's `approvedCount()`), so the
  owner can see "2/3 approved, not yet graduated" before it fires.

## Cross-layer dependency

```
L1 (data model)
  -> L2 (trust engine, reads L1)
       -> L3 (submit adapters, independent of L1/L2 — pure "how to submit")
       -> L4 (orchestration, calls L2 then L3, writes back to L1)
            -> L5 (config UI, reads L1 via a Server Action, writes Config.autoFire)
```

L3 has no compile-time dependency on L1/L2 — a `SubmitAdapter` only knows
`Gig`/`DraftContent`/`ApplyProfileConfig`, same isolation `Source` already
has from the gate/tiering layers that consume its output.
