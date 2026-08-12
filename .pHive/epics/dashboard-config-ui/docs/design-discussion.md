# Design Discussion: dashboard-config-ui

## 0. Prelude

**NORTH STAR** (from `.pHive/project-profile.yaml`):
- **Goal:** Track engagements end-to-end; single-user, self-configured.
- **Audience:** Owner first, but generically OSS — download-and-run locally.
- **Scale:** Single-user, single-machine.
- **Pain points:** The prior tool was flaky/inconsistent; the bar is fully
  tested, working, consistent.

No relevant prior decisions (a prior-decisions query matched unrelated
cross-project noise from the shared global knowledge graph, not gigradar
history — treated as zero results).

## 1. What Are We Doing?

Building gigradar's first UI: this is a genuine blank slate — no
`src/app/`, no styling framework, no `next.config.js` exist yet. Two
backend surfaces are ready to consume (the SQLite store, `loadConfig()`);
one critical gap was found during research that reshapes this epic's
scope.

**Proposed scope reduction from the original brief** (research surfaced
this, not an assumption): the original ask bundled four things — dashboard,
config editing, guided browser-session login capture, and role templates.
Research found the login-capture flow is not a form/CRUD problem like the
other three — `withBrowserSession()` is architecturally built to CONSUME an
already-valid session, not create one; a capture flow needs genuinely new,
stateful code holding a live Playwright `Browser` handle across an
indeterminate human-paced interval. That's the epic's single highest-risk,
highest-novelty piece, and cleanly separable: nothing else in this epic
depends on it, and the owner can keep using the already-proven manual CLI
bootstrap in the interim (GoFractional's session is already valid this
way; A.Team will be too once re-authenticated). **Proposed: this epic ships
the dashboard + config read/write UI. Guided session-capture becomes its
own, focused follow-on epic.** Role templates are a smaller, config-UI-
dependent addition — proposed as a lightweight story within THIS epic
(seed data + a "start from template" affordance in the config form) rather
than a separate epic, since they have no independent technical risk once
the config form exists.

"Done" for this epic: the owner can run `npm run dev`, open the dashboard,
see his real gigs (from the store already populated by `find-pipeline-
foundation`/`browser-session-auth`) filterable by tier/status, mark one
applied/interview/archived and see it persist, and edit his `Config`
(profile/needs/sources/roleArea/schedule) through a form that writes back
to `config.json` — without hand-editing JSON or reading TypeScript types
to know the shape.

## 2. What I Found

- Total blank slate: no `src/app/`, no Tailwind/shadcn/any styling
  framework, no `next.config.js`, no ESLint config. This epic pays the
  full first-UI-file setup cost every later UI epic won't.
- `src/lib/store/index.ts`'s API (`listGigs`, `getGig`, `setStatus`,
  `gigKey`) is synchronous, ready to call from Route Handlers/Server
  Actions — but `listGigs()` has no pagination; a dashboard view needs its
  own strategy (client-side slicing is sufficient at current data volumes;
  revisit if it becomes a real problem).
- `src/lib/config/load.ts` has **no write function at all** — must be
  built from scratch, with a specific danger: `loadConfig()` returns
  `env:` references already RESOLVED to real secret values. A naive
  "load, edit in the UI, re-serialize the whole object back to
  `config.json`" write path would silently write real secrets in
  plaintext where only an `env:VAR` reference belongs — a direct violation
  of this project's own non-negotiable secrets rule (see every prior
  epic's design discussion). The write path must operate on/preserve the
  original unresolved reference strings, never the resolved `Config`
  object.
- `src/lib/auth/browser-session.ts`'s `withBrowserSession()` is
  unconditionally-cleanup, single-await-chain, requires a pre-existing
  valid session file — confirmed via full code read, not assumption, that
  it cannot be repurposed for capture; `docs/ARCHITECTURE.md` itself
  already frames the intended design as new, separate capture code
  producing the same plain storageState file format.
