# Project CONTEXT

gigradar: an OSS, generic core for finding and interacting with fractional/contract
engagements — plugin-based sources feed an explainable gate/rank pipeline, with
human-approved assisted apply. Single-user, local install.

## Terminology

- **Source** — a plugin (`{ id, label, auth, fetch(cfg, profile) → Gig[] }`) that
  fetches and normalizes listings from one site/board. Registered via
  `registerSource()`. See `src/lib/sources/source.ts`.
- **Gig** — a normalized listing from any Source. `url` is always the real
  per-listing page, never a search URL (data-integrity rule, non-negotiable).
- **Gate** — the pure, deterministic, explainable GO/NO-GO function
  (`src/lib/matching/gate.ts`). Every gig gets a pass/fail plus one reason per
  rule checked — nothing is silently dropped.
- **Needs** — the user's hard gate constraints: `minRate`/`highRate`,
  `maxHours`/`maxHoursAtHighRate` (a higher rate unlocks more weekly hours),
  `allowContractToHire`, `freshStageOnly`, `remoteOnly`.
- **Profile** — who the user is: `roles` (priority order), `skills`, `timezone`,
  optional `homeBase`. Drives fit-matching.
- **MatchResult** — the gate's verdict: `{ gig, pass, reasons[], score }`.
- **Config** — the user's full runtime config (`profile`, `needs`, `sources`,
  `schedule`). Lives in the user's own storage, never in the OSS repo.
- **FIND / INTERACT** — the two halves of the tool. FIND = Source → Gate → Rank
  → shortlist. INTERACT = assisted-apply drafting, staged for human approval,
  never auto-submitted (today — gated auto-apply is a north-star goal, not yet
  built in this core).
- **Role-area tier (legacy term, not yet ported)** — green/yellow/red
  classification of a listing by title/keyword match (word-boundary), used by
  the legacy tool to surface "unknown, worth a look" instead of hard-rejecting.
  See `project-profile.yaml → legacy_source`.
- **4-check auto-apply gate (legacy term, not yet ported)** — FIT (tier=green) +
  ECONOMICS (clears rate floor) + LIVE & NEW (not already applied/stale) +
  FILLABLE (a human-reviewed draft exists). All four must pass before a channel
  with working submit automation is allowed to auto-fire.
- **Channel auto-fire capability (legacy term)** — a Source-specific flag,
  separate from the gate: only sources with a working logged-in submit
  automation may ever auto-apply; everything else is draft/surface only.

## Key paths

- `src/lib/types.ts` — source of truth for all domain types; every other module
  imports from here.
- `src/lib/matching/gate.ts` — the gate implementation.
- `src/lib/sources/source.ts` — the Source plugin contract + registry.
- `src/lib/sources/example-source.ts` — reference/demo Source.
- `src/lib/apply/runner.ts` — CLI entry point (`npm run radar`); INTERACT layer
  not yet implemented here.
- `docs/ARCHITECTURE.md` — the design contract; read before touching core.
- `.pHive/project-profile.yaml → legacy_source` — inventory of what to port
  from the private predecessor tool and what to deliberately leave behind.

## Conventions

- Core (`src/lib/*`, future `src/app/*`) must never hard-code any specific
  user's data — adding a source or changing rate rules requires config + a
  plugin only, zero core edits. See `docs/ARCHITECTURE.md`.
- A Source that needs a login throws on auth failure — it must never silently
  return zero results (an expired session must not look like "no matches").
- Secrets are always referenced (env/keychain/session-profile), never stored
  raw in `Config` or committed to the repo.

## Canonical references

- `docs/ARCHITECTURE.md` — full design contract (layers, contracts, auth,
  data-integrity rules, build-out roadmap).
- `README.md` — project pitch and the source-plugin extension example.
- `.pHive/project-profile.yaml` — discovery findings, north_star, and the
  legacy-tool porting inventory.
