# Design Discussion: session-capture-ui

## 0. Prelude

**NORTH STAR** (from `.pHive/project-profile.yaml`):
- **Goal:** Track engagements end-to-end; single-user, self-configured.
- **Audience:** Owner first, but generically OSS — download-and-run
  locally, anyone should be able to set up their own sources.
- **Scale:** Single-user, single-machine.
- **Pain points:** The prior tool was flaky/inconsistent; the bar is
  fully tested, working, consistent.

No relevant prior decisions (prior-decisions query matched unrelated
cross-project noise from the shared global KG again — treated as zero
results, same as the last two epics).

## 1. What Are We Doing?

Closing the loop on "log in through the UI" — the piece explicitly
deferred from both `browser-session-auth` (which built the mechanism to
CONSUME a session) and `dashboard-config-ui` (which built everything else
around it). Today, capturing a fresh session still requires the manual
`playwright-cli open --headed` + `state-load`/`state-save` CLI dance. This
epic replaces that with a UI flow: click "capture login" next to a source
in the config UI, a real headed Chromium window opens to that source's
login page, the user logs in normally (including any MFA/OAuth), clicks
"I'm done," and gigradar saves the resulting session — origin-scoped, same
discipline as every prior session-handling epic — ready for
`browser-session.ts` to consume on the next scan.

"Done": the owner can capture a fresh GoFractional or A.Team session
entirely through the UI, without ever touching `playwright-cli` directly,
and the resulting file works identically to a manually-captured one when
`gofractional.ts`/`ateam.ts` next runs.

## 2. What I Found

- `browser-session.ts` is confirmed, by its own file comment and
  `docs/ARCHITECTURE.md`, NOT the mechanism to extend — it's a
  single-await-chain consumer with unconditional cleanup. This epic is
  entirely new code, not a modification.
- The reusable pieces are narrow but real: `filterStorageStateToAllowlist()`
  and `checkChromiumAvailable()` — both exported, both apply identically
  here.
- Per-source origin allowlists currently live INSIDE each adapter file
  (`gofractional.ts`, `ateam.ts`), with no shared registry — a real gap
  this epic must resolve, not route around.
- The established `ActionResult<T>` + `revalidatePath()` Server Action
  convention (from `dashboard-config-ui`) applies directly to this epic's
  new actions.
- The "in-process, long-lived Node server" assumption that makes a
  stateful capture flow possible at all was already validated by
  `app-foundation`'s work (Next.js runs as a real long-lived process here,
  not serverless) — not a new risk, a confirmed precondition.

## 3. My Proposed Approach

1. **Shared origin-allowlist registry** (`src/lib/sources/origins.ts` —
   new, small): exports `SOURCE_ORIGINS: Record<string, string[]>` (e.g.
   `{gofractional: ["gofractional.com"], ateam: ["a.team",
   "platform.a.team"]}`). Both `gofractional.ts`/`ateam.ts` (existing,
   modified to import from here instead of an inline constant) AND this
   epic's capture code import from the same source of truth — resolves
   the research brief's open question #2 by extraction, not duplication.