- `filterStorageStateToAllowlist()` (exported from `browser-session.ts`)
  IS reusable by a future capture flow — worth noting for that follow-on
  epic's research, not needed here.

## 3. My Proposed Approach

1. **App-router + styling scaffold** (`src/app/layout.tsx`, a root
   `page.tsx`, Tailwind CSS — the de facto Next 15 default, no reason to
   hand-roll CSS for a form-and-table-heavy dashboard). `next.config.js`
   with the `NODE_OPTIONS=--experimental-sqlite` concern already handled
   by existing package.json scripts.
   **Concrete first-story verification** (team-review finding —
   architect: "an early explicit verification step" wasn't testable as
   written): the FIRST story's acceptance criteria must include a trivial
   store call (e.g. `listGigs()`) inside a Server Component or Route
   Handler, exercised under both `next dev` and `next build && next
   start`, confirming no `node:sqlite`/experimental-flag failure — before
   any dashboard UI work proceeds on top of it.
   **Localhost-only binding, decided now** (team-review finding —
   security-reviewer, a real gap: Next's `next dev`/`next start` bind
   `0.0.0.0` by default, and this design has zero auth layer): the `dev`
   and `start` scripts are updated to bind explicitly to `127.0.0.1` (via
   `next dev -H 127.0.0.1` / `next start -H 127.0.0.1`), documented as the
   default, not left implicit. Anyone on the same LAN reaching an
   unauthenticated dashboard could read gig/pipeline data and edit
   `config.json` (redirecting `env:` references, changing sources/schedule)
   — unacceptable for a default given this project's "local, single-user"
   framing. A user who deliberately wants LAN access can override the
   host flag themselves; that's their explicit choice, not this epic's
   default.
2. **Dashboard/results view** (`src/app/page.tsx` or `src/app/dashboard/`):
   server-rendered list of gigs from `listGigs()` (a Server Component —
   team-review finding, architect: the read side needed an explicit
   API-surface decision, not left unstated), each row showing
   source/title/company/rate/hours/tier/status/seen-date, with actions
   (buttons/select) to call `setStatus()` via a Server Action (mutations
   go through Server Actions throughout this epic — reserving Route
   Handlers for cases needing a plain HTTP contract, none identified yet).
   **Concrete filter/sort spec** (team-review finding — ui-designer:
   "filterable by tier/status" was too vague to build from): tier is a
   single-select tab group (All / Green / Yellow / Red, mirroring the
   legacy tool), status is a separate multi-select (checkboxes: New /
   Applied / Interview / Archived / Ignored), the two axes combine as AND.
   Default sort is `firstSeen DESC` (matching the store's existing
   default order) with a company/title text search box — named explicitly
   now because at real data volumes (164 gigs in the legacy tool's own
   screenshot) two filter axes alone risk an unstructured wall of rows.
   `Gig.raw` (typed `unknown`) is never rendered via
   `dangerouslySetInnerHTML` — plain text/JSON rendering only, relying on
   React's default escaping (team-review finding — security-reviewer: this
   needed stating explicitly, not left implicit).
