# Design discussion: group-scoped-automation-fixes

## 0. Trigger

Direct continuation of `dynamic-groups-band-audit` (PRs #161-163), which
found and fixed one real cross-group tier/profile display leak. Owner's
follow-up: "go through, fix everything you can, get the new one up, and
let's start trying to dogfood this week" — with a stated concrete plan
to track up to 4 groups (existing fractional/full-time ones, plus a new
drone-services business, AI labeling work, etc.) starting soon.

A dedicated sweep (research fork, 13 tool calls) found the SAME bug
class in 3 more display call sites, plus a much bigger, separate
finding: the entire automation pipeline (auto-draft, notify-on-green-
match, auto-fire) only ever acts on a gig's PRIMARY group. A non-primary
group gets full dashboard visibility (now correctly fixed) but zero
automation, ever — no auto-drafted applications, no notifications, no
auto-fire. For an owner about to run 4 concurrent groups, most of them
non-primary, this is the single highest-value fix relative to the
stated dogfooding goal — automation silently not running for 3 of 4
tracked domains is a much bigger problem than a wrong badge color.

## 1. Findings

**Remaining display-layer leaks (same class as PR #163, low risk):**
- `src/app/dashboard-overview-client.tsx:38,96` — the per-group
  Dashboard overview's "green count"/"recent 24h" tiles read flat
  `g.tier`, never receiving `groupId` at all.
- `src/app/gig-detail-panel.tsx:68,87` — the gig detail panel's tier
  badge reads flat `gig.tier`; never receives `groupId` (confirmed at
  its call site, `dashboard-client.tsx:1423`).
- `src/app/gigs/[key]/interview/interview-workspace-client.tsx:82,118`
  — same `TIER_BADGE_STYLE[gig.tier]` pattern.
- `src/mcp/server.ts:163` (`handleListGigs`) — already applies
  `args.groupId` as a filter but then filters `args.tier` against the
  flat `gig.tier`, not that group's own tier. Notable because this is
  the ground-truth surface other tools/agents (and the owner's own
  future automation) query directly.

**Bigger finding — automation is primary-group-only, not a display bug:**
- `runAutoDraft()`/`runNotifyOnGreenMatch()` (`src/scheduler/index.ts:302,360`)
  filter on `MatchResult.tier`, which `runner.ts` computes as the
  primary group's own tier only (`flatTier`). The full per-group data
  (`matchedGroupTiers`, `matchedGroupBands`) is already present on
  `r.gig` — this is a filter-logic fix, not a new data plumbing problem.
- `autofire.ts`'s `AutoFireRuleConfig` (`types.ts:480-486`) is keyed
  only by `(sourceId, tier)` — no group concept exists in the trust
  model at all. `evaluateAutoFire()` (`autofire.ts:169`) reads the
  flat, primary-group `gig.tier` to find a matching rule.

## 2. Design decision: how should auto-fire's trust model treat groups?

This is the one real judgment call in this epic, made here rather than
punted to a story, because it affects a safety-relevant system
(real-world submission automation):

**Decision: `AutoFireRuleConfig` gets an OPTIONAL `groupId` field.**
`undefined` (the default, and every existing configured rule) means
"applies regardless of which group matched" — byte-identical behavior
to today for a single-group install or anyone who hasn't touched this
new field. A rule with an explicit `groupId` only evaluates for gigs
that are green-tier for THAT specific group.

**Rationale:** mirrors the exact "unscoped = every group, explicit list
= just these" convention this codebase already uses for
`SourceConfig.groupIds` (config-client.tsx) — never invent a second
convention for the same shape of problem. It's also the SAFER default
for graduated trust specifically: it does not silently grant an
ungraduated group's gigs the trust another group already earned through
real approvals (each rule's `approvedCount()` stays scoped to whichever
gigs it actually evaluates), while still letting an owner who wants
one blanket rule across all groups configure exactly that by leaving
`groupId` unset.

## 3. Scope

Three stories, sequenced to avoid two stories editing
`scheduler/index.ts` in flight at once (real git-conflict risk, not a
runtime one):

1. **remaining-cross-group-tier-leaks** (independent) — the 4 display
   fixes above, same low-risk pattern as PR #163.
2. **group-aware-auto-draft-and-notify** (independent) — widen
   `runAutoDraft()`/`runNotifyOnGreenMatch()`'s eligibility checks from
   "primary group green+in-band" to "ANY in-scope group green+in-band,"
   using data that already exists on the gig. No schema change.
3. **group-aware-auto-fire-trust** (depends on story 2 landing first,
   to avoid a scheduler/index.ts merge conflict) — the `groupId` field
   + `evaluateAutoFire()`/`findAutoFireRule()` changes from §2 above,
   with real test coverage proving graduation/trust counts stay
   correctly scoped per rule and existing (no-groupId) rules are
   completely unaffected.

Explicitly out of scope: building any NEW automation surface (this is a
fix pass, not new features); changing the graduated-trust MECHANISM
itself (minApprovals/dailyCap/decision-log all stay exactly as designed
by `graduated-auto-fire-trust`) — only WHICH gigs a rule considers
changes.
