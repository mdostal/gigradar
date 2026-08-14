# Vertical Plan: graduated-auto-fire-trust

Four slices, sequential (each depends on the prior), each leaving the app
in a genuinely working state — nothing is ever mid-broken between slices.

## Slice 1 — Trust math (no firing, no adapters, no UI)

`Config.autoFire` schema + `approvedCount()`/`isGraduated()` +
`autofire_decisions` table + `application_drafts`'s new `'submitting'`
status value, fully unit-tested against fixture drafts/gigs data. Nothing
calls this yet — it's inert, verifiable in isolation, matching this
project's own precedent (`gate.ts` shipped and was fully tested before
`runner.ts` ever called it).

**Working state after this slice**: `npm test`/`npm run typecheck` clean,
existing behavior completely unchanged (nothing new is wired in), new
pure functions independently correct.

## Slice 2 — Full decision engine + adapter registry (still nothing real fires)

`evaluateAutoFire()`'s full 6-step tree (design-discussion §3.3), the 4
default checks (§3.4), the `SubmitAdapter` interface/registry (L3, empty
— zero adapters registered). Every stop point independently tested
(kill-switch, no-rule, disabled, ungraduated, no-adapter-registered,
check-failed) — the "no-adapter-registered" stop is the REAL, correct
behavior at the end of this slice, not a stub to fix later.

**Working state after this slice**: `evaluateAutoFire()` is real and
fully correct, but since no `SubmitAdapter` is registered yet, it always
stops at step 4 — provably safe to wire into the live scheduler even
before slice 3 exists, if that were ever useful for staged rollout.

## Slice 3 — GoFractional real submit adapter (the risky, live-verified piece)

`src/lib/submit/gofractional.ts` against GoFractional's real apply form
(live-verified the same way every fetch adapter in this repo already is —
real headed-browser run against the owner's own session), the
double-submit safety net (`'submitting'` intermediate status, checked
before any submit attempt), `markDraftSubmitting()`/`markDraftFailed()`.
Registered into the L3 registry — `evaluateAutoFire()` can now actually
reach step 6 for `gofractional` pairs.

**Working state after this slice**: the full pipe is real end to end for
ONE source, but nothing calls it automatically yet (L4 wiring is slice
4) — the owner (or a test) can call `evaluateAutoFire()` +
`getSubmitAdapter("gofractional").submit()` manually and get a real
result, safely, opt-in, before it's ever automatic.

## Slice 4 — Orchestration wiring + config UI (what the owner actually uses)

L4's scheduler-cycle wiring (auto-fire evaluated right after
`autoDraftOnScan` stages a draft) + L5's `/config` Auto-fire section
(kill switch, per-pair rule editor, live approved-count/graduation
status). This is the only slice that makes anything fire without a human
manually invoking it — deliberately last, deliberately the smallest,
highest-review-bar slice.

**Working state after this slice**: the epic's actual north star is live
— `Config.autoFire` unset means zero behavior change (existing
`autoDraftOnScan`-only behavior, unchanged); the owner opts in per pair,
watches the graduation counter, and the kill switch is one click away.

## Sequencing note

Slices 1-3 are provably safe to ship even mid-epic — nothing fires
without slice 4's wiring. If the owner wants to pause after slice 3 to
manually dry-run `evaluateAutoFire()` + the GoFractional adapter for real
before greenlighting slice 4's automatic wiring, that's a natural, free
checkpoint this ordering already provides.
