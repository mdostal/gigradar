# config-rebuild-and-match-quality: design discussion

## 0. Why this epic exists

Owner's explicit process directive: "all of this is in the hive plan and
execute, no one off shit on claude, claude seems to suck if not directed
through these plugins." Covers five real, confirmed problems hit live
while dogfooding tonight: the config page redesign that was speced but
never built, a sync-status UI that doesn't scale past 2 hardcoded sources,
giglist filters the owner can't find/use, and — the most serious finding —
a real, confirmed bug where the AI-verification feature the owner already
built (and expected to be catching exactly this) has zero effect on what
tier a gig actually displays as.

## 1. Config page: real synthesis, not a guess

Owner's own words, verbatim: "take the side bar, make it collapsible,
maintain the top level view of the config to have a config dashboard like
the nice card design and then the side view lets you skip to the fullpage
section and the card design click in also takes you into the full page
section -- basically a config dashboard and a home and a config specific
page for each area."

Resolved IA: three of the earlier concept artifacts contribute, not one
picked wholesale:
- `/config` becomes a real **Config Dashboard/home** — the card-grid
  layout from Concept C (Artifact 0bb8af7b), each card a compact summary
  (Profile, Sources, Groups & Needs, Schedule, Automation/Auto-fire,
  Appearance) with a real completeness/status read at a glance.
- A **collapsible sidebar** (Concept A, Artifact f9e1f4a9) present on the
  dashboard AND every section page, letting the owner jump directly to any
  section without going back through the dashboard.
- Clicking a dashboard card OR a sidebar entry lands on the SAME
  destination: a real, dedicated **full page per section**
  (`/config/profile`, `/config/sources`, `/config/groups`,
  `/config/schedule`, `/config/automation`, `/config/appearance`) — not an
  inline expand, not an accordion. Concept B (accordion) is NOT used
  structurally, but its field-level settings search is worth keeping as a
  cross-cutting affordance on the dashboard (search jumps straight to the
  right section page).