3. **Config write path** (`src/lib/config/save.ts` — new): the
   secret-safety-critical piece, with the mechanism DECIDED here, not left
   open (grill H1: an earlier draft left this as an either/or despite
   calling it the epic's highest-stakes item). **Decision: the write path
   always re-reads the raw `config.json` file directly from disk — it
   never derives from or accepts `loadConfig()`'s resolved output.** The
   UI edits a form pre-populated from a SEPARATE raw-read (unresolved
   `env:` strings shown as-is, e.g. an "environment variable reference"
   field distinct from a literal-value field), and saves merge those edits
   onto the raw JSON, never onto anything that ever touched
   `resolveSourceEnvReferences()`. This sidesteps needing to track
   resolution provenance through an edit round-trip entirely — the
   resolved, secret-bearing `Config` object from `loadConfig()` is used
   ONLY by `runRadar()` and never enters the write path at all. Validates
   the edited raw document via `ConfigSchema.safeParse` before writing,
   sets file permissions explicitly on write (mirroring the read-side
   permission-warning pattern already established). Written and tested
   BEFORE the config UI story that consumes it, so this security-critical
   logic gets its own focused review.
   **First-run (no `config.json` yet) — decided, not left implicit**
   (team-review finding — architect, a real gap: `loadConfig()`
   deliberately throws hard on a missing file and never scaffolds one,
   which would make the config UI unusable for INITIAL setup, directly
   contradicting this epic's own "Done" bar): the save path's raw-read is
   ENOENT-tolerant — a missing `config.json` is treated as "start from
   `config.example.json`'s shape, all fields editable, nothing written
   until the user submits" rather than a hard error. The config UI is
   explicitly the first-run setup path, not just an editor for an
   already-valid file.
4. **Config editing UI** (`src/app/config/` or similar): a form covering
   `Profile`/`Needs`/`SourceConfig[]`/`RoleAreaConfig`/`schedule`, calling
   the save path from step 3 via a Server Action. `SourceConfig.settings`
   (opaque `Record<string,unknown>`) gets a key/value pairs editor (add
   row: key, value — not a raw JSON blob) as the v1 UX (team-review
   finding — ui-designer: a raw-JSON textarea directly contradicts this
   epic's own "without hand-editing JSON" done-bar; naming a real, if
   simple, structured editor instead of a blob is a small addition over a
   textarea and keeps the epic honest about what "config UI" means). A
   fully-typed per-source settings schema (source-specific field hints)
   stays deferred — genuinely larger scope, not needed to avoid raw JSON.
5. **Role/engagement templates — MOVED OUT of this epic's committed scope**
   (H/V review finding — tpm: with the app scaffold + write path +
   dashboard + full config UI already representing real Medium-stretching
   scope, templates was the cleanest, lowest-risk unit to cut rather than
   quietly absorb as scope creep). Becomes its own small, fast follow-on
   epic once this one ships — depends only on the config editing UI (step
   4) existing.
6. **Explicitly deferred to a follow-on epic**: guided browser-session
   login/session-capture UI flow. The manual CLI bootstrap remains the
   interim path — already proven working for GoFractional. (Team review —
   tpm: confirmed this satisfies the session's stated goal, since
   GoFractional already works this way; A.Team needs the SAME manual path
   re-run once the owner re-authenticates — `docs/ARCHITECTURE.md`'s
   existing standing-follow-up note already documents this, not a new
   gap.)

## 4. What Could Go Wrong

- **High — the config write path's secret-preservation logic is the
  epic's single highest-stakes correctness requirement.** Getting it wrong
  doesn't fail loudly (a write "succeeds"), it silently leaks a real
  secret into a file that, per the project's own established discipline,
  is supposed to only ever carry a reference. Needs dedicated tests
  proving a round-trip edit-and-save never writes a resolved secret value,
  not just that the save "works."
- **Medium — total blank-slate setup risk.** First app-router file, first
  styling choice, first Server Action in this codebase — more can go
  sideways in scaffolding than in a codebase with established patterns to
  follow.
- **Medium — `NODE_OPTIONS=--experimental-sqlite` threading through Next's
  own dev/build process** (not just the existing `tsx`-invoked CLI runner)
  is unverified — Next's dev server has its own process-spawning behavior
  that may or may not respect the same env var the way `vitest`/`tsx` do.
  Needs an early, explicit verification step, not an assumption.
- **Low — deferring the login-capture flow could read as under-delivering
  on the owner's explicit ask.** Named explicitly here (not silently
  dropped) with a concrete reason (real architectural separation, real
  risk containment) and a committed next step (its own focused epic).

## 5. Dependencies and Constraints

- Depends on `find-pipeline-foundation` (store), `local-secrets-config-storage`
  (config read), and `browser-session-auth` (origin-scoping filter
  reference for the deferred capture epic) — all merged.
- Core/user-layer boundary: templates and UI are generic; the owner's
  criteria stay his local config.
- Self-hosted-only framing carries through docs: this dashboard assumes
  it's running on the same machine the user is browsing from (already
  true of the whole project's design — not a new constraint, just worth
  restating for a UI epic specifically).

