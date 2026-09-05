# Design Discussion: rate-band-match-quality

## Trigger

Owner, live, after I showed real data proving "Strong fit" tiering is
purely keyword-based and independent of rate: told to stop the narrow
patch-level thinking entirely. Verbatim: "go through, use /plugin-hive:plan
and deep dive a multi level solution that allows you to create a profile,
filter on multiple attributes and score them with in band, near band, out
of band etc AND a full settings that applies to make this simple to setup
and tweak... What you've built has not been able to be used for more than
2 weeks now... we've been close for 2 weeks because we aren't doing this
right... instead letting claude do shitty one-offs that only fix something
in one spot but cause a ton of breakage and diverging code."

This is explicitly NOT a request for another single-file patch. It's a
request to fix the actual architectural gap: this app has never had a
graduated, tunable "how close is this to what I want" signal — only a
binary pass/fail gate and an independent, rate-blind keyword tier.

## Root cause (confirmed against real code + the owner's live gigs.db)

1. `matching/tiering.ts`'s `tier()` — the green/yellow/red classifier — is
   **pure title/keyword matching**. It has zero knowledge of rate, hours,
   or engagement type.
2. `matching/gate.ts`'s `gate()` — the rate/hours/type checker — computes
   a real score, but **only when the gate passes** (`score: pass ?
   scoreOf(...) : 0`). A gig that fails on rate gets score `0`, identical
   to a gig that fails for any other reason. There is no "how close" signal
   anywhere in this codebase today.
