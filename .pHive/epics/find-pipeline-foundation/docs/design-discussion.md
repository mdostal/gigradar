# Design Discussion: find-pipeline-foundation

## 0. Prelude

**NORTH STAR** (from `.pHive/project-profile.yaml`, captured at kickoff 2026-08-10):
- **Goal:** Track engagements end-to-end (applied → interview → outcome), gather throughput metrics, weekly overview + deep-dive + suggestions. Ships first as a standalone local app + dashboard; Pantheon-plugin port is explicitly later.
- **Audience:** Owner first, but generically OSS — single-user, local, self-configured.
- **Scale:** Single-user, single-machine. No hosted/multi-tenant in v1.
- **Pain points:** The current private tool is flaky — flat-JSON store patched by manual `.bak` files, no tests, unreliable cron. Bar for the rewrite: fully tested, working, consistent.

No prior KG decisions found for this requirement (`kg_why` query returned zero results — clean slate, this is genuinely the first epic on this project).

## 1. What Are We Doing?

Building the FIND half of gigradar for real: real `Source` plugin adapters
(today there is exactly one, and it's a hardcoded fixture), a real persistence
layer (today there is none — `runRadar()` dedups in-memory per run and forgets
everything when the process exits), and a role-area tiering layer on top of
the existing gate (green/yellow/red "worth a look" classification, which
today doesn't exist — the gate only returns pass/fail).

"Done" for this epic: running the radar twice in a row, a gig seen in run 1
is still known in run 2 (not re-flagged as new, status preserved), a gig that
disappears from a source that's still working gets flagged unavailable
(without false-flagging everything when a source merely errors), Braintrust
and BuiltIn (both confirmed, see §3 step 4) return live, gated, tiered
results, and all of it has tests — directly answering the stated pain point
("flaky, inconsistent, no tests").

Out of scope for this epic (explicitly, to avoid the scope-creep risk flagged
in research): the assisted-apply/drafting layer (`stageApplication` stays a
stub), gated auto-apply, the dashboard/config UI, and porting all 10 legacy
sources — this epic ships the foundation two or three sources are built on,
not the full catalog.

## 2. What I Found

- `src/lib/apply/runner.ts` already implements discover→gate→dedup correctly
  and safely (per-source try/catch, throws surfaced as `errors[]`, never a
  silent empty result) — this is the seam the new persistence and tiering
  layers plug into, not a rewrite.
- `src/lib/sources/example-source.ts` is the *only* source today, and it's a
  static fixture. Zero real fetch/auth/normalize code exists locally — every
  real adapter is new work.
- The private predecessor (`the legacy tool's codebase`) already solved
  these three problems once, imperfectly. Its `store.mjs upsertScan()` has a
  genuinely good delisting-detection algorithm: it only flags a gig
  `unavailableSince` if its *source* returned results this run (tracked via
  an `activeSources` set) but that specific gig didn't reappear — this avoids
  the obvious bug of flagging an entire source's gigs as gone when the scrape
  merely failed. Worth porting the *logic*, not the code (see research brief
  §3 for the reasoning).
- The same legacy store has real fragilities we should not repeat: no atomic
  writes, no locking, and — worst — the source list is duplicated between
  `run.mjs` (10 sources) and `server.mjs` (3 sources), silently drifting.
  One source-of-truth registry is a hard requirement for the new runner.
- Legacy tiering (green/yellow/red) lives in `config.mjs` as keyword lists
  tightly coupled to the owner's personal role search — there's no existing
  generic TS equivalent to build against; this is new design, informed by
  the legacy *shape* (title-first precedence, word-boundary matching) but
  not its content.
- `ApplicationDraft.status: "draft"|"approved"|"submitted"` is already typed
  in `runner.ts`, unused. It's out of scope to implement this epic, but the
  persistence schema should not paint itself into a corner that makes wiring
  it up later awkward.

## 3. My Proposed Approach

1. **Persistence layer first** (`src/lib/store/` — name TBD in stories). This
   is the highest-risk unknown (open question #1) and the adapter/runner
   integration work reads through it. Given the north-star framing
   (single-user, local, download-and-run, no server) I'd lean SQLite over
   another flat file — it gets us atomic writes and real querying for free,
   which directly kills the two worst legacy fragilities (no-atomic-write,
   no-locking) without hand-rolling either. **Concurrency constraint (team
   review — architect):** a Next.js dev server process and a separate
   cron/CLI runner process will both open the same `.db` file; default
   SQLite journaling can throw `SQLITE_BUSY` under concurrent writers. The
   persistence story must explicitly require WAL mode + a `busy_timeout` +
   a single shared connection module (not a `new Database()` per call site)
   — this is an implementation constraint, not an optional nicety.
   **Module boundary (team review — architect):** all DB access goes through
   `src/lib/store/`'s exported functions, never raw SQL from call sites —
   set this now, while the boundary is cheap, so a future UI epic (has_ui:
   true is already on the project profile, though building the UI is out of
   this epic's scope) doesn't reinvent the access pattern. **File location
   (team review — security-reviewer):** the DB path must default to a
   user-data directory outside the repo (XDG-style, e.g.
   `~/.local/share/gigradar/` or platform equivalent), not a `./data/` path
   inside the working tree — the legacy tool kept `data/gigs.json` in-repo,
   which is one `git add .` from committing gig/status history. Add a
   `*.db`/data-dir pattern to `.gitignore` as belt-and-suspenders regardless
   of the default path. This is a genuine team-review decision, not settled
   unilaterally here — confirm with the user alongside open question #1.
2. **Port the delisting-detection + status-preservation logic** into the new
   store's upsert path, as a redesigned single status enum (not copied from
   the split legacy enum — research brief flagged this as an inconsistency
   risk).
3. **Tiering module** (`src/lib/matching/tiering.ts`), a pure function
   alongside `gate.ts`: takes a `Gig` + a *user-configured* role-area config
   (not hardcoded keywords) and returns green/yellow/red + why. Wire it into
   `runRadar()` after `gate()`, same pattern as gate's reason-accumulator.
   **Type gap (team review — architect + researcher, independently
   confirmed):** `MatchResult` in `types.ts` has no `tier` field today — this
   needs an explicit type change (extend `MatchResult` or wrap it) named in
   the tiering story, not improvised mid-implementation. **Sequencing
   correction (team review — tpm):** tiering is a pure function of `Gig` +
   config with no store dependency — it does NOT actually depend on the
   persistence layer landing first. The persistence-first ordering in §8 is
   a scheduling choice for this single epic, not a real dependency; story
   `depends_on` edges should reflect that tiering can proceed independently
   of persistence.
4. **2 real Source adapters, committed scope — not "2-3."** (Revises an
   earlier draft that both asserted a preference and left selection open —
   grill H1 — and left A.Team as an ambiguous "stretch" — flagged
   independently by tpm and security-reviewer as a real prerequisite gap,
   not a nice-to-have.) Per legacy `platforms.mjs`, **Braintrust** and
   **BuiltIn** are both public boards (`scrape:true`, no take-rate, no
   headed-browser requirement, `auth: "none"`) — committed for this epic.
   **A.Team is explicitly OUT of this epic's committed scope**, not a
   stretch goal: it needs a `google-oauth` session, which collides directly
   with the still-open local-config/secrets-storage design (§5). Pulling it
   in here would force an ad-hoc session-reference scheme under time
   pressure — exactly what the deferral exists to prevent. A.Team becomes
   in-scope only after that separate secrets-storage decision lands, in a
   follow-on epic. GoFractional stays deferred for the same reason plus its
   Cloudflare-gated, headed-only session requirement (`gf-driver.mjs`).
5. **Tests throughout**, not bolted on at the end — this is the epic whose
   entire mandate is "fully tested, working, consistent." Given `test_absence:
   true` at kickoff, methodology resolution will very likely default to
   `classic` (no existing test-first signal to detect); stories should still
   each carry real unit tests, not defer them to a follow-up epic.
   **Fixture-sanitization requirement (team review — security-reviewer):**
   recorded HTTP response fixtures for adapter tests may carry PII (names,
   emails, phone numbers in job descriptions/contact blocks). Each adapter
   story's acceptance criteria must include scrubbing/redacting fixtures
   before they're committed to the repo — not assumed safe by default.

## 4. What Could Go Wrong

- **High — persistence choice is genuinely undecided.** If we guess wrong
  (e.g. pick something that doesn't fit "single-user local install, no
  server process"), later stories inherit the mistake. This is exactly why
  it's the first open question, not a design-discussion-level decision made
  unilaterally here.
- **Medium — real adapters can't be live-verified in this planning/execution
  sandbox.** No authenticated browser session exists here. Tests for real
  adapters need a fixture/recorded-response strategy (capture a real
  response shape once, replay it in tests) rather than hitting live sites in
  CI — otherwise "fully tested" becomes "flaky in a new way."
- **Medium — tiering is new design work, not a port.** Getting the
  precedence rules wrong (title-match-first, word-boundary keyword matching)
  is easy to get subtly wrong; legacy's `config.mjs` comments document the
  precedence order explicitly and should be treated as a spec to translate,
  not just inspiration.
- **Low — scope creep toward apply/UI.** The project profile has `has_ui:
  true` and a rich north-star that includes metrics/weekly-review/dashboard.
  None of that belongs in this epic. Explicitly named out of scope in §1.
- **Medium — SQLite concurrent-writer risk (team review — architect).** A
  Next.js dev server and a separate cron/CLI runner both touching the same
  `.db` file can hit `SQLITE_BUSY` without WAL mode + `busy_timeout` + a
  single shared connection module. Addressed as an explicit constraint in
  §3 step 1 — flagged here because it's a real feasibility risk if that
  constraint gets dropped during implementation.
- **Medium — recorded test fixtures may leak PII (team review —
  security-reviewer).** Job-description/contact-block fixtures captured for
  adapter unit tests can carry names/emails/phone numbers. Addressed as an
  explicit acceptance-criterion in §3 step 5.

## 5. Dependencies and Constraints

- Depends on nothing outside this repo — no other epics exist yet.
- Constrained by `docs/ARCHITECTURE.md`'s core/user-layer boundary: no
  hardcoded personal criteria or credentials land in `src/lib`.
- Constrained by the still-open local-config/secrets-storage design
  (kickoff `decisions_open`) — real adapters that need `auth: "api-key" |
  "browser-session"` will need *some* answer for where the session/key
  reference lives, even if the full backup-mechanism design is deferred.
- No CI exists yet — `npm test` (vitest) is the only current verification
  surface; this epic doesn't need to stand up CI infrastructure itself, but
  should not assume CI exists for verification either.

## 6. Open Questions

1. ~~Persistence technology~~ — **resolved by user**: SQLite, with WAL mode +
   busy_timeout + a single shared connection module per §3 step 1.
2. ~~How many source adapters ship in this epic~~ — **resolved during team
   review**: 2, Braintrust + BuiltIn (both `auth: "none"`, public boards).
   A.Team and GoFractional are explicitly out of this epic's committed scope
   (see §3 step 4) — the auth complexity that made this an open question is
   exactly why they're deferred, not selected around.
3. ~~Scope boundary on gated auto-apply~~ — **resolved**: confirmed out of
   scope for this epic (user selected this exact scope at plan kickoff).
4. **Package manager** — npm assumed (no lockfile committed yet). Confirm or
   correct before stories reference install commands.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest (already configured, zero test files exist today)
  Platforms: Node.js only (no browser/mobile surface in this epic)
  Automated: persistence layer (upsert/dedup/delisting logic) — pure-function
    unit tests; tiering module — pure-function unit tests with golden fixtures
    per rule (mirrors gate.ts's existing testable-pure-function shape); each
    real Source adapter's normalize/parse logic — unit tests against recorded
    fixture responses, NOT live network calls.
  Manual: one explicit, documented one-time live run per shipped adapter
    (grill U1: "done" claims live results but the automated plan was
    fixture-only, an unresolved tension — resolved by making this manual
    step part of each adapter story's acceptance criteria, not an implicit
    claim). **Owner/mechanism (team review — tpm flagged this had no owner
    and can't self-satisfy in an unattended agent session):** this is a
    scripted verification step within the `implement` step of the adapter's
    story, not a separate human-only gate — the developer persona (human or
    agent) executing the story runs the adapter against the real site once
    (e.g. `npm run radar -- --source=braintrust`), confirms real `Gig`
    objects with real per-listing URLs came back, and pastes the confirmed
    output into the story's completion notes before the `review` step. Any
    agent session with network access can perform and record this itself.
  Not verifying: end-to-end live scraping in CI (no CI exists yet, and live
    scraping in automated tests is explicitly the flakiness pattern this epic
    exists to move away from). The one-time manual run above is deliberately
    outside CI and not repeated automatically.
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~12-18 (new persistence module + tests, new tiering module
    + tests, 2-3 new source adapters + tests, runner.ts integration changes,
    possibly a shared adapter-testing fixture helper)
  Subsystems: persistence (new), tiering (new), source adapters (new, ×2-3),
    apply/runner (integration point, existing)
  Migration required: no (no existing persisted data to migrate)
  Cross-team coordination: no (single-user OSS project)
  Unknowns: 3 open questions remaining (#1 persistence tech, #3 auto-apply
    scope confirmation, #4 package manager) after team review resolved #2
    (adapter selection) directly in this draft. #1 is still the most
    load-bearing since it gates story-writing for the store itself.

  RECOMMENDATION: Needs H/V planning (not straight to stories)
  RATIONALE: Three genuinely new subsystems (persistence, tiering, adapters).
    Team review (tpm) corrected the initial framing: tiering depends only on
    the existing `gate()`, not on persistence landing first — so the real
    dependency shape is persistence → adapter integration (adapters need
    somewhere to write), with tiering independently parallel. A vertical-
    slice cut (e.g. slice 1: persistence + Braintrust adapter + runner
    integration end-to-end; slice 2: tiering, in parallel with or after
    slice 1; slice 3: BuiltIn adapter) keeps each slice in a genuinely
    working state and reflects the corrected dependency graph, which a flat
    story list risks getting wrong.
```
