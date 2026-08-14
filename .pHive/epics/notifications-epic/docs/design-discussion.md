# Design Discussion: notifications-epic

## 0. Prelude

**NORTH STAR**: gigradar surfaces things that need the owner's attention
as durable, severity-tiered issues — not just a console line he has to
be watching a terminal to see, and not just a desktop notification that's
easy to miss and leaves no record once dismissed. Owner's exact directive
(2026-08-14, while live-verifying the GoFractional Cloudflare blocker):
"we just note it, then work with a human to get human verification, then
we are good again for a week... add a notifications epic behind the
others... we do a warning, then the error symbol etc for different levels
of issues that need to be addressed to help you keep moving forward on
gigs and doing so quickly."

This epic is the general mechanism. It does NOT rebuild the GoFractional
submit adapter (still paused, task #43) — it builds the thing that
adapter (and everything else) will report through once it exists.

## 1. What Are We Doing?

1. **A durable `issues` store** — severity-tiered (`warning` | `error`),
   sourced from anywhere in the codebase, surviving past a single
   terminal session or a dismissed desktop notification.
2. **`raiseIssue()`** — the one function anything in gigradar calls to
   report something needing attention. Persists + fires a best-effort
   desktop notification (reusing `src/lib/notify/desktop.ts`, unchanged).
3. **Real call sites wired now** (not speculative): `runRadar()`'s
   existing per-source fetch errors, and the scheduler's existing
   auto-draft/auto-fire per-gig failure paths — both already exist and
   already just `console.error`, invisible unless someone's watching the
   terminal. This epic doesn't invent new failure modes, it gives
   existing ones a real home.
4. **A dashboard surface** — an "Issues" indicator in the nav (badge with
   an open-issue count, colored by highest open severity) and a page to
   view/resolve them.

Explicitly NOT in scope: any new adapter-side "needs human verification"
error type (that's the GoFractional/submit-adapter epic's own job, once
it resumes — this epic just gives it somewhere to report through);
email/SMS/Slack notification channels (desktop only, matching the
existing mechanism); auto-resolution logic (an issue clears only when a
human resolves it, or a future story explicitly adds auto-clear for a
specific case).

## 2. What I Found

- `src/lib/notify/desktop.ts` already exists, fully built and tested
  (`sendDesktopNotification()`, zero deps, `osascript`/`notify-send`,
  untrusted-content sanitization) — this epic reuses it as-is, never
  duplicates it.
- `runRadar()` (`src/lib/apply/runner.ts`) already collects per-source
  fetch errors into `errors: {sourceId, message}[]` — but the CLI
  (`main()`) is the only consumer that does anything with them
  (`console.error`); the scheduler's own cycle currently drops them
  entirely after logging (`src/scheduler/index.ts`'s `runCycle()`).
- The scheduler already has two per-gig failure catches with the exact
  "one clear line, never crash the cycle" discipline this epic wants to
  build on top of: `runAutoDraft()`'s drafting-failure catch, and
  `attemptAutoFire()`'s two catches (evaluation failure, submit failure)
  — see `graduated-auto-fire-trust` epic, just shipped.
- No existing `issues`/similar table in `src/lib/store/schema.ts`.
- `src/app/nav-header.tsx` is a small, already-`"use client"` component
  with a fixed `NAV_LINKS` array — a natural home for a badge.

## 3. My Proposed Approach

### 3.1 Data model

```sql
CREATE TABLE IF NOT EXISTS issues (
  id           TEXT PRIMARY KEY,   -- random id, not tied to any other row
  severity     TEXT NOT NULL CHECK (severity IN ('warning', 'error')),
  source       TEXT NOT NULL,      -- e.g. "runRadar:gofractional", "autofire:gofractional:new-1"
  title        TEXT NOT NULL,
  message      TEXT NOT NULL,
  context      TEXT,               -- JSON, optional (e.g. {gigKey, sourceId})
  raised_at    TEXT NOT NULL,
  resolved_at  TEXT                -- null while open
) STRICT;
CREATE INDEX IF NOT EXISTS idx_issues_open ON issues(resolved_at);
```

### 3.2 `src/lib/notify/issues.ts`

- `raiseIssue({severity, source, title, message, context?}): string` (id)
  — persists, then best-effort `sendDesktopNotification()` (never
  throws, matches that function's own contract).
- `resolveIssue(id): void`.
- `listIssues(filter?: {open?: boolean}): StoredIssue[]`.

### 3.3 Real call sites

- Scheduler's `runCycle()`: for each `runRadarFn()` error, `raiseIssue({
  severity: "warning", source: `runRadar:${sourceId}`, title: "Source
  fetch failed", message })` — a source erroring isn't catastrophic
  (backoff already handles repeats) but the owner should be able to SEE
  it without tailing logs.
- `runAutoDraft()`'s drafting-failure catch: same `severity: "warning"`.
- `attemptAutoFire()`'s two catches: `severity: "error"` (money/real
  action involved) for a submit failure specifically; `severity:
  "warning"` for an evaluation failure (a bug, not a live-fire risk).

### 3.4 Dashboard surface

- Nav badge: a small count + color (red if any open `error`, amber if
  only `warning`s, hidden if zero open) next to the existing nav links.
- New `/issues` page: list, severity badge, source, message, raised-at,
  a "Resolve" button (Server Action calling `resolveIssue()`).

## 4. What Could Go Wrong

- **Medium — issue spam** if a source repeatedly fails every cycle
  (already backed off, but still). Mitigation: dedupe on `(source,
  title)` — an already-OPEN issue with the same source+title is not
  re-raised, just left open (no new row, no new notification) until
  resolved. Explicitly scoped for THIS epic, not deferred.
- **Low — desktop notification fatigue** (a new notification every raise
  in addition to the dedupe above). Mitigation: the desktop notification
  fires only on a genuinely NEW issue (post-dedupe), same "no per-item
  spam" discipline `runNotifyOnGreenMatch()` already established.

## 5. Dependencies and Constraints

Depends on nothing new. Reuses `src/lib/notify/desktop.ts` as-is. Core/
user-layer boundary: generic mechanism, no owner-specific severity rules
or thresholds hardcoded.

## 6. Verification Strategy

Automated: `raiseIssue()`/`resolveIssue()`/`listIssues()` unit tests
(fixture-based, mirrors `autofire.test.ts`'s temp-db style), dedupe
behavior explicitly tested, each new call site's integration test
(scheduler + runRadar). Manual: the owner sees a real issue appear after
a deliberately-broken source config, resolves it, confirms it clears.

## 7. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~9-11 (schema.ts, new notify/issues.ts + tests, 3 call
    sites in scheduler/runner, nav-header badge, new /issues page +
    Server Action + tests).
  Recommendation: MEDIUM — single well-defined concern, no new external
    dependency, reuses existing notification mechanism. Proceeding
    directly to stories, no H/V needed.
```
