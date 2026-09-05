# Design Discussion: rank-buckets

## Trigger and history

Supersedes `config-rebuild-and-match-quality`'s `new-tier-ranking-buckets`
story, which sat genuinely blocked on owner design confirmation for
multiple sessions. A "Rank Buckets Proposal" artifact was published
earlier proposing 3 mechanisms (fully manual / rule-based / AI-suggested).
Owner's real answer tonight, verbatim: "we were supposed to have simple
rules set anyways, maintain that, then add in the AI suggested on top --
this should be both and we have a mixed filter mechanism that was supposed
to be built -- get it all into a backlog and start building and loop until
the backlog is truly empty." Bucket label shape: **owner-named ordered
labels per group** (confirmed via AskUserQuestion).

Direct accountability note: this story sat blocked-and-silent for too
long — deferred correctly (it genuinely needed owner input), but never
re-surfaced in later "epic complete" status reports, creating a false
impression of a fully empty backlog. This epic's own stories get closed
out with real progress_notes AND every status report from here forward
names any still-open item explicitly, never silently.

## What "both" means: rule-based base + AI overlay

Mirrors a pattern already proven in this codebase (`ai-verify.ts`): a
deterministic heuristic runs first, an LLM check runs second and can
override it, never the reverse. Applied here:

1. **Rule-based (base, always available, no LLM required).** Each group
   optionally defines an ORDERED list of buckets, each with simple,
   structured criteria — a minRate/maxRate threshold and/or a keyword
   list (the same two primitives `EngagementProfile`/`RoleAreaConfig`
   already use elsewhere in this codebase, not a new criteria language).
   A gig is assigned to the FIRST bucket (in owner-defined order) whose
   rule it satisfies — same "first match wins, in declared order"
   precedence `tiering.ts`'s `tier()` already uses, for the same
   explainability reason.
2. **AI overlay (opt-in per group, mirrors `GroupConfig.aiVerify`'s own
   existing opt-in convention).** When on, an LLM call reviews the rule-
   assigned bucket against the group's own plain-English bucket
   descriptions (an optional free-text field per bucket, separate from
   its structured rule) and may suggest a DIFFERENT bucket with a reason.
   The rule-based assignment always exists and is never silently replaced
   — the AI's suggestion sits alongside it, unconfirmed, until the owner
   acts on it.
3. **A REAL confirm/override control** — checked live tonight: `aiFlags`
   (the existing ai-verify mechanism) has NO interactive confirm/override
   UI today, only a read-only tooltip. The proposal's claim that this
   epic could "reuse" an existing confirm/override UX was aspirational,
   not real. This epic builds the first real one: a small control on the
   giglist's Rank Bucket cell letting the owner accept the AI's
   suggestion or manually reassign any gig to any of that group's
   buckets — a real Server Action, mirroring `updateGigStatusAction`'s
   own convention exactly.

## The "mixed filter mechanism" — real finding, not guessed

Checked live: `DashboardClient` already applies every active TanStack
column filter with AND semantics (`getFilteredRowModel()`), and
`TodayClient` already ANDs its own hand-rolled filter state (tier, band,
status, source, profile, seenWindow, search) in one `matches()` function
— confirmed by this epic's own `band-filter-everywhere` story tonight,
where Band was added as a filter dimension and immediately combined with
every pre-existing one with zero new combination logic needed. **Multi-
dimension AND-filtering already works mechanically on both giglist
surfaces.** The real, concrete gap "mixed filter mechanism" points at is
that Rank Bucket doesn't exist as a filterable dimension yet — once it
does, using the exact same shared-logic-plus-per-component-UI pattern
`band-filter-everywhere` already established, it participates in that
same working AND-combination automatically. No new filter-combination
engine needs to be built; the new filterable dimension is the actual
missing piece.

## Scope boundary

- Bucket criteria are SIMPLE structured rules (rate threshold + keyword
  list), not a general rule DSL — matches the owner's own "simple rules"
  framing and this codebase's existing primitives. A genuinely more
  complex rule language is explicitly out of scope unless the owner asks.
- The AI overlay reuses `resolveLlmCredential()`/the same graceful-
  degradation posture every other LLM call site in this codebase already
  has (skipped, not failed, when no credential resolves).
- Does not touch the existing green/yellow/red tier or the rate-band
  system shipped tonight — a third, additive, orthogonal signal, same
  "don't touch what's shipped and working" discipline as every other
  additive epic tonight.

## Vertical slices

1. **rank-bucket-core** — types (`GroupConfig.rankBuckets`,
   `StoredGig.rankBucket`), a pure `assignRankBucket()` rule evaluator +
   exhaustive unit tests. No wiring, no AI, no UI yet.
2. **rank-bucket-ai-overlay** — the opt-in AI suggestion pass, mirroring
   `ai-verify.ts`'s call-site/graceful-degradation pattern, wired into
   `apply/runner.ts`, persisted via a new DB column (additive migration,
   same `ensureColumn()` pattern as every prior epic tonight).
3. **rank-bucket-settings-page** — a real settings surface (per-group
   ordered bucket labels + simple rule criteria + optional plain-English
   description + the AI-overlay toggle) — extends `/config/groups` or a
   new small page, decided during implementation research, never another
   addition to the 3000-line `config-client.tsx` mega-form (same standing
   direction as `match-quality-settings-page`).
4. **rank-bucket-filter-and-confirm-everywhere** — the new filterable Rank
   Bucket dimension on `/today`, `/gigs`, `/[group]/gigs` (same shared-
   logic-plus-per-component-UI pattern as `band-filter-everywhere`), PLUS
   the real confirm/override control on the giglist row.

## Open questions

None left unconfirmed — mechanism (both rule + AI), bucket-label shape
(owner-named ordered labels), and the filter-combination question (already
works, new dimension is the gap) are all settled above. Implementation
proceeds directly; this doc is presented for visibility, not another
blocking gate.
