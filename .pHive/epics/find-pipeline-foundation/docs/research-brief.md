# Research Brief: find-pipeline-foundation

## 1. Summary

gigradar's new core has a working discovery→gate pipeline (`runRadar()`) but the
entire persistence, tiering, and apply/interact layer is unbuilt: zero real
`Source` adapters (one static fixture only), no persistence (in-memory dedup
per run, nothing saved between runs), no role-area tiering, and the apply layer
is a single throwing stub. A private predecessor tool (`the legacy tool's codebase` on
the hive) already solved — imperfectly — every one of these problems: it has
10 wired source adapters, a flat-JSON-file store with a genuinely good
delisting-detection algorithm buried in otherwise fragile code (no atomic
writes, no locking, two divergent copies of the source list), a green/yellow/red
tiering layer, and an interview/application-draft tracking pattern. The epic's
job is to port the *shape* of what works there into tested, generic, real code
here — never the private data or hardcoded criteria.

## 2. Key files & surfaces

**This repo (gigradar):**
- `src/lib/types.ts` — domain contracts (`Profile`, `Needs`, `Source`, `Config`, `Gig`, `MatchResult`). Source of truth all other modules import from.
- `src/lib/matching/gate.ts` — deterministic explainable GO/NO-GO gate. Ported from legacy `gate.mjs`. No tiering layer yet.
- `src/lib/sources/source.ts` — `Source` plugin contract + `registerSource()`/`getSource()` registry.
- `src/lib/sources/example-source.ts` — the ONLY existing "source": returns 2 hardcoded static `Gig` fixtures, ignores all params. Zero real fetch/auth/normalize logic exists locally.
- `src/lib/apply/runner.ts` — `runRadar(config)`: fully implemented discover→gate→dedup pipeline (in-memory only, no persistence). `stageApplication()` and the CLI entrypoint are 100% stubs (`throw new Error(...)` / bare `TODO` comment).
- `docs/ARCHITECTURE.md` — the design contract (core/user-layer boundary, data-integrity rules).

**Legacy predecessor (`the legacy tool's codebase` private, read-only reference — see §7 for the do-not-port list):**
- `platforms.mjs` — 15-entry platform registry (`key, name, url, session, login, scrape, tier, note`).
- `sources.mjs` — per-platform discovery driving named `playwright-cli` sessions (`mat`, `gf`); GoFractional needs a headed, console-owned session (`gf-driver.mjs`) or Cloudflare blocks it.
- `store.mjs` — flat `data/gigs.json`, `upsertScan()` merge function (see §3 for the reusable delisting algorithm).
- `run.mjs` — cron entry point: discover (10 sources, each try/catch-isolated) → gate+tier → persist → report/log.
- `server.mjs` — server-rendered HTML dashboard + mutation routes (`/scan`, `/gig?...action=`, `/prep`, `/settings`) — no JSON API exists; a real UI needs a rewrite, not extraction.
- `config.mjs` / `GATE.md` — hard filter criteria + green/yellow/red role-area tiering + the 4-check auto-apply gate (FIT/ECONOMICS/LIVE&NEW/FILLABLE).
- `interviews/*.status.json` — `{id, state, engine, finishedAt}`; `state` enum at least `generating | ready | scaffold` (under-specified from one sample).
- `application-answer-keys.md` — hand-maintained per-platform field-mapping doc; 100% hardcoded personal data, but the *shape* (universal fields + per-platform field map + guardrails + stop-on-ambiguous-account-state rule) maps directly onto `ApplicationDraft`.

## 3. Patterns & conventions

- **Explainable-everything.** The gate never silently drops a gig; every check appends an `ok()`/`fail()` reason. Any new tiering/persistence code must preserve this (e.g. a delisted gig should be inspectable, not deleted).
- **Throw-on-auth-failure, never silent-zero.** Both `docs/ARCHITECTURE.md` and legacy `run.mjs`'s per-source try/catch enforce this; `runRadar()` already implements it (`errors.push`, loop continues).
- **Delisting-detection algorithm (legacy `store.mjs upsertScan`, worth porting the *logic*, not the code):** track `activeSources = Set(scanned sources this run)`; only flag a stored gig `unavailableSince` if its source *did* return results this run (i.e., is in `activeSources`) but this specific gig didn't reappear. This avoids false-flagging an entire source's gigs as delisted when the source scrape merely failed/errored/returned 0 — a real bug class the new persistence layer must avoid by design, not by accident.
- **User-field preservation on re-scan.** Legacy `upsertScan` spreads fresh scan data over `prev` but explicitly keeps user-set fields (`status`, `firstSeen`) — a re-scan must never clobber "applied" status back to "new".
- **Single source-of-truth for the source list.** Legacy has this wrong (`run.mjs`'s 10-source list vs `server.mjs`'s inline 3-source copy, silently drifting) — a fragility explicitly worth NOT repeating; the new runner + any future dashboard/API must share one registry.
- **`ApplicationDraft.status: "draft"|"approved"|"submitted"`** (already typed in `runner.ts`) maps directly onto the legacy "STAGED FOR REVIEW" human-approval pattern documented in `application-answer-keys.md`.

