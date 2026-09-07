# Design discussion: dynamic-groups-band-audit

## 0. Trigger

2026-09-06, owner correction, verbatim: "this is a tool for anyone to
use, I HAVE SPECIFIC ONES -- but it should work on any fucking site and
anything -- we will start a drone business and need to make a group and
section for that -- GROUPS ARE CONFIGURABLE AND DYNAMIC -- I keep saying
all of it is config and dynamic, don't fucking hardcode shit ... i'll
have 4 jobs and be tracking drons, AI labeling, etc seing where it
lands."

Standing rule this codifies (saved as
`feedback_gigradar_everything_config_dynamic_no_hardcoding`): gigradar
must work for ANY user, ANY source/site, ANY number of owner-defined
groups, purely through config — never hardcoded to the owner's own
current criteria. Concrete forcing example: he's about to spin up a
brand-new "Drone Services" (or similar) group for an entirely different
business line, alongside his existing fractional/full-time groups and
up to 4 concurrent job tracks, and it must Just Work through the config
UI with zero code changes.

**Process correction, same turn:** recent true-embedded-browser work was
implemented via direct code edits in the main session instead of
through real Hive story/team execution ("you'll need to use the hive,
cause i see you did shit outside of slices"). This epic's own execute
pass routes every code change through a delegated subagent per story,
not direct main-session implementation.

## 1. Research: is the "everything is config and dynamic" bar already met?

A dedicated read-only audit (fork, 27 tool calls, direct code reading —
not assumption) covered every layer the rank-buckets/rate-band/
multi-group epics touch:

**CONFIRMED CLEAN (no hardcoding found):**
- `src/lib/matching/{tiering,rank-bucket,match-band,score-tiering,rank-bucket-ai-overlay}.ts`
  — every keyword/rate/bucket criterion is caller-supplied
  (`RoleAreaConfig`/`RankBucketRule[]`/`tolerancePct`), zero module-scope
  constants. `rank-bucket.ts`'s own header: "a rule with NO criteria
  matches NOTHING — never a silent catch-all." Bucket labels are
  "entirely owner-named per group" (`types.ts:280`).
- `GroupConfig` (`types.ts:227-297`, `schema.ts:125-152`) — every field
  free-text/optional; the only closed enums are `EngagementTypeSchema`
  (a genuine structural axis applying to any gig, drone contracts
  included, not a hardcoding bug) and the tier-name literals
  (green/yellow/red — the label *names*, not their meaning).
- `role-templates.ts` (fractional CTO/COO/CFO/CMO/CPO) — confirmed
  genuinely optional; only the config picker UI consumes it, nothing
  downstream assumes one exists.
- `dashboard-data.ts:95` `resolvePrimaryGroupId()` /
  `dashboard-filter.ts:146` `resolveDisplayRankBucket()` — genuinely
  config-order-driven (`groups[0].id`), matching this session's own
  rank-buckets epic fix; no name/id hardcoding.
- `rank-bucket-client.tsx` / `match-quality-client.tsx` settings pages
  — both take `initialGroups: GroupConfig[]` and map generically.
- `config-client.tsx`'s `handleAddGroup()` → `defaultDraftGroup()` — a
  brand-new group gets fully empty `needs`/`roleArea`/`tierScoring`, an
  `id` derived from the owner's own typed label, and flows straight
  into the rank-bucket/match-quality pages with zero code required.
- `custom-llm-source.ts` — explicitly the generic "point at any job
  site, no PR needed" mechanism (its own header comment), not
  domain-restricted.

**Verdict:** the matching/config/group engine itself already holds the
bar the owner is checking it against. This is a real, evidenced finding
— not a placation — and it should be reported to him as such rather than
manufacturing problems to seem responsive.

## 2. Real gaps found (both UX, not logic bugs)

1. **No one-click "Add custom source."** `config-client.tsx`'s only
   entry point is "+ Add source (blank)" (line ~2867), which appends an
   empty row the owner must then hand-toggle "Custom (LLM)" on (line
   ~2632) before the URL/settings fields become the ones that matter.
   The mechanism itself (checkbox → `SettingsEditor` → "Test extraction
   now") is real and complete — this is a 2-step-instead-of-1 rough
   edge, already flagged as a known stopgap in the code's own comment
   (line 60: "A real 'Add custom source' form lands in a later story").
2. **Setup wizard placeholder text is fractional-exec-flavored.**
   `setup-wizard-client.tsx:319,321,323` — the core-titles/keywords/
   red-keywords textareas show `"fractional cto"` / `"staff engineer"` /
   `"recruiter"` as placeholder examples. Purely cosmetic (the fields are
   empty free-text), but a drone-business or AI-labeling first-time user
   sees fractional-exec examples as their very first hint of what this
   tool is "for," which cuts against the "for anyone" positioning this
   correction is about.

Neither is a logic bug. Both are worth fixing because they're the
concrete surface a NEW, unrelated-domain user actually touches first.

## 3. What still needs REAL proof, not just code-reading

Code-reading confirms the mechanism is generic. It does not prove a
genuinely new-domain group works end-to-end at runtime — group creation,
rank-bucket assignment, band scoring, and giglist filtering interacting
correctly for a group whose keywords/rates look nothing like the
owner's existing fractional-exec criteria. This needs a real, live,
curl-based verification against an isolated dev instance (never the
owner's real `~/.local/share/gigradar` data), constructing an actual
"Drone Services" group with drone-relevant tier keywords and rank
buckets, and confirming the full pipeline. Any real failure found here
is a bug to fix, not a note.

## 4. Scope

Two independently-shippable stories:

1. **dynamic-onboarding-ux-fixes** — the two real UX gaps above.
2. **new-domain-group-live-verification** — the real isolated-instance
   proof, fixing anything it actually finds broken.

Explicitly out of scope (real, separate, larger work, not silently
folded in): a dedicated multi-step "custom source" wizard beyond the
one-click entry point: this epic makes the EXISTING mechanism one click
away, not a redesign of it.

## 5. Process note

Both stories execute via a delegated subagent (Agent tool, one per
story), not direct main-session implementation — per this session's own
process correction. The orchestrator (this session) does the
research/planning above and verifies the delegated work, not the
implementation itself.
