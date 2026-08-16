# Follow-up: the bundled Chromium's real cost (not fixed now, deliberately)

Raised 2026-08-16 during the first real UAT of the packaged `.app`
(v0.22.0): the installed app is 1.2GB, and the entire bloat is one thing —
`Contents/Resources/resources/playwright-browsers/chromium-1234` is 1.0GB
uncompressed. Everything else (the Next.js standalone server bundle) is a
normal 79MB.

**Decided 2026-08-16: leave as-is for now** — this needs a real
cost/benefit pass, not a rushed fix mid-UAT. Documenting the actual
findings here so the next pass starts from real data, not a re-derivation.

## What the bundled Chromium is actually for (verified, not assumed)

It is **not** just a Capture Login nicety — it's load-bearing for the
exact "most people just want LinkedIn/Monster/Dice" use case:

- `custom-llm-source.ts`'s headless, no-auth scraping path
  (`chromium.launch({ headless: true })`, no `channel` override) —
  **every custom-llm source scan goes through this**, and it always uses
  the bundled/`PLAYWRIGHT_BROWSERS_PATH` Chromium, never the system's
  real Chrome. This is the code path a LinkedIn/Monster/Dice custom
  source hits on every scheduled scan.
- `browser-session.ts`'s `launchHeadedBrowser()` (Capture Login,
  browser-session-auth sources) already **prefers the system's real
  installed Chrome** (`channel: "chrome"`) and only falls back to the
  bundled copy when real Chrome isn't found on the machine — this path
  is NOT the main cost driver for most installs.

So the honest framing isn't "most users never need this 1GB" — it's
"the no-auth custom-source scraping path could probably prefer the
system's real Chrome the same way the headed path already does, and
currently doesn't."

## Real directions worth a CBA (owner's own framing, not my invention)

1. **Prefer system Chrome for the headless custom-llm-source path too**
   — same `channel: "chrome"`-first, bundled-Chromium-fallback pattern
   `launchHeadedBrowser()` already uses, just applied to
   `custom-llm-source.ts`'s headless launch. If most users already have
   Chrome installed (likely, on macOS), this alone could make the
   bundled copy a rare fallback instead of the default path — without
   removing the "always works, zero network dependency" guarantee for
   users who don't have Chrome.
2. **True lazy/on-demand download** — don't bundle Chromium in the
   installer at all; fetch it (via Playwright's own install mechanism)
   the first time it's actually needed. Cuts install size dramatically,
   but trades it for a first-run download + real UX work (progress
   state, retry-on-failure, offline messaging) that doesn't exist today.
3. **Keep bundling, just trim it** — strip unused Chromium locale/`.pak`
   files (English-only), maybe save 50-100MB. Smallest change, smallest
   win, doesn't address the real cost.

Direction 1 is the most promising lead (cheap relative to 2, addresses
the actual dominant cost driver, reuses an already-proven pattern in this
same file) but needs real verification: does `chromium.launch({headless:
true, channel: "chrome"})` actually work reliably headless against a
real system Chrome install, and do the no-auth custom sources' bot-
detection posture change at all by switching away from Playwright's
"Chrome for Testing" build? That's the open question a real CBA needs to
answer before touching any code.

## Not blocking

`xattr -cr /Applications/gigradar.app` unblocks testing today regardless
of size. This is a real, worth-doing optimization, not an emergency.
