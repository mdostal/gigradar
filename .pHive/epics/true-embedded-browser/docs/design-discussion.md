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

## 6. CORRECTION, 2026-09-06: the "guided/full-auto can never move to the
embedded webview" conclusion in §4 was wrong

Owner's own real pushback, verbatim: "not sure how a single chrome
instance embedded into this would lose capabilities -- we literally have
the chrome code -- can pull it down and integrate directly... integrate
[a vision-based approach] to actually READ the screen with your AI
rather than purely use the tags and playwright, but we have BOTH and
TOGGLES in settings to control how much token usage and how advanced and
how much [automation] is used." This triggered a real, 4-thread parallel
research re-dive (CEF-in-Tauri, Electron's CDP story, WKWebView's own
native automation options, and the vision-agent landscape) rather than
defending the original finding. The original finding (WKWebView has no
CDP, so CDP-requiring automation can't reach it) was factually correct
in isolation but wrong to treat as a permanent wall on ALL automation --
three real, viable, non-Chromium paths exist:

**Path A -- OS-level vision + synthetic input (cheapest, ships first).**
The load-bearing realization: `clickSessionAtAction()`/
`typeIntoSessionAction()` (profile-assist's existing guided/full-auto
mechanism) is ALREADY a screenshot-coordinate agent, not a DOM/CDP-tag
mechanism -- it takes a Playwright screenshot, has the LLM pick a
ratio-scaled coordinate, and clicks there. This exact pattern (Anthropic
Computer Use, OpenAI Operator, Google Gemini 2.5 Computer Use, Amazon
Nova Act, Simular Agent S2 -- all real, current 2025/2026 products) is
ENGINE-AGNOSTIC by construction: it never touches CDP or the DOM, only
pixels, so it works identically against a real Chrome window, a
Chromium-backed pane, or a WKWebView pane. Real, precedented substitute
for the click/type half: macOS `CGEventCreateMouseEvent`/
`CGEventCreateKeyboardEvent` + `CGEvent.post()` dispatches a real
synthetic input event at real screen coordinates, indistinguishable from
a human click to whatever's rendering there. This requires the SAME
one-time Accessibility permission grant this app's window-management
osascript calls already rely on, and is only blocked under macOS's full
App Sandbox model -- confirmed this app is NOT sandboxed
(`src-tauri/entitlements.plist` has no `com.apple.security.app-sandbox`
key at all), so no new blocker there. Screenshot capture scoped to the
embedded pane's own screen region (not the owner's whole desktop --
learned the hard way this session, see
`feedback_never_screenshot_the_real_desktop` project memory, about NOT
capturing more than intended) is the read half.