## 6. Open Questions

1. ~~Confirm the scope reduction~~ — **resolved by user**: confirmed.
   Dashboard + config UI this epic; login-capture AND role templates
   (the latter cut during H/V review) are both separate follow-on epics.
2. ~~Tailwind CSS as the styling choice~~ — **resolved by user**: confirmed.
3. ~~Config write granularity~~ — **resolved implicitly by the grill-fixed
   write-path mechanism**: full-document replace-on-save (the write path
   always re-reads and re-writes the whole raw `config.json`, per §3
   step 3 — no per-field patching).

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest (existing); manual browser verification for UI/UX (no
    Next.js E2E framework — e.g. Playwright-for-testing — is in scope to
    add this epic; that's a real gap worth naming, not silently accepted)
  Platforms: Node.js + a real browser for manual verification (the
    dashboard itself, unlike browser-session-auth, does not launch
    Playwright — it's a normal Next.js app a human opens in their own
    browser)
  Automated: config save-path unit tests (the secret-preservation
    round-trip is the most important test in this epic — write, re-load,
    assert no resolved secret value ever hit disk); store-reading
    Server-Action/Route-Handler tests against a temp DB; ConfigSchema
    validation-rejection tests for malformed form submissions.
  Manual: opening the dashboard in a real browser, confirming real gigs
    from the actual populated store render correctly, confirming a status
    change persists across a page reload, confirming a config edit
    round-trips through save+reload without corrupting or losing data.
  Not verifying: automated E2E/browser testing (no framework in scope this
    epic — manual verification only); the login-capture flow (explicitly
    a separate epic).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~20-30 (app-router scaffold, Tailwind config, dashboard
    page + components, config page + form components + Server Actions,
    new src/lib/config/save.ts + tests, template seed data)
  Subsystems: Next.js app-router UI (new), config write path (new,
    security-critical), template data (new, small)
  Migration required: no
  Cross-team coordination: no
  Unknowns: 3 open questions above, all need explicit confirmation before
    story-writing — this is a scope-defining design discussion, not just
    an implementation-detail one

  RECOMMENDATION: Needs H/V planning (Medium, not Large — the scope
    reduction above keeps this from needing a full structured outline)
  RATIONALE: Even with the login-capture flow removed, this epic spans a
    genuine blank-slate app scaffold, a security-critical write path that
    must land before the UI that depends on it, and a UI layer built on
    top of both — real cross-layer sequencing (matches find-pipeline-
    foundation's shape: infra-first, consumer-second).
    **Directly engaging why this stays Medium, not Large** (grill H2: an
    earlier draft asserted this without addressing the blank-slate +
    security-critical factors directly): blank-slate setup risk is real
    but bounded and well-precedented (scaffolding a Next.js app-router +
    Tailwind is a known, thoroughly-documented shape, not a genuine
    unknown needing elicitation); the security-critical write path is now
    a DECIDED mechanism (§3 step 3, resolved from grill H1), not an open
    question a structured outline's Risk Registry would need to stress-
    test — it's a clear, testable, three-sentence rule ("always re-read
    raw JSON, never touch the resolved Config"). The epic sequences into
    one infra checkpoint (app scaffold + write path — team-review
    correction, tpm: this is NOT an independently demoable vertical
    slice, since the epic's own "Done" bar can't be met until the
    dashboard renders; it's engineering sequencing, verified by unit
    tests only, and should be tracked/estimated honestly as zero
    user-visible value on its own) followed by two real vertical slices
    (read-only dashboard; config editing UI, including its own
    role-templates story). No cross-system migration and no long-horizon
    unknowns once the three open questions below are answered — that's
    what keeps this Medium rather than Large.
```
