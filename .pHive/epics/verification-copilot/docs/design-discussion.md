# Design discussion: verification-copilot

## 0. Prelude

Task #59 in the project backlog ("In-UI human-verification co-pilot
surface"), picked up autonomously as "the next task" per standing
authorization. Direct precedent: `.pHive/epics/graduated-auto-fire-trust/
stories/gofractional-submit-adapter.yaml`'s `pause_note` (2026-08-14) —
GoFractional's job-detail pages hit a Cloudflare "Performing security
verification" challenge that didn't clear even under a real, live, owner-
driven test — and explicitly points at "docs/ARCHITECTURE.md's future
notifications epic (task #58) for the general 'flag it, don't fail
permanently' pattern this kind of thing should route through going
forward." Task #58 shipped (issues/notifications). This epic is that
routing: a real, reusable "you're blocked, here's a button to go clear it"
surface.

**No live-account testing required to build or test this** — the
detection/issue/UI mechanism is fully unit-testable with mocked page
content and mocked Server Actions. The one thing that can't be proven
synthetically is whether *launching the co-pilot browser* actually helps
clear a real Cloudflare challenge on a real site — flagged in §6 as an
owner-only step, same posture as every other epic this session.

## 1. What exists today (confirmed via research, not assumed)

- **`raiseIssue()`** (`src/lib/notify/issues.ts:72-98`): `{severity:
  "warning"|"error", source, title, message, context?}`, deduped on
  `(source, title)` while unresolved. Scheduler already calls this for
  every source-fetch error (`src/scheduler/index.ts:441-454`) with a
  generic `title: "Source fetch failed"`.
- **`/issues`** (`src/app/issues/page.tsx` + `issues-client.tsx`): lists
  open/resolved issues, a nav badge (amber/red) already wired.
- **Verification-challenge detection exists in exactly ONE place today**:
  `gofractional.ts`'s file-level comment documents the Cloudflare
  interstitial on `/job/{slug}`, but the adapter's response is
  *avoidance* (never navigate there) — there is no detector, no distinct
  issue type, no UI surface. Every other adapter has zero awareness of
  this failure mode.
- **`real-chrome.ts`** (oauth-session-capture-v2 epic, this session):
  spawns a real, independently-launched Chrome (never
  `playwright.chromium.launch()`) — exactly the mechanism a human would
  want to drive themselves against a live block, and already proven
  (live-verified) to behave more like a real browser to bot-detection.
- **`capture-guidance.ts`'s `checkCaptureReadiness()`** (oauth-session-
  capture-v2 epic): a single-shot LLM call whose prompt ALREADY asks
  "does this look signed-in, or still login/interstitial (e.g. ... a
  'verifying you're human' challenge)?" — this is functionally already a
  verification-challenge-aware readiness check, just built for the
  Capture Login context. Reusable as-is.

## 2. Goal

When a source's fetch fails specifically because of a bot-detection/
verification challenge (not a generic network error, not "needs login"),
gigradar should:
1. Detect it as its OWN distinct failure mode, not a generic fetch error.
2. Raise a distinctly-titled, higher-visibility issue.
3. Give the owner a one-click way to open a REAL, human-drivable browser
   (reusing `real-chrome.ts`) pointed at the blocked URL, with the
   source's own already-captured session loaded — so they see exactly
   what the scanner saw and can clear it themselves.
4. Let them check, via the SAME `checkCaptureReadiness()`-shaped LLM
   call, whether the block looks cleared before closing the window.

## 3. Design decisions

**Detection: a shared, reusable check — not per-adapter guesswork.**
`src/lib/sources/verification-challenge.ts` (new, core): `isVerification
ChallengeContent(text: string): boolean` matching known signal substrings
("Performing security verification", "Just a moment", "Checking your
browser", "Verify you are human", generic "Cloudflare" + "checking"
co-occurrence) against a page's title/body text. A dedicated
`VerificationChallengeError` (carries `sourceId`, `url`) that any adapter
throws when it detects this specific condition — distinguishable from a
generic thrown `Error` by `instanceof`, so callers never have to parse
message strings to tell them apart.

**Wired ONCE, at the shared layer — not per-adapter.** `with
BrowserSession()` (`browser-session.ts`) is the ONE mechanism every
`browser-session`-auth adapter (gofractional/ateam/wellfound) AND
`custom-llm-source.ts`'s browser-session-auth branch already goes
through. After navigating and BEFORE the caller's own `isAuthenticated`
check, it runs the shared detector against the page's content; on a
match, throws `VerificationChallengeError` instead of letting the
caller's own (possibly less specific) failure surface. This is the same
"one core touch point, not per-site code" shape as every other cross-
cutting change this session (`runner.ts`'s custom-source fallback,
`origins.ts`'s config-driven fallback) — adding detection to a NEW
adapter later needs zero new code, since it's already covered by going
through `withBrowserSession()`.

**Distinct issue shape.** `runner.ts`'s per-source error handling (and
the scheduler's `raiseIssue()` call over `result.errors`) checks
`instanceof VerificationChallengeError` and raises with `title:
"Needs human verification"`, `severity: "warning"`, `context: {sourceId,
blockedUrl}` — a DIFFERENT `(source, title)` dedup key than the generic
"Source fetch failed", so a source that's merely erroring and a source
that's specifically blocked never collide or mask each other.

**Co-pilot browser launch reuses real-chrome.ts + the existing session,
not a new browser primitive.** A new Server Action spawns
`spawnRealChrome()`/`attachToRealChrome()` (real-chrome.ts, unmodified),
loads the source's already-captured storageState via `readStorageStateFile()`/
`filterStorageStateToAllowlist()` (browser-session.ts, unmodified — same
origin-scoping safety-critical discipline, never skipped), navigates to
the blocked URL, and leaves the window open under the human's control —
same "never auto-close a live browser during human verification"
discipline this project's own memory already enforces. Held in a
globalThis-pinned map (same idiom `session-capture.ts`/`assist-session.ts`
already established) so it survives Next.js dev HMR.

**"Check if it's cleared" reuses `checkCaptureReadiness()` directly, not
a fourth copy of the same LLM call shape.** The function is already
generic enough (see §1) — call it as-is against the co-pilot window's
current page.

## 4. Non-goals (explicitly out of scope)

- Auto-retrying the scan the instant a challenge looks cleared — the
  owner decides when to retry (closing the co-pilot window and letting
  the next scheduled cycle run is enough; no new "retry now" plumbing).
- Resuming `gofractional-submit-adapter` itself — that story stays
  paused; this epic only builds the general surface it was deferred to.
- Any change to which adapters DETECT challenges beyond wiring the
  shared check into `withBrowserSession()` — `custom-llm-source.ts`'s
  no-auth (plain `chromium.launch()`) path is a separate code path and
  is explicitly left unwired in this epic (its own bot-detection posture
  is a separate, already-documented tradeoff from llm-custom-sources).

## 5. Scale assessment: **Medium**

Reuses four already-built primitives (`raiseIssue`, `real-chrome.ts`,
`browser-session.ts`, `capture-guidance.ts`) behind one new shared
detector and one new UI surface. No new architecture, no new dependency.

## 6. Where owner input is unavoidable

Whether launching the co-pilot browser against a REAL blocked site
actually results in a clearable challenge is inherently a live question
— flagged, never fabricated as a synthetic pass. Everything else (the
detector, the issue routing, the UI, the browser-launch mechanism itself)
is fully verifiable with mocked content/dependencies.