**Path B -- an in-house JS-bridge/DOM automation mode (cheaper, faster,
the other settings toggle).** Real prior art:
[danielraffel/tauri-webdriver](https://github.com/danielraffel/tauri-webdriver)
implements a full W3C WebDriver server for a Tauri/WKWebView app WITHOUT
CDP at all -- it injects a JS bridge into the webview and relays
element-finding/click/type/read/screenshot commands through it. Tauri's
own `WebviewWindow::eval()` (already a stable, documented API) is the
exact mechanism needed to build an equivalent, in-house
`embedded_webview_eval(js)` command in `embedded_webview.rs` -- no new
heavy dependency. macOS's Accessibility (AXUIElement) tree is a
legitimate second read-path here too (WebKit's own team helped build
macOS's accessibility API historically, so WKWebView's ARIA-driven
accessibility exposure is first-class, not an afterthought) -- coverage
depends on the target page's own semantic markup, the same caveat any
accessibility-tree automation has on Chromium too.

**Path C -- true Chromium embedding via CEF (biggest, most capable, a
SEPARATE future epic, not required to unblock A/B).** Tauri's own org
maintains [`tauri-apps/cef-rs`](https://github.com/tauri-apps/cef-rs), a
real, actively-maintained (near-weekly releases, tracking current
Chromium) Rust CEF binding -- this contradicts an easy assumption that
CEF-in-Rust is abandoned/stale; that's true of *other*, older community
forks, not this one. Real prior art of someone actually shipping it:
[Atrium's engineering blog](https://getatrium.dev/blog/embedding-real-browser-tauri)
documents a working CEF-backed pane inside a Tauri macOS app via a
bespoke AppKit "punchout" compositing trick (wry has no built-in
CEF-backend support yet -- [cef-rs#208](https://github.com/tauri-apps/cef-rs/issues/208)
proposes exactly that drop-in integration but isn't built). Real,
quantified cost: **+170MB app bundle**, several-hundred-ms-to-seconds
CEF init cost (mitigated by deferring init past cold launch), and an
ongoing Chromium-version-tracking maintenance burden -- a genuine
multi-week epic, not a small addition. Real bonus if ever built: full
Playwright/CDP automation AND fixing Google's own embedded-browser
detection (which currently blocks Google SSO inside WKWebView but not
inside a real Chromium UA) -- a second, independently real problem this
would solve.

**Considered and rejected: Electron as the embedding engine.** Electron's
`WebContentsView` + `Debugger` (real CDP access) + Playwright's official
`_electron` support is genuinely the most mature, best-documented path
to full CDP automation of an embedded pane -- but running a second,
Chromium-based engine (Electron) nested inside this app's Tauri/WKWebView
shell just for one pane is a confirmed anti-pattern
([tauri-apps/tauri#2709](https://github.com/tauri-apps/tauri/issues/2709)
and general framework consensus: nobody does this) that negates Tauri's
own reason for existing without fully capturing Electron's benefits
either. Migrating the WHOLE packaged app off Tauri onto Electron is a
real, available option but a 20-50x size/RAM cost and a from-scratch
release-pipeline rebuild (`tauri-release.yml`'s signed-`.dmg`+updater
flow has no Electron equivalent in this repo) -- rejected as
disproportionate to the actual ask (one automatable pane), not because
Electron itself is bad.

## 7. Real proof-of-concept, 2026-09-06: validated live against gigradar's own running window

Built a small, standalone Swift tool (compiled/ad-hoc-signed the exact
same way gigradar's own packaged `.app` is signed, per
`entitlements.plist`) and ran it against gigradar's own real, live PID
-- not guessed, not simulated:

- **`AXUIElementCreateApplication(pid)`**: real, precise, scoped read.
  Enumerated the actual nav-header links (`AXLink title="Today"`, etc.)
  with their exact on-screen coordinates. Confirmed a bare Swift CLI
  needs `NSApplication.shared` referenced first or it crashes on any
  CoreGraphics/WindowServer call (`CGS_REQUIRE_INIT`) -- moot for the
  real feature, which runs inside Tauri's own already-initialized
  NSApplication, not a bare CLI tool.
- **`ScreenCaptureKit` (`SCContentFilter(desktopIndependentWindow:)`)**:
  real, correctly scoped -- the captured PNG contained ONLY gigradar's
  own window, confirmed by inspection. Ad-hoc signing did **NOT** block
  it here, contradicting a caveat one research thread raised (a real
  GitHub issue about Sequoia rejecting ad-hoc-signed callers) --
  real-world testing on this exact machine/macOS version overruled the
  more cautious secondhand finding. Still worth a fresh empirical check
  if this ever moves to a different macOS version/signing setup.
- **Click, take 1 (`CGEvent.postToPid`)**: dispatched with no error, but
  produced NO real effect -- the app never navigated. A real negative
  result.
- **Click, take 2 (`CGEvent.post(tap: .cghidEventTap)`, standard global
  synthetic input at the coordinate read from the accessibility tree)**:
  WORKED -- live-confirmed by the owner watching their own screen, not
  just a screenshot. But it does this by injecting into the real, global
  HID input stream, which visibly moves the OWNER'S ACTUAL MOUSE CURSOR
  to click -- likely the same reason `postToPid` (which skips that
  stream entirely) didn't register: WebKit's hit-testing may depend on
  real cursor/mouse state, not just a delivered event message.

**Owner's real, explicit ruling on the cursor-hijacking side effect**:
acceptable, but ONLY for an explicit "auto-drive" style mode where the
owner is actively watching, not something that can ever fire during
unattended/background work -- "I should be doing that and watching it
... as long as THIS implementation is separate from the overall fetching
of events and stuff we should be good." This is now a HARD, enforced
constraint on Path A (vision/OS-input), mirrored on the exact same
footing as Story 5's own "a headed browser NEVER opens for an unattended
path" rule -- Path A's click/screen-capture mechanism must be PROVABLY
unreachable from `runRadar()`/the scheduler/any scan code path, not just
documented as such. It is a foreground-only, human-initiated,
profile-assist-triggered capability, full stop.

This is also why **Path B (the DOM/eval-bridge mode) is the real
default, not just the "cheaper" option**: dispatching a synthetic
`MouseEvent`/`.click()` via `webview.eval()` happens entirely inside the
web page's own JS/DOM event model -- it never touches the real OS cursor
or HID stream at all, meaning the owner can keep using their own mouse
for anything else while it runs ("work side by side," the owner's own
stated ideal). Path A (vision + OS-level synthetic input) trades that
away for broader page-compatibility (works even when a page's DOM/ARIA
coverage is too thin for Path B) -- an explicit, disclosed trade-off a
real settings toggle must state plainly ("this mode will move your
mouse cursor while it runs"), never a silent side effect.

**Revised architecture**: `embedded-guided-apply-assist`'s original
"guided/full-auto structurally cannot follow manual mode into the
embedded pane, full stop, permanently" framing is WRONG and retracted.
ALL THREE profile-assist modes can move into the embedded webview.
Manual mode needs nothing new (pure human interaction). Guided/full-auto
need one of Path A or Path B's automation backends wired to the embedded
pane instead of to a spawned real Chrome window -- built as a real,
owner-facing settings TOGGLE between them (per the owner's own explicit
ask), not a single hardcoded choice: Path B (DOM/eval-bridge) as the
default -- cheap, fast (roughly 500-2,000 tokens and sub-second per
step vs. vision's 1,000+ tokens and 1-5 seconds per step, per this
session's own research) -- with Path A (vision/screenshot) as an
explicit fallback/opt-in for pages whose DOM/ARIA coverage is too thin
for Path B to work reliably. This exactly matches 2026's real industry
pattern (DOM-first with vision fallback), not a novel bet. Path C (CEF)
remains a real, credible, SEPARATE future epic if/when full browser
fidelity (extensions, arbitrary sites Path A/B can't handle, fixing
Google SSO's WKWebView block) is worth its real cost -- proposed, not
committed to, here.
