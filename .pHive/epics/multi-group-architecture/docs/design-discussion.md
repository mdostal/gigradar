# Design Discussion: Multi-Group Architecture

**Epic**: multi-group-architecture
**Date**: 2026-09-01
**Status**: DRAFT — awaiting owner review

## 0. Prelude

**Prior decision on record** (`.pHive/project-profile.yaml`): "Single-user, single-machine local install... No concurrent/shared/multi-tenant usage in v1." This is about *multiple users* sharing one install — a different concept from what's being proposed here. This design is single-user, multiple self-defined *groups* within their own install. Worth stating explicitly so this doesn't read as contradicting that charter line.

## 1. Goal

Owner's own words, 2026-09-01: *"once i'm doing drone stuff, I'll want a WHOLE other group and dashboard as well that aligns for THAT -- we have to support ANY use of these."*

Today gigradar assumes exactly one global search: one `Needs` (rate/engagement accept-criteria), one `RoleAreaConfig` (title/keyword classifier), one flat `sources[]` list, one gig table, one dashboard. The owner wants to run genuinely independent searches — today's fractional-CTO job search, and later a completely unrelated vertical ("drone stuff") — side by side in the same install, each with its own accept-criteria, sources, and dashboard view, without losing or disrupting the search that's already running.

## 2. What the research found (real, file-cited — see `.pHive/epics/multi-group-architecture/docs/research-findings.md`... *[not written to a separate file this pass; folded in below since it's short enough]*)

- `Config.sources[]` and `Needs.engagementProfiles[]` are **already arrays** — partial precedent for "named, multiple sets of criteria." `Profile` and `RoleAreaConfig` are strictly singular; `Config` itself is one document, one file (`config.json`, one AES-256-GCM envelope).
- The gig store has **zero group concept**: `gigKey() = sourceId:externalId`, unique index on `(source_id, external_id)` only. 1674 real gigs exist today under this scheme.
- `gate()`/`tier()` (matching/gate.ts, matching/tiering.ts) are pure functions taking exactly one `Needs`/`RoleAreaConfig` — no source-awareness inside either. `runRadar()`'s main loop (`apply/runner.ts:73-111`) applies `config.needs`/`config.profile`/`config.roleArea` to *every* gig from *every* enabled source in one pass — this is the crux of the change.
- Scheduler (`scheduler/index.ts`) is one process, one croner job, one closed-over `Config`.
- Dashboard/config UI is fully flat — no group-scoped routing anywhere, though the app already uses a Next.js dynamic segment elsewhere (`/api/oauth/[provider]/`), so the pattern isn't foreign to this codebase.
- `saveConfig()` is a **shallow top-level merge** — whatever top-level key an edit touches gets fully replaced, not deep-merged. Any `groups[]` top-level array inherits this: an edit to one group must resend the whole `groups[]` array, same constraint `sources[]` already lives with today.
- MCP server's 5 tools all assume one global config/gig set.
- Blast radius: 65 of 105 non-test source files reference `Config` in some form; 42 files explicitly import the type. `dashboard-client.tsx` (1017 lines) and `config-client.tsx` (2552 lines) are the two largest hot spots.
- No prior design exists on this — the epic folder was empty before this research.

## 3. Proposed approach

**REVISED after owner feedback, 2026-09-01** — the original draft below made "group" an *ownership* relationship (one gig belongs to one group, via a source that belongs to one group). The owner corrected this directly: *"100% I could do a software engineer full time role separately from the fractional CTO role separately from a drone photographer role... it can cross over and be in multiple lists but still if we apply, we only apply to the singular gig ONCE."* A gig is not owned by a group — it can legitimately *match* several groups' criteria at once, the same way a gig today can already clear more than one `EngagementProfile` (A/B/C) simultaneously via `matchedProfileIds`. What must stay strictly singular is the gig's own identity and its application status (one gig, one status, one draft, no matter how many group-views it shows up in) — never duplicated per group.

**Core idea**: introduce a `Group` as the new unit of "one search's criteria" — `{id, label, needs, roleArea?}` — replacing today's flat top-level `needs`/`roleArea` `Config` fields with `Config.groups: GroupConfig[]`. A gig gets matched against **every enabled group's** criteria on each scan (not just one owning group's), and records which group(s) it cleared — mirroring `matchedProfileIds` exactly, one level up.

**What stays global (shared across every group)**: `Profile` (name, skills, timezone, homeBase) and `applyProfile` (contact info) — still one person. `schedule` stays global for v1 (one cadence covers every source). **Sources are NOT owned by a single group either** — the same source (e.g. Wellfound) legitimately surfaces gigs relevant to several of the owner's specialties at once, so by default every enabled source's gigs get evaluated against every enabled group's criteria. An optional per-source `groupIds?: string[]` override lets the owner scope a source down (e.g. a drone-parts-specific board obviously shouldn't be evaluated against "fractional CTO" criteria) — omitted means "evaluate against all groups," not "evaluate against none."

**What becomes per-group**: `needs` (rate/engagement accept-criteria) and `roleArea` (title/keyword classifier) only. `sources[]` stays a single global list (each entry optionally scoped to a subset of groups, per the paragraph above) rather than being nested per-group.

