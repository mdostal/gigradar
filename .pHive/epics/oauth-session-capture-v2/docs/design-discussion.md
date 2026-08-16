# Design discussion: real Google OAuth session capture (v2)

## 0. Prelude

**Origin.** Owner request, 2026-08-15, prompted by a real, live failure: a
fresh screenshot of Google's `accounts.google.com/v3/signin/rejected`
page ("Couldn't sign you in — This browser or app may not be secure")
during a real GoFractional (Clerk-based) Google sign-in attempt — despite
task #47's earlier point-fix (preferring the real installed Chrome
channel over Playwright's bundled Chromium in `launchHeadedBrowser()`).
Owner's own words: "your current method on the gig radar does not let us
actually capture and use google oauth and integrate the logins
correctly... all of these logins need to be done much better."

**Prior-decision this epic reconciles with**
(`gigradar-persistent-browser-session-lead`, saved 2026-08-14): the
legacy tool's own header comment documented this exact regression
already solved — headless Chromium gets Cloudflare-blocked "FOREVER,"
and the real fix was routing every command into ONE persistent browser
instance living on a real console/VNC display, never a fresh
browser+context spun up per call. That memory explicitly deferred this
as needing "its own scoped design discussion." **This epic is that
discussion.**

## 1. Root cause (confirmed this session, not assumed)

