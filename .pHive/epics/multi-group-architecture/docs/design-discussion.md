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

**Core idea**: introduce a `Group` as the new unit of "one search" — `{id, label, needs, roleArea?, sources: SourceConfig[]}` — replacing today's flat `needs`/`roleArea`/`sources` top-level `Config` fields with `Config.groups: GroupConfig[]`. Everything *specific to what you're searching for and where* moves inside a group; everything *about you as a person* stays global.

**What stays global (shared across every group)**: `Profile` (name, skills, timezone, homeBase) and `applyProfile` (contact info used to fill out real applications) — you're still one person regardless of which search a gig came from. `schedule` also stays global for v1 (one croner cadence covers every group's sources in one cycle) — a per-group schedule is a plausible later refinement, not required for the core ask.

**What becomes per-group**: `needs` (rate/engagement accept-criteria), `roleArea` (title/keyword classifier), `sources[]` (which boards/adapters feed this group, and their own settings).

**Gig store**: add `group_id TEXT NOT NULL DEFAULT 'default'` to the `gigs` table (via the existing `ensureColumn()` migration pattern — additive, non-destructive), change the unique index to `(group_id, source_id, external_id)`. Every one of the owner's 1674 real existing gigs becomes `group_id: 'default'` automatically on first migration — no re-scan, no data loss, no manual config edit. The matching runner stamps `group_id` onto every gig it persists, using whichever group owns the source that produced it.

**Matching pipeline**: `runRadar()`'s loop changes from "one global needs/roleArea applied to every source" to "for each enabled source, look up its owning group, apply that group's needs/roleArea." This is the one real logic change in `gate.ts`/`tiering.ts`'s caller — the pure functions themselves don't need to change at all, just what gets passed in per source.

**Config storage**: stays ONE `config.json`, one encryption envelope — `groups: GroupConfig[]` replaces the flat fields. A migrate-on-read step (mirroring the existing `migrateNeedsEngagementProfiles()` precedent already in `config/load.ts`) wraps a legacy flat config into a single implicit `default` group the first time a pre-migration `config.json` is read — the owner's real file needs zero manual editing to keep working.

**Dashboard/config UI**: a group switcher in the nav; `/` and `/config` become group-scoped (either a `?group=` query param or a `/[group]/` route segment — open question below), defaulting to the single existing group so a not-yet-multi-group install looks and behaves exactly as it does today.

**MCP server**: `list_gigs`/`get_status_summary` gain an optional `groupId` filter (default: all groups); `run_scan` either takes an explicit `groupId` or runs every group's sources in one call.

## 4. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Migration silently mis-tags or loses real gig data | High | Additive-only DB column with a hardcoded default; migrate-on-read for config; live-verify against a COPY of the real DB before touching the real one |
| `saveConfig()`'s shallow-merge means a naive `groups[]` edit UI could accidentally drop other groups on save | Medium | Config UI must always resend the full `groups[]` array on any edit — same discipline `sources[]` already requires; add a test asserting this |
| Scope creep — this touches 65+ files and two 1000+/2500+-line client components | High | Vertical-slice this hard: ship the DATA MODEL + migration first (group_id column, Config.groups, matching pipeline) with the dashboard still showing everything unfiltered as one view, THEN add the group switcher/dashboard-scoping as a separate slice |
| A single registered `Source` (fixed id, e.g. `wellfound`) can't currently be configured twice under two different `SourceConfig.id`s for built-in adapters (only custom-llm/gmail-digest sources support arbitrary ids) — this could block a real "same board, two groups" use case | Medium | Out of scope for v1 unless the owner actually needs it; flag as an explicit non-goal for the first cut |

## 5. Dependencies

- None blocking — this can start independently of the Mnemosyne integration or anything else outstanding.
- Should land before any further dashboard redesign work, since dashboard-client.tsx is one of the two largest hot spots this touches.

## 6. Open questions — need the owner's decision before H/V planning proceeds

1. **Route shape**: `?group=<id>` query param (simpler, no new file structure) vs. `/[group]/` dynamic segment (cleaner URLs, matches the one existing dynamic-route precedent in this codebase). Recommend query param for v1 — smaller diff, trivially upgradable later.
2. **Cross-group source reuse**: can the SAME source (e.g. Wellfound) ever need to be enabled in two different groups with different settings? If yes, this needs its own design (built-in adapters are looked up by a fixed registered id today, not user-chosen). Recommend: **not supported in v1** — a group's sources are its own; if the owner later needs the same board in two groups, that becomes its own follow-up story.
3. **Default group naming/first-run UX**: on migration, the owner's existing real search becomes group `default`. What should the UI call it? Recommend prompting once, post-migration, to rename it (e.g. "Fractional/Job Search") rather than guessing a name.
4. **Scheduler**: confirmed — one shared schedule/cron cadence for v1, cycling every group's sources in one pass. A per-group schedule is a real but separate future story if it turns out to matter.

## 7. Scale assessment

**Large.** Multi-system (store schema, matching pipeline, scheduler, config storage/encryption, dashboard UI, config UI, MCP server), a real data migration over live production data, and long-horizon (this is the foundation the owner's future "drone stuff" vertical builds on, not a one-off feature). Per the standard process this warrants full horizontal + vertical planning and a structured outline before story decomposition — not a shortcut.

**Recommended first vertical slice** (to validate the whole shape cheaply before touching the two largest UI files): data model + migration + matching pipeline only, with the dashboard/config UI still showing one unfiltered view across all groups. This alone is independently shippable, live-verifiable against the real (1674-gig) database, and de-risks everything downstream before any UI work starts.