**Gig store**: gigs stay globally deduplicated exactly as today — `gigKey() = sourceId:externalId`, the existing unique index on `(source_id, external_id)` is UNCHANGED. Add `matched_group_ids TEXT` (JSON-stringified `string[]`, nullable) to the `gigs` table — the exact same shape/pattern as the existing `matched_profile_ids` column, added via `ensureColumn()`, additive and non-destructive. The matching runner stamps `matched_group_ids` with every group whose `needs`/`roleArea` this gig cleared (can be zero, one, or several). Status, drafts, and outcome tracking are completely untouched by this change — they already live on the gig itself, one per gig, which is exactly the "apply once" invariant the owner needs. The owner's 1674 real existing gigs get matched against groups retroactively on first migration (a one-time re-evaluation pass over already-stored gigs, not a re-scan) — see risk table below.

**Matching pipeline**: `runRadar()`'s loop changes from "one global needs/roleArea applied to every gig" to "for each gig, evaluate it against every group whose scope includes this gig's source, collect every group id it clears." `gate()`/`tiering.ts`'s pure functions don't change signature — they're just called once per (gig, group) pair instead of once per gig, and the results are unioned into `matched_group_ids`.

**Config storage**: stays ONE `config.json`, one encryption envelope — `groups: GroupConfig[]` replaces the flat fields. A migrate-on-read step (mirroring the existing `migrateNeedsEngagementProfiles()` precedent already in `config/load.ts`) wraps a legacy flat config into a single implicit `default` group the first time a pre-migration `config.json` is read — the owner's real file needs zero manual editing to keep working.

**Dashboard/config UI**: a group switcher in the nav; `/[group]/` becomes the real route shape for the dashboard (owner's own decision — see open questions below), each group's page filtering `listGigs()`'s results client- or server-side by `matched_group_ids CONTAINS this_group`. A gig matching multiple groups appears in every one of those groups' dashboards — same gig row, same key, same status, no duplication. `/config`'s Needs/RoleArea sections become per-group (a group picker + per-group form); `sources[]` stays one shared list with an optional per-source group-scope control.

**MCP server**: `list_gigs`/`get_status_summary` gain an optional `groupId` filter (default: all groups, matching the "gig can belong to none/one/many groups" model); `run_scan` runs the shared source list once and evaluates every gig against every in-scope group in that same pass — never once per group.

## 4. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Migration silently mis-tags or loses real gig data | High | Additive-only DB column, nullable, no backfill required (a gig with `matched_group_ids: null` just means "not yet evaluated against the new group scheme" until the next scan re-evaluates it); live-verify against a COPY of the real DB before touching the real one |
| `saveConfig()`'s shallow-merge means a naive `groups[]` edit UI could accidentally drop other groups on save | Medium | Config UI must always resend the full `groups[]` array on any edit — same discipline `sources[]` already requires; add a test asserting this |
| Scope creep — this touches 65+ files and two 1000+/2500+-line client components | High | Vertical-slice this hard: ship the DATA MODEL + migration + matching pipeline first (Config.groups, matched_group_ids, per-gig multi-group evaluation) with the dashboard still showing everything unfiltered as one view, THEN add the group switcher/dashboard-scoping as a separate slice |
| Re-evaluating 1674 existing gigs against the new group scheme on migration could be slow or could change tier/match state visibly if not handled carefully | Medium | Re-evaluation is read-then-write per gig (existing `tier()`/`gate()` pure functions, no network calls) — should be fast even at this scale; live-verify actual timing before committing to "runs inline on migration" vs. "a one-time background pass" |

## 5. Dependencies

- None blocking — this can start independently of the Mnemosyne integration or anything else outstanding.
- Should land before any further dashboard redesign work, since dashboard-client.tsx is one of the two largest hot spots this touches.

## 6. Open questions — RESOLVED by the owner, 2026-09-01

1. **Route shape**: `/[group]/` dynamic segment — **decided**. Matches the one existing dynamic-route precedent (`/api/oauth/[provider]/`) in this codebase.
2. **Cross-group source/gig matching**: **confirmed required from day one**, and the corrected model above (a gig can match zero/one/many groups, mirroring the existing `matchedProfileIds` pattern) makes this the DEFAULT behavior, not an opt-in — no per-source group restriction is required for v1, just supported as an optional narrowing. Owner's own words: *"we need to fix and maintain and have GIGS and then it can cross over and be in multiple lists but still if we apply, we only apply to the singular gig ONCE."*
3. **Default group naming/first-run UX**: on migration, the owner's existing real Needs/RoleArea becomes one group. Recommend prompting once, post-migration, to name it (e.g. "Fractional/Job Search") rather than guessing.
4. **Scheduler**: one shared schedule/cron cadence for v1, cycling every source once and evaluating against every group in that same pass. A per-group schedule is a real but separate future story if it turns out to matter.

## 7. Scale assessment

**Large — confirmed by the owner, run the full process.** Multi-system (store schema, matching pipeline, scheduler, config storage/encryption, dashboard UI, config UI, MCP server), a real data migration over live production data, and long-horizon (this is the foundation the owner's future "drone stuff" vertical builds on, not a one-off feature). Full horizontal + vertical planning and a structured outline proceed next, before story decomposition.

**Recommended first vertical slice** (to validate the whole shape cheaply before touching the two largest UI files): data model + migration + matching pipeline only (`Config.groups`, `matched_group_ids`, per-gig multi-group evaluation), with the dashboard/config UI still showing one unfiltered view across all groups. This alone is independently shippable, live-verifiable against the real (1674-gig) database, and de-risks everything downstream before any UI work starts.