Task #47's fix — `launchHeadedBrowser()` preferring `channel: "chrome"`
(the real Chrome binary) over Playwright's bundled Chromium — was
necessary but not sufficient. **`chromium.launch()` itself, regardless
of which Chrome binary it launches, adds automation markers**
(`navigator.webdriver = true`, the `--enable-automation` switch, and
related CDP-launch flags) that Google's sign-in flow specifically
detects and rejects. This is a characteristic of *how Playwright starts
the browser*, not of *which binary* it starts — confirmed via
Playwright's own docs on `chromium.connectOverCDP()`: attaching to an
**independently-launched** browser (started by the OS directly, never
through Playwright's `launch()`) does not carry those same
launch-injected fingerprints, because they depend on the launch path,
not on a later CDP connection.

This matches the owner's own description of the legacy tool's approach
("opened a Chrome window, had the user navigate to the profiles, and
captured them") and the prior-decision memory above almost exactly — a
persistent, human-driven, non-Playwright-launched browser is the real
fix, not a browser-channel choice.

## 2. Goal

Every `browser-session`-auth login/capture flow in gigradar — today
`session-capture.ts`'s `startCapture()`/`finishCapture()` (the
Capture Login button in `/config`) and `assist-session.ts`'s
`startAssistSession()` (`profile-assist`, just shipped) — launches a
REAL, independently-started Chrome (spawned directly by gigradar via
`child_process`, with a real `--remote-debugging-port` and an
isolated, fresh `--user-data-dir`, never through
`playwright.chromium.launch()`), and Playwright attaches to it via
`connectOverCDP()` only to read state (storageState at capture-finish
time; page snapshots for LLM guidance) — never to control it during
login. The human logs in exactly as they would in their own regular
Chrome, indistinguishable to Google (or any other bot-detecting
provider) from a real user, because it *is* one.

Two secondary goals, both explicitly reuse-not-rebuild:

- **Portunus as an optional session-vault backend.** Live-confirmed
  this session: Portunus's CLI already has a purpose-built
  `portunus session store/load/inspect/list/remove` family (site+account
  keyed, TTL-aware, stdin-only value input, 0600 tempfile output on
  load) that maps directly onto gigradar's per-source
  `<sourceId>-session.json` storageState files. Offered as an
  **owner-selectable alternative** to the existing local AES-256-GCM
  vault (`src/lib/security/vault.ts`) — never a forced migration, and
  gracefully absent (not broken) for the vast majority of OSS users who
  don't have Portunus installed at all.
- **LLM-guided capture setup**, reusing the profile-assist epic's
  already-shipped machinery (`page.locator("body").ariaSnapshot({mode:
  "ai"})`, the same prompt-injection-delimited framing) — but
  deliberately the LIGHTER, single-shot `profile-suggest.ts` shape, not
  the heavier multi-turn `profile-assist-loop.ts` tool-use loop. Login
  itself (including any password/2FA field) stays 100% human-driven,
  always — the LLM only ever observes page STRUCTURE (never field
  VALUES it didn't put there itself) to offer "looks like you're signed
  in and on the right page — ready to capture?" guidance. No new
  click/fill capability is introduced by this epic.

## 3. Scale assessment

**Large.** A genuinely different browser-launch model touching two
existing, already-shipped, safety-critical mechanisms
(`session-capture.ts`, `assist-session.ts`), a new optional secrets
backend integration, and real authentication flows for real third-party
accounts. Running full H/V-equivalent thinking, vertical-slice plan +
stories (see this session's own established pattern for scaling
ceremony to actual need on this project, rather than the full
1000-line structured-outline document).

## 4. The core mechanism: spawn-then-attach, never launch

**New module**, `src/lib/auth/real-chrome.ts`:

- `spawnRealChrome(): Promise<{ process, cdpPort, userDataDir }>` —
  resolves the real Chrome binary path (macOS-only for this epic's first
  pass, matching `scripts/prepare-tauri-sidecars.sh`'s own established
  "macOS only, first pass" scope precedent: the standard install path
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, with a
  specific, actionable error if not found there — never a silent
  fallback to Playwright's bundled Chromium, since that's exactly the
  automation-fingerprint problem this epic fixes). Picks a free local
  port, creates a FRESH, isolated temp `--user-data-dir` (never the
  user's own real personal Chrome profile — same "never touch the
  user's actual browsing data/history/other-site cookies" posture
  `session-capture.ts`'s existing fresh-context approach already has),
  spawns via `child_process.spawn()` directly (NOT
  `playwright.chromium.launch()`) with exactly
  `--remote-debugging-port=<port> --user-data-dir=<tmp> --no-first-run
  --no-default-browser-check` — deliberately NOT
  `--enable-automation`/any Playwright-injected flag. Polls the CDP
  `http://127.0.0.1:<port>/json/version` endpoint until it responds
  (readiness signal, mirrors `lib.rs`'s own TCP-connect readiness-poll
  pattern from the tauri-installer epic) before returning.
- `attachToRealChrome(cdpPort): Promise<Browser>` — thin wrapper around
  `playwright.chromium.connectOverCDP(\`http://127.0.0.1:${cdpPort}\`)`.
- `closeRealChrome({process, userDataDir})` — terminates the spawned
  process and removes the temp user-data-dir (never leave a stray
  profile directory on disk after a capture ends).

**`session-capture.ts`'s `startCapture()`/`finishCapture()`** rewired to
use `spawnRealChrome()`/`attachToRealChrome()`/`closeRealChrome()`
instead of `launchHeadedBrowser()` + `browser.newContext()`. The rest of
the mechanism — the `globalThis`-pinned in-flight map, the idle timeout,
the origin-scoped filtering before write, the atomic encrypted write —
is UNCHANGED; only the browser-acquisition step changes.

**`assist-session.ts`'s `startAssistSession()`** gets the SAME
treatment, for the same reason (profile-assist's own login/navigation
step is exactly as exposed to bot-detection as Capture Login's is —
this wasn't caught in that epic because its own live verification
happened to use a source whose stored session didn't require a fresh
Google OAuth handshake in the moment).

**What's explicitly NOT changing:** `browser-session.ts`'s
`withBrowserSession()` (the fetch-and-close path real adapters use for
scraping, e.g. `gofractional.ts`'s job-list fetch) stays exactly as
it is — it doesn't hit a live OAuth wall today (the storageState it
loads was already captured by the mechanism above), and rearchitecting
it is out of scope here. `launchHeadedBrowser()` itself is untouched
too (still used by other callers as today) — this epic ADDS the
spawn-then-attach path as the new default for login/capture-shaped
flows specifically, it does not remove the existing helper.

## 5. Portunus as an optional backend

New `src/lib/auth/session-backend.ts`:

- `SessionBackend = "local" | "portunus"` — a new field,
  `sources[].settings.sessionBackend`, defaulting to `"local"` (today's
  behavior, unchanged) when absent — the safe, always-available default
  for any OSS user without Portunus installed.
- `isPortunusAvailable(): boolean` — a real, live `portunus --version`
  child-process check (cached per-process), never assumed. The
  Portunus option is HIDDEN in the UI, not just disabled, when this
  returns false — a generic OSS user should never see a control for a
  tool they don't have.
- `writeSessionViaPortunus(site, account, storageStateJson, ttlSeconds)`
  — shells out to `portunus session store <site> <account>
  --ttl-seconds <n> --stdin`, piping the ALREADY origin-scoped-filtered
  JSON via stdin (never a temp file, never a command-line argument —
  matching Portunus's own CLI design and this codebase's own "secrets
  never touch argv/logs" discipline).
- `readSessionViaPortunus(site, account)` — shells out to `portunus
  session load <site> <account>`, which itself writes a 0600 tempfile
  and prints only its path; this function reads that file, parses it,
  and — critically — deletes the tempfile immediately after reading
  (Portunus hands back a path, not a value, specifically so the caller
  controls its lifetime; leaving it on disk after use would silently
  reintroduce the exposure Portunus's own design avoids).

`finishCapture()`/`readStorageStateFile()` branch on the resolved
`sessionBackend` to call either the existing local-vault path (default)
or these new Portunus functions — never both, never a silent fallback
from one to the other on failure (a Portunus write/read failure is a
real, surfaced error, not silently retried against local storage, which
would leave the owner unsure which backend actually holds their
session).

## 6. LLM-guided capture setup

New `src/lib/auth/capture-guidance.ts`, deliberately thin — reuses
`profile-suggest.ts`'s exact single-shot shape (one Anthropic tool-use
call, `apiKey` never module-scope, the page's AI-mode aria snapshot
delimited as untrusted DATA, same as that file) rather than introducing
a third prompt-injection-mitigation implementation. Function:
`checkCaptureReadiness(page, sourceId, apiKey): Promise<{ ready:
boolean; note: string }>` — reads the current page's snapshot, asks the
LLM "does this look like a successfully-signed-in profile/account page
for `<sourceId>`, or still a login/interstitial page?", returns a
plain-language note the UI shows next to the "I'm done" button (e.g.
"Looks like you're still on Google's sign-in page" vs. "Looks like
you're signed in — ready to capture"). Advisory only — the human
still clicks "I'm done" themselves; this never auto-triggers
`finishCapture()`. No click/fill capability at all — this function
never receives a tool schema with mutating tools, unlike
`profile-assist-loop.ts`.

## 7. Open questions resolved here

- **Does spawning Chrome directly (not via Playwright) still let this
  codebase's existing safety guarantees hold?** Yes — origin-scoping
  (`filterStorageStateToAllowlist()`), the "no debug capture" rule (no
  `recordHar`/`recordVideo`/tracing), and the atomic encrypted write are
  all unchanged; `connectOverCDP()` still gives Playwright's normal
  `Browser`/`BrowserContext`/`Page` API surface once attached, so every
  downstream call in `session-capture.ts`/`assist-session.ts` stays the
  same. Only the FIRST few lines (how the browser process itself comes
  into being) change.
- **What if the owner's machine doesn't have a standard Chrome install
  path (custom install location)?** A specific, actionable error names
  the exact path checked and how to fix it (matching
  `checkChromiumAvailable()`'s own existing "name the exact problem,
  never a raw stack trace" discipline) — no silent fallback to a
  fingerprint-carrying Playwright-launched browser.
- **Does this fix Cloudflare too (the paused
  `gofractional-submit-adapter` story), not just Google?** Plausibly,
  per the prior-decision memory's own reasoning — but re-attempting that
  paused story is explicitly OUT OF SCOPE here. This epic's own
  acceptance criteria are about the login/CAPTURE flow, not the
  separate real-submit-automation flow. A future story can retry
  `gofractional-submit-adapter` against this new mechanism once it
  ships, informed by whether this fix helps, but that's not this epic's
  job.

## 8. Risks

- **Spawning a real, independently-launched Chrome process is a new
  process-lifecycle surface** (a leaked temp `--user-data-dir`, a
  zombie Chrome process if `closeRealChrome()` isn't called on every
  exit path). Mitigation: the SAME `finally`-block discipline
  `withBrowserSession()`/`session-capture.ts` already prove out,
  applied to the new spawn/attach/close triad; real end-to-end
  verification checks `ps aux` for leftover processes and the temp dir
  for leftover files, same bar this session's own Tauri/profile-assist
  work already held itself to.
- **A real Chrome instance with `--remote-debugging-port` open is a
  local attack surface** (any local process could attach to it while
  it's open). Mitigation: bind to `127.0.0.1` only (never `0.0.0.0`),
  a fresh port per session (never a fixed, guessable one), and the
  window only stays open for the duration of one capture (closed
  immediately on finish/cancel/idle-timeout) — a narrow, short-lived
  exposure, not a standing service.
- **Portunus absence must never break the default path.**
  `isPortunusAvailable()` is checked, real, and the local-vault default
  path is completely independent of it — a generic OSS user with no
  Portunus installed sees byte-identical behavior to today.