## 4. Constraints

- **Core/user-layer boundary (non-negotiable, `docs/ARCHITECTURE.md`):** adding a source or changing criteria must require zero core edits — config + a plugin only. No hardcoded personal criteria, keywords, or credentials in `src/lib`.
- **Real URLs only; no fabricated data** — `Gig.url` must be the actual listing page.
- **Secrets never in `Config`** — sources declare `auth: "none"|"api-key"|"browser-session"`; secrets are referenced (env/keychain/session-profile), never stored raw. Ties directly into `decisions_open` from kickoff (local config/secrets storage design is still open).
- **No test infrastructure exists yet** — `vitest` is configured but zero test files exist. This epic is explicitly the "fully tested" bar-setting epic per the project's stated pain point.
- **Package manager unconfirmed** — no lockfile committed (kickoff finding, still open).

## 5. Risks

- **High — persistence design is the epic's riskiest unknown.** No decision has been made yet (flagged `decisions_open` at kickoff). Getting this wrong (e.g., another flat-file-with-no-locking design) reproduces exactly the pain point the epic exists to fix.
- **Medium — real Source adapters need live browser/auth sessions to fetch real data**, which cannot be verified by an automated test run in this planning session (no logged-in session exists in this sandboxed environment). Tests for real adapters will need fixture-based/recorded-response strategies, not live scraping, to be reliable and CI-safe.
- **Medium — tiering logic (green/yellow/red) is a new module with no existing TS equivalent** to build against; legacy `config.mjs` keyword-matching logic is the only reference, and it's tightly coupled to the owner's personal role list (must be genericized, not copied).
- **Low-medium — `server.mjs`'s HTML-string dashboard is not extractable as an API** — any future UI work (separate epic, `has_ui: true` in the profile) will need real JSON endpoints designed from scratch, informed only by *which actions* the legacy UI exposes (scan, filter, mutate status, generate interview prep, settings), not its code.

## 6. Open questions

1. What does the persistence layer target — SQLite (aligns with "local install, single user, no server" framing), or something else? (Carried from kickoff's `decisions_open`.)
2. How many real Source adapters does this epic ship (vs. defer)? Legacy has 10; porting all 10 in one epic is likely too large.
3. Does gated auto-apply (the 4-check gate from legacy `GATE.md`) belong in this epic, or is FIND (adapters+persistence+tiering) the whole scope and INTERACT/auto-apply is a follow-on epic?
4. Package manager confirmation (npm assumed, no lockfile committed).

## 7. Explicitly not porting

Per `.pHive/project-profile.yaml → legacy_source.explicitly_not_porting` and `north_star.avoid`: no hardcoded personal criteria/keywords/credentials, no session files, and not the `.bak`-file backup habit. `application-answer-keys.md`'s *content* is 100% personal data — only its schema shape is a candidate reference, never its values.

## inconsistency_risk_signals

- The legacy tool's `gate()` (in `run.mjs`) returns tiered gigs directly, a different shape than the new TS `gate()` → `MatchResult` contract — a design-discussion draft that casually says "port the gate" risks conflating two different function shapes.
- Legacy `store.mjs`'s status enum is split across two files (`store.mjs` comment vs. `server.mjs`'s route handling of `'interview'`) — a draft that treats "the status state machine" as a single settled artifact to copy would be wrong; it needs to be redesigned as one coherent enum, not copied as-is.
- `has_ui: true` is set on the project profile (from kickoff) but this epic's scope, as scoped by the user, is FIND-side (adapters/persistence/tiering) — a draft that pulls in dashboard/API work under "has_ui" gate pressure would be over-scoping vs. the user's stated epic boundary.