- Auto-fire keeps its own distinct, more-serious visual treatment
  (Concept C's hazard-stripe/kill-switch framing) on both its dashboard
  card and its own full page — this section can trigger real
  applications, it should never look as casual as Appearance.

## 2. Sync-status UI doesn't scale

Confirmed via code read: `src/app/gigs/page.tsx`/`[group]/gigs/page.tsx`
hardcode exactly two `<SyncStatusButton>` instances (GoFractional,
Wellfound) — the only 2 of ~13 sources with a real `reconcile*Statuses()`
adapter. Owner: "sync statuses should be across all of them and then
allowed for each one in a drop down or something -- as you sign up and add
accounts, more should appear." Fix: a real registry of
`{sourceId, reconcileAction}` pairs (mirroring `KNOWN_SOURCES`'s own
pattern) that the UI iterates dynamically — adding a third
`reconcile*Statuses()` adapter in the future means the dropdown grows on
its own, zero UI change required.

## 3. Giglist filters — owner can't find/use them

Owner: "if the filters exist, i sure as fuck can't use or see them, i see
jobs for low level associate engineer and stuff." Real research step
(part of this epic's own first story): read `dashboard-client.tsx`'s
actual filter row rendering and determine which of three things is true —
genuinely broken, present but undiscoverable, or present but not filtering
by what the owner actually wants (tier/group/seniority). Do not assume;
the live-reproduced junk (COO, entry-level engineers) turned out to be a
TIERING bug (§4), not a filter bug — but the filter UI's own
discoverability is still a real, separate complaint to verify.

## 4. THE CENTRAL FINDING: AI verification never touches the displayed tier

Owner, when asked how junior/wrong-role listings should be excluded: "This
is supposed to have multiple levels and an AI assistant on top to help
sort and it seems that is not happening at all." This maps to a real,
already-shipped feature (`GroupConfig.aiVerify`, `matching/ai-verify.ts`)
— and the owner is right that it isn't happening, for a confirmed reason:

Read `src/lib/apply/runner.ts` in full (lines ~155-185). `applyAiVerification()`
DOES run (when a group has `aiVerify: true` and a credential resolves) and
correctly computes a semantic verdict — but its only outputs are
`matchedGroupIds` (which groups a gig belongs to) and `aiFlags`. The
DISPLAYED tier (`flatTier`, what renders as green/yellow/red everywhere in
the UI) is computed SEPARATELY and BEFORE this, purely from
`tier()`(keyword classifier) or `computeTier()`(tierScoring) — neither of
which ever reads `aiFlags` or the AI-adjusted `matchedGroupIds`. Grep-
confirmed: `aiFlags` has ZERO references anywhere in `src/app/**/*.tsx` —
it is computed, stored, and never shown to the owner anywhere. A gig the
AI verification correctly identifies as "not actually a CTO/VP-Eng role"
still displays with whatever keyword-driven tier it had before — this is
the exact, confirmed root cause of "it seems that is not happening at
all."

Real fix, two parts (owner: "we need a good way to handle and confirm that
as we go" — both matter, not just the first):
1. **Wire the verdict into what actually displays.** When AI verification
   downgrades a group match (or flags a gig as a false positive), that
   must show up in the gig's actual tier/status somewhere real — not
   necessarily override the keyword tier outright (open implementation
   question, flagged for the story itself: does an AI-rejected match drop
   the gig to yellow/red, or does it just add a visible caveat while
   leaving the keyword tier as-is?), but it must be VISIBLE and
   ACTIONABLE, not silently discarded.
2. **Surface + confirm loop.** `aiFlags` (or whatever real signal comes out
   of this fix) needs a real UI presence — a badge, a reason string, an
   indicator similar to the tier badge — with a way for the owner to
   confirm/override the AI's read per the owner's own "good way to handle
   and confirm that as we go."

## 5. Seniority exclusion — mechanism, not a new list

Resolved: seniority terms ("entry level", "associate", "software engineer
i", "junior") go into the EXISTING `redKeywords` list — same mechanism
already used for wrong-role exclusion (CFO/CMO/etc.), no new config
concept. This is a data change the owner makes via the (now-rebuilt)
config UI, not a code change — core stays generic per
`docs/ARCHITECTURE.md`'s core/user-layer boundary.

## 6. Stale tier — both remediations

Confirmed live: `fractionus:fractional-coo-at-trustech-pro-inc`,
first_seen == last_seen == 2026-08-17 (18+ days stale), tier=green,
status=new — a gig the owner's OWN current redKeywords would now
correctly exclude, but it was tiered once at insert and never revisited
since the source stopped returning it. Owner: "Both" — (a) periodically
re-tier gigs not re-seen recently against CURRENT config (so a redKeywords
fix retroactively cleans up old clutter), and (b) archive with
`outcomeReason: expired_unapplied` (already exists,
status-reconciliation-outcomes epic) after a longer staleness threshold.
Real design question for the story: what re-tier cadence (piggyback on the
existing 30-min scheduler cycle vs. a separate pass) and what two
thresholds (re-tier-eligible vs. archive-eligible) — propose sane
defaults, flag them clearly in the PR for the owner to tune.

## 7. NEW tier-1/tier-2 ranked buckets — explicitly separate from tierScoring

Owner confirmed this is NOT the existing green/yellow/red tier or the
existing `GroupConfig.tierScoring` (score-threshold/percentile) — "a
genuinely new, separate ranking on top." Owner's own framing from earlier
in this session: distinct groups (e.g. full-time vs. hourly/fractional)
should each have their OWN ranked buckets ("tier 1, tier 2"), and two
DIFFERENT groups can each have their own, independently-meaningful "tier
1" — not a single global ranking. Exact mechanism (owner-assigned per-gig
rank? a second scoring dimension? company/rate-based buckets the owner
pre-defines per group?) is still underspecified — this story's own first
step must propose a concrete, minimal mechanism (most likely: an
owner-editable ordered list of rank labels per group, e.g. "Tier 1"/"Tier
2"/"Tier 3", with gigs manually or rule-assigned into them) and get an
explicit owner confirmation before building the full UI, rather than
guessing further.

## 8. What stays out of scope

- Real per-source status reconciliation for the 9 sources without an
  adapter — already flagged as its own follow-on epic
  (mark-applied-elsewhere-bulk-action's own progress_note).
- Any change to `/metrics` or the sonar-sweep header — unrelated, already
  shipped and working.
