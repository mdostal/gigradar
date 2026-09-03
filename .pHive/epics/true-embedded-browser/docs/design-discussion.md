# true-embedded-browser: design discussion

## 1. Why this epic exists

Owner's own words, 2026-09-03, after living through a real incident (a
research script's headed Chrome window flopped around trying to minimize,
then got yanked closed mid-interaction while the owner was actively
working in it — see project memory
`feedback_fire_and_forget_scripts_against_live_chrome.md`):

> "there's a reason i have to work in another whole fucking laptop
> session, we CANNOT have an app just flashing windows all the time doing
> this -- it makes the computer unusable, we need the app to work behind
> the scenes for most of it and then with a user for others IN AN
> EMBEDDED WINDOW IN THE APPLICATION so that we aren't changing the
> fucking focus and everything else"
>
> "this is how the goddamned thing is supposed to work when embedded -
> it just SITS THERE"

`embedded-browser-and-guided-session` (Epic 3 of the deep-dive-audit
follow-ons, PR #107) explicitly ruled out true native embedding as "doesn't
solve the real problem, a large separate Rust/UI epic" and shipped
headless-first + minimize/position + a screenshot-based live-view pane
instead. That call was wrong, given what the owner is actually living
with. This epic is the real thing, not deferred again.

Separately, investigating the incident found and fixed a real bug (PR
#117): `minimizeChromeWindow()`/`positionChromeWindowSideBySide()`
addressed Chrome's own shared, ambiguous `window 1` rather than the
specific spawned process's window -- a real mechanism by which gigradar's
background automation could reach into and disrupt the owner's own
unrelated Chrome windows. That fix stands on its own regardless of this
epic, and reduces (but does not eliminate) the disruption this epic
exists to solve -- an OS-level window can still flash into existence
before minimizing, and guided/full-auto sessions still deliberately open
a real, positioned OS window by design.

## 2. Research findings (2026-09-03, real, not guessed)

Two real, load-bearing technical facts, found via web research against
Tauri v2's actual current documentation/issue tracker (this repo already
runs Tauri 2.11.3/tauri-cli 2.11.4, confirmed via `src-tauri/Cargo.toml`
and `npx tauri --version`):

1. **Multiwebview embedding is real but unstable.** `Window::add_child()`
   (Rust) + `WebviewBuilder` lets you add a genuine child webview inside
   an existing window, positioned/sized independently -- this is the
   actual mechanism for "a real browser surface living inside the app
   window, not a separate OS window." It is explicitly still an
   UNSTABLE Cargo feature as of Tauri v2's current docs/issue tracker
   (tauri-apps/tauri#10079, #8280) -- functional, shipped, but the API
   surface may still change under a Tauri version bump. This epic
   accepts that risk deliberately (matching CLAUDE.md's own
   `tauri-installer` epic precedent of building on Tauri's real,
   current capabilities) rather than waiting indefinitely for
   stabilization.

2. **Playwright/CDP automation CANNOT follow into an embedded webview on
   macOS.** Chrome DevTools Protocol -- what Playwright needs to drive a
   browser (clicking, filling, waiting, network interception) -- is only
   exposed by Tauri's embedded webview on Windows (WebView2). On macOS,
   Tauri uses WKWebView (Safari's engine), which has NO CDP support at
   all. Since this app is macOS-only throughout (`real-chrome.ts`'s own
   platform gate, `minimizeChromeWindow`'s osascript calls, etc.), this
   is a HARD constraint, not a soft one: gigradar's entire current
   automation engine (`real-chrome.ts` + `browser-session.ts` +
   `session-capture.ts`, all Playwright-over-CDP) simply cannot drive an
   embedded webview on this platform. This is not a bug to work around --
   it's a real architectural boundary this epic's design must respect.

3. **Reading cookies back out of an embedded webview has no first-class
   API either.** HttpOnly/secure session cookies (which real auth cookies
   almost always are) are NOT readable via `document.cookie` injection --
   community feature requests for a cookie-manager API are still open
   (tauri-apps/tauri#11330, #5823; tauri-apps/wry#518). The real, current
   path is dropping into Tauri's `PlatformWebview` handle and calling
   native platform cookie-store APIs directly (macOS: `WKWebView`'s
   `WKHTTPCookieStore`, via Rust `objc`/Swift-interop bindings) -- genuine
   native systems code, not a documented, stable Tauri call. This is the
   single highest-risk piece of this epic and gets its own dedicated
   research spike (Story 2) before any story downstream commits to
   depending on it.

## 3. Resolved architecture

Given finding 2 above, embedding does NOT mean "Playwright now drives an
embedded view instead of a separate window" -- it means splitting
responsibility along the SAME line CLAUDE.md's own core boundary
philosophy already favors (a clean, principled split, not a patch):

- **Unattended/automated work (scheduled scans, auto-draft, auto-fire,
  status reconciliation): stays exactly as it is today** -- Playwright
  driving a real, separate Chrome process, headless whenever possible
  (already shipped, Epic 3). The remaining gap this epic closes for that
  path (Story 5): a headed fallback must NEVER fire unattended anymore --
  if headless fails with no human present, raise an Issue asking the
  human to re-run Capture Login through the new embedded flow, rather
  than popping any OS-level window at all.
- **Interactive/human-driven work (login, Cloudflare, filling out an
  application, anything needing a real human in the loop): moves into a
  real embedded webview living inside the gigradar app window** (Stories
  1, 3, 4) -- the human drives it directly with their own mouse/keyboard,
  no Playwright involved at all while it's open, no separate OS window,
  no focus stealing, no flashing. It "just sits there" until the human
  gives an explicit "I'm done" signal (mirroring `session-capture.ts`'s
  own existing, correct start/finish/cancel discipline -- see
  `feedback_fire_and_forget_scripts_against_live_chrome.md`).
- **The handoff (Story 2):** once the human finishes an interactive step
  (e.g. completes a real login), gigradar reads the resulting session
  cookies back OUT of the embedded webview via native cookie-store
  access, shapes them into the SAME `StorageState` type
  `browser-session.ts` already defines, and feeds them through the
  EXISTING, unchanged origin-scoping/filtering/session-backend pipeline
  (`filterStorageStateToAllowlist()`, `writeSessionViaPortunus()`/local
  vault). Playwright's later UNATTENDED automation then replays that
  captured session exactly as it already does today (`withBrowserSession()`)
  -- this epic changes WHERE a human logs in, never how the resulting
  session gets stored, scoped, or later replayed.

This is the SAME capture-then-reuse shape `session-capture.ts` already
established, generalized to a real in-app UI surface instead of a
separate OS window. No new session-storage mechanism, no new
origin-scoping mechanism, no new Portunus integration -- all reused,
byte-identical.

## 4. What stays out of scope

- **Windows/Linux support** for the embedded webview specifically -- this
  repo's automation is macOS-only throughout already (real-chrome.ts's
  platform gate); the embedded-webview-cookie-extraction story is
  explicitly macOS-only too. A cross-platform version is a real, separate
  follow-up if gigradar ever targets those platforms for real, not
  guessed at here.
- **Full replacement of Playwright automation with in-webview JS
  injection.** The embedded view is for HUMAN-driven interactive work
  only. Automated scanning/scraping/drafting keeps using Playwright
  exactly as today -- this epic does not attempt to make gigradar's
  scraping engine run inside a WKWebView.
  **Concrete consequence, found late during this epic's own execution
  (embedded-guided-apply-assist story) and worth stating explicitly so
  it isn't missed again**: profile-assist's own "guided"/"full-auto"
  modes let the LLM click/type via `clickSessionAtAction()`/
  `typeIntoSessionAction()` -- a Playwright-screenshot-and-coordinate
  mechanism, i.e. exactly the automation this bullet says stays on
  Playwright. Those two modes therefore CANNOT move to the embedded
  webview, full stop -- only "manual" mode (pure human mouse/keyboard,
  no LLM clicking) is even a candidate. This is a real, permanent
  exception to "no separate OS window, ever," not a temporary gap.
- **True cross-app window docking** (already explicitly out of scope per
  Epic 3's own design-discussion, unchanged) -- the embedded webview lives
  INSIDE the gigradar app window itself, which is the actual fix; tracking
  some OTHER app's window position was never the ask.

## 5. Sequencing

Story 1 (child-webview mechanism) is genuinely foundational and has no
Story-2-shaped dependency -- start there. Story 2 (cookie extraction) is
the highest-risk, most novel piece and should get real spike time before
Stories 3/4 (which depend on it) are attempted. Story 5 (unattended
paths never open a window) has no hard dependency on the others and can
run in parallel if useful, but is sequenced last here since it's the
lowest-risk, most mechanical piece and there's no reason to rush it ahead
of the actual embedding work the owner is waiting on.