2. **Capture session store** (`src/lib/auth/session-capture.ts` — new): an
   in-memory `Map<captureId, {browser: Browser; context: BrowserContext;
   startedAt: number; sourceId: string}>`.
   **`globalThis`-pinned, not a plain module-level variable** (team-review
   finding — architect, a real and critical gap: `next dev`'s Hot Module
   Reloading re-evaluates a module on ANY edit to it or its import chain —
   a far more common event during active development than a full server
   restart — which would silently reset a plain module-level `Map` to
   empty while the OLD module instance still holds the live
   `Browser`/`Context`, unreachable by subsequent Server Action calls.
   This is the same well-known class of bug that forces the
   `globalThis`-singleton pattern for DB clients in Next dev (e.g.
   Prisma's documented workaround) — this module follows the identical
   pattern: `const captures = globalThis.__gigradarCaptures ??= new Map()`.
   Full-restart data loss (§4) is a separate, smaller, already-acknowledged
   risk; HMR-survival is the primary design requirement.
   **Disconnect detection** (team-review finding — architect: if a user
   closes the actual Chromium window directly, rather than clicking
   Cancel, the map entry would otherwise linger up to the idle timeout
   showing a stale "waiting" UI state): register `browser.on("disconnected",
   ...)` at `startCapture()` time to immediately mark/remove that capture
   entry, so a closed window fails fast rather than waiting out the full
   timeout.
   - `startCapture(sourceId: string, loginUrl: string): Promise<{captureId: string}>`
     — checks Chromium availability, launches a FRESH headed context (no
     storageState — this is creating a session, not consuming one),
     navigates to `loginUrl`, stores the handle keyed by a new
     `crypto.randomUUID()`, schedules an idle-timeout cleanup (see below),
     returns the id.
   - `finishCapture(captureId: string): Promise<{path: string}>` — looks
     up the handle, calls Playwright's own `context.storageState()` (no
     path arg — get the object back), applies
     `filterStorageStateToAllowlist()` using that source's allowlist from
     the registry.
     **Sanity check before write** (team-review finding — architect: a
     real correctness gap — `filterStorageStateToAllowlist()` was only
     ever proven against already-known-good files from manual capture; a
     fresh OAuth/SSO login could store a needed token on an IdP origin the
     allowlist doesn't cover, and filtering would silently strip it,
     producing a non-empty-but-broken file reported as "success"): after
     filtering, verify the result has at least one cookie for the target
     source's own origin; if empty, fail explicitly ("captured session has
     no usable cookies for this source — login may not have completed, or
     required a cross-origin cookie this tool doesn't yet support") rather
     than writing and reporting success.
     **Atomic, all-or-nothing write** (team-review finding —
     security-reviewer: no partial/empty content may ever reach disk,
     including on the timeout-vs-finishCapture race): write to a temp file
     in the same directory, then rename — never a direct write that could
     leave a truncated file on a mid-write crash — and any error at any
     step (missing handle, closed browser, empty-after-filter) aborts
     before touching the destination path at all.
     **File permissions** (team-review finding — security-reviewer: a
     gap, not previously stated): the written file is created with mode
     `0600`, matching the discipline already established for `config.json`/
     `.env`.
     **No debug capture, ever** (team-review finding — security-reviewer):
     the capture browser context is launched with NO tracing, HAR
     recording, video, or console/network logging enabled — an explicit
     constraint on this code path specifically, since any future debug aid
     added here could inadvertently persist credential-bearing form data
     to disk. `storageState()` itself only captures cookies/localStorage,
     never form input, but this constraint guards against that changing
     later.
     Writes to `<getDefaultDataDir()>/<sourceId>-session.json` (grill H1's
     decided, derived naming — not caller-supplied), overwriting any prior
     capture for that source (no versioning). Closes the browser, clears
     the timeout, removes the disconnect listener and map entry, returns
     the written path (for the UI to optionally use in step 3's
     auto-fill).
   - `cancelCapture(captureId: string): Promise<void>` — closes the
     browser and removes the map entry without writing anything.
   - **Idle timeout, decided (research brief open question #1)**: 10
     minutes from `startCapture()`. A `setTimeout` per capture closes the
     browser and removes the map entry if `finishCapture()`/`cancelCapture()`
     never arrive — named explicitly rather than left as an unbounded
     leak. Documented as a real, known limitation that a `next dev`
     hot-reload or crash still orphans the actual OS-level Chromium
     process (the in-memory map itself doesn't survive a restart either)
     — not solved by this epic, called out honestly.
3. **UI flow** (`src/app/config/` extension, or a new
   `src/app/config/sessions/` — final route TBD in story-writing): a
   "Capture login" button per browser-session-auth source in the config
   UI. Click → `startCapture()` Server Action → UI shows "a browser window
   opened — log in, then click 'I'm done'" with a Cancel button → user
   completes login in the real Chromium window → clicks "I'm done" →
   `finishCapture()` Server Action → UI confirms success and (optionally)
   offers to auto-fill that source's `sessionStatePath` setting via
   `saveConfig()` (reused from `config-write-path`).
   **No polling** (research brief open question #3, decided): the flow is
   entirely user-driven via the explicit "I'm done" click — simpler for
   v1, and there's no reliable way to detect "login complete" generically
   across different sites' auth flows anyway (some redirect, some don't;
   MFA timing varies).
4. **Chromium binary + headed-only, reused conventions**: `checkChromiumAvailable()`
   reused as-is; headed-only (no headless option) matches
   `browser-session.ts`'s confirmed, tested constraint.

## 4. What Could Go Wrong

- **High — leaked Chromium processes on abandoned captures**, the epic's
  most novel failure mode (nothing in this codebase has needed
  cross-request cleanup before). The 10-minute idle timeout is the
  primary mitigation; needs a real test proving it actually fires and
  closes the browser, not just that the timer is set.
- **Medium — server restart mid-capture orphans the actual browser
  process**, independent of the in-memory map (which is also lost on
  restart). Named explicitly as a known, accepted limitation for v1 — a
  full fix (e.g. tracking PIDs on disk, sweeping orphans on server start)
  is real additional scope, not silently promised.
- **Medium — origin-registry extraction touches two existing, already-shipped
  adapter files** (`gofractional.ts`, `ateam.ts`) — a real, if small,
  regression risk on working code. Needs their existing test suites to
  stay green after the extraction, not just the new registry's own tests.
- **Low — UI complexity of "a window opened somewhere, go find it."** On
  a multi-monitor or multi-desktop setup, a newly headed Chromium window
  might not be immediately visible/focused. Not solvable generically;
  worth a one-line UI hint ("check for a new browser window") rather than
  silently assuming it's obvious.

## 5. Dependencies and Constraints

- Depends on `browser-session-auth` (origin-scoping filter, Chromium
  check — both reused) and `dashboard-config-ui` (Server Action
  convention, config write path, the Next.js app itself) — both merged.
- Self-hosted-only, same-machine constraint — already named, reconfirmed
  as directly load-bearing now.
- Core/user-layer boundary as always.
- **Real dependency graph correction** (team-review finding — tpm: an
  earlier draft implied a clean chain, registry → mechanism → UI, but the
  UI story needs the origin registry too — to enumerate which sources
  support capture and their login URLs — not just the capture mechanism).
  The actual graph is UI depending on BOTH prior stories, not a linear
  chain. Stated explicitly here so the UI story doesn't independently
  redefine source eligibility.

## 6. Open Questions

1. ~~Route/placement~~ — **decided**: within `/config`, next to each
   browser-session source's settings (keeps session management co-located
   with the source it's for, per the design's own leaning).
2. ~~Auto-write captured path?~~ — **decided**: yes, auto-write into
   `SourceConfig.settings.sessionStatePath` via `saveConfig()` on
   successful capture — directly serves the "no hand-editing JSON" bar.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest; playwright (already a dependency)
  Platforms: Node.js + a real headed browser environment for manual
    verification (same class of requirement as browser-session-auth)
  Automated: session-capture.ts unit tests — startCapture/finishCapture/
    cancelCapture happy paths (mocking Playwright's chromium.launch);
    idle-timeout test PROVING the timer actually closes the browser and
    clears the map entry (not just that setTimeout was called);
    globalThis-pinning test proving state survives a simulated module
    re-evaluation (not just a fresh process); disconnect-listener test
    (simulating the mocked browser emitting "disconnected" and confirming
    fast cleanup, not a wait for the full timeout); empty-after-filter
    sanity-check test (a storageState with zero cookies for the target
    origin after filtering must fail, never write); atomic-write test
    (an error mid-finishCapture must leave no partial file on disk);
    file-permission (0600) test; origin registry extraction tests
    (gofractional.ts/ateam.ts's EXISTING test suites must stay green,
    PLUS an explicit diff-level check that the extracted allowlist values
    are byte-identical to the pre-extraction inline constants — team-review
    finding, tpm: green tests alone only prove tested behavior is
    preserved, not that the values themselves didn't silently change);
    Server Action tests for the new capture actions using the established
    ActionResult convention.
  Manual: **primary verification against a throwaway/test account or a
    local mock login page, NOT the owner's real GoFractional account**
    (team-review finding — tpm: making a real account login the primary
    proof of brand-new, unproven stateful capture code risks session
    invalidation, MFA lockout, or anti-bot flags on a live account this
    project actually depends on — conflating "does capture work" with
    "did I just break my working session"). Once the mechanism is proven
    against a low-stakes target, a single confirmation pass against the
    real GoFractional account is the final check, not the first one.
    End-to-end: click capture, log in, click done, confirm the resulting
    storageState file is
    valid and gofractional.ts's adapter works against it on the next scan.
  Not verifying: automated E2E browser testing of the capture UI itself
    (no E2E framework in scope, matching dashboard-config-ui's same
    gap) — manual verification only for the UI flow.
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~10-14 (new session-capture.ts + tests, new origins.ts
    registry + adapter modifications, new/extended UI route + Server
    Actions + tests)
  Subsystems: capture mechanism (new, stateful — genuinely novel pattern
    for this codebase), origin registry (new, small, touches 2 existing
    files), UI (extension of existing config UI)
  Migration required: no
  Cross-team coordination: no
  Unknowns: 2 open questions above, both low-stakes/quick to confirm

  RECOMMENDATION: Proceed directly to stories (Small)
  RATIONALE: **Directly engaging the novel-failure-mode risk** (grill H2:
    an earlier draft asserted Small without addressing why §4's "most
    novel failure mode in this codebase" claim doesn't push this to
    Medium): the risk is managed by story-level isolation, the same
    pattern that made Small/Medium defensible in every prior epic with a
    high-stakes single piece (config-write-path in dashboard-config-ui,
    persistence-layer-sqlite in find-pipeline-foundation) — the capture
    mechanism gets its OWN story with undivided review attention
    (including a dedicated test proving the idle-timeout actually fires
    and closes the browser, not just that a timer was set), separate from
    the registry extraction and the UI work. Three cleanly-dependency-ordered
    stories (registry extraction → capture mechanism → UI), no
    cross-subsystem sequencing complex enough to need H/V slicing — the
    novelty is real but contained to one story, not diffused across the
    epic.
```