3. `apply/runner.ts` stamps `Gig.tier` from `tier()` **independent of
   `gate()`'s pass/fail** (this is intentional — see tiering.ts's own doc
   comment, "unlike the gate, this is never a hard reject"). The result:
   a gig can be tier=green ("Strong fit") while its `matchedGroupIds` is
   completely empty (failed every group's gate).
4. `/today` (`dashboard-data.ts`'s `loadDashboardData()`) reads gigs
   **unscoped** — it doesn't check `matchedGroupIds` at all, just
   `gig.tier`. So a gate failure never hides a gig from "Strong fit."

Live proof, pulled from the owner's real `gigs.db` tonight: a $50-60/hr
"AI Engineering Consultant - Part time" (fractional-hourly group floor is
$90/hr) and three $86k-225k/yr software-engineer roles (full-time group
floor is $250k/yr) are all sitting in "Strong fit" with `matched_group_ids:
[]` — they failed every gate, and still surfaced as the strongest possible
signal this app has. This is real, live, and exactly what's making the
app unusable day to day.

`GroupConfig.tierScoring` (customizable-tier-scoring epic, already shipped)
is the ONE piece of prior art here — score-threshold/percentile modes that
already exist and are already wired through `group-match.ts`. But it's
opt-in, off by default (both of the owner's real groups still use plain
keyword mode), buried in a 3028-line config form, and — critically — it
inherits gate()'s all-or-nothing score, so it STILL can't express "close
but under" vs. "nowhere close." It is not sufficient on its own.

## Proposed model: rate-aware match bands

A new, additive, per-group signal — computed alongside (not replacing)
the existing green/yellow/red tier:

```
matchBand: "in-band" | "near-band" | "out-of-band"
```

- **in-band** — cleared the group's real gate (rate ≥ floor, hours ok,
  engagement type applicable) for at least one profile.
- **near-band** — failed ONLY on rate, and by less than a configurable
  tolerance (default 15% under the floor) — e.g. $130/hr against a $150/hr
  floor. Worth a glance ("almost there, maybe negotiable"), not clutter.
- **out-of-band** — failed by more than the tolerance, OR failed for any
  non-rate reason (wrong engagement type, hours way over cap). This is
  the noise the owner is drowning in today.

Computed per group (mirroring `groupTiers`/`groupScores`'s existing
per-group shape in `GroupMatchResult`), with a flat `Gig.matchBand`
anchored to the primary group, same convention `Gig.tier` already uses.
This is additive — `Gig.tier`, `gate()`, and `tier()` are UNCHANGED. The
existing keyword classifier still answers "is this the right kind of
role"; match-band answers "is the rate actually in range." Two orthogonal
questions, two signals — not a rewrite of either existing mechanism. This
directly serves the "we keep causing breakage" complaint: nothing existing
is touched, only added to.

## Settings: one real, simple, dedicated place

A NEW `/config/match-quality` section (not another field buried in the
3028-line `config-client.tsx` form) — per group:
- Near-band rate tolerance (%, default 15)
- "Hide out-of-band from Today by default" toggle (default ON)

This is the "full settings that applies to make this simple to setup and
tweak" ask, made concrete and scoped: one page, two controls per group,
not a redesign of the whole config editor.

## Where this actually fixes the pain

- `/today`'s tier-chip row gets a new **Band** chip row: In-band / Near-band
  / Out-of-band / All — defaulting to hiding Out-of-band per the group's
  own setting. This is the literal fix for "I cannot be filtering through
  100 $140k/yr salaries... trying to make progress daily."
- `autoDraftOnScan`/`autoFire` (which today only check `tier === "green"`)
  gain a second, additive check: `matchBand === "in-band"` — closing the
  same loophole for the automated draft/fire pipeline, not just the manual
  view. This is what the owner's reference to the old dostal@hive tool
  ("agent and LLM to score and rate and sort and then write drafts or
  publish them automatically") is asking to not regress on.

## Scope boundary — what this epic does NOT do

- Does not touch seniority filtering (still a separate, previously-flagged
  open question — a title-level signal, orthogonal to rate).
- Does not touch the stale-tier-never-recomputed issue (also previously
  flagged, orthogonal — this epic's bands are computed at scan time same
  as tier is today, inheriting that same staleness property, not fixing or
  worsening it).
- Does not redesign the 3028-line config-client.tsx editor. That's a much
  larger, separate, already-partially-addressed effort (the Config
  Dashboard card rebuild this session). Match-quality gets its OWN new,
  small, focused page instead of adding to that file.

## Vertical slices (each leaves the app in a real, working state)

1. **match-band-core** — `matching/match-band.ts`: pure `computeMatchBand()`
   + exhaustive unit tests. No wiring. Zero risk (net-new, unused file).
2. **match-band-pipeline-and-storage** — wire into `group-match.ts`
   (`groupBands` alongside `groupTiers`), `apply/runner.ts` (flat
   `Gig.matchBand`), schema, and a real DB migration
   (`matched_group_bands`/`match_band` columns). Verified via a real
   isolated re-scan + DB read, same rigor as this session's
   profile-group-restructure story.
3. **match-quality-settings-page** — new `/config/match-quality` section:
   per-group tolerance % + default-hide toggle, through Config schema +
   save path.
4. **band-filter-everywhere** — new Band filter on EVERY real giglist
   surface: `TodayClient` (`/today`, chip row matching its existing Tier
   chips) and `DashboardClient` (`/gigs`, `/[group]/gigs`, column-filter
   convention), defaulting to hiding out-of-band per each group's own
   setting from Slice 3. Shared classification logic lives in
   `dashboard-filter.ts`; each component keeps its own established filter
   UI pattern.
5. **auto-draft-respects-band** — `autoDraftOnScan`/`autoFire` require
   `matchBand === "in-band"` in addition to `tier === "green"`.

## Owner sign-off (received)

Asked via AskUserQuestion; owner's real answers, verbatim intent:

1. **Tolerance/defaults**: "I don't care, all of these are settings --
   make EVERY FUCKING VARIABLE TOGGLEABLE IN SETTINGS in an advanced
   piece -- we make the heuristic, we bump that up, and then we iterate on
   refactoring and cleaning everything." -> Ship with sane defaults (15%
   tolerance, hide-out-of-band ON), but every one of these numbers lives in
   a real "Advanced" settings sub-section, never hardcoded. Codebase
   cleanup/refactoring is explicitly acknowledged as a SEPARATE, later
   concern — not folded into this epic (would violate the exact
   one-thing-at-a-time discipline this epic exists to restore).
2. **Hide vs. deprioritize**: "we have multiple views -- this is ALSO
   supposed to have the applied groupings and stuff to it... those should
   be at top like they are and apply to each page." -> Hidden by default
   (per the design doc's own recommendation) AND the setting must be
   genuinely per-group (mirrors `matchedGroupTiers`'s existing per-group
   shape) and behave CONSISTENTLY across every giglist view, not a
   one-page-only bolt-on.
3. **UI scope**: "All of them!" -> Slice 4 covers every real giglist
   surface: `DashboardClient` (backs both `/gigs` and `/[group]/gigs`) AND
   `TodayClient` (`/today`) — via each component's OWN existing filter
   convention (DashboardClient's column-filter system, TodayClient's chip
   row), sharing the underlying band-classification logic through
   `dashboard-filter.ts` rather than forcing the two UIs into one shape.
   `DashboardOverviewClient` (`/` and `/[group]` — metrics/charts, not a
   giglist) is out of scope; there's no per-gig row to filter there.

## Known, explicitly out-of-scope adjacent gap

`Gig.tier`/`matchBand`'s flat field is anchored to the PRIMARY (first
in-scope) group only — a gig can be in-band for a non-primary group and
still show a misleading flat value on unscoped views (`/gigs`, `/today`).
This is the SAME limitation already flagged and left open by the
customizable-tier-scoring epic ("real remaining gap is primary-group-only
eligibility, flagged not fixed") — this epic inherits it unchanged rather
than silently fixing (or worsening) a different epic's already-tracked
issue. Unscoped views use "best band across any matched group" for
display (see match-band-core's own doc comment) as a pragmatic, honest
mitigation, not a full fix.
