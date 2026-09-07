# Design discussion: real-usability-verification-and-fixes

## 0. Trigger

Owner, 2026-09-07, after using the real, freshly-installed v0.45.0 packaged
app with his real data: "This is truly unusable... links between pages
[don't] actually work... buttons that run SOMETHING but give no feedback
(click analyze, what the fuck just happened?)... the dashboard claims i'm
up to date and did all of today which makes NO SENSE." He explicitly
called out that earlier verification this session (automated tests, code
review, simman against isolated seeded instances) never actually confirmed
these things work in the REAL running app with his REAL data, and demanded
a real `/plan` pass that actually tests and verifies, not just claims done.

This epic's own methodology is different from every prior one today: real
evidence gathered directly against the owner's actual running
`/Applications/gigradar.app` (v0.45.0) on its real port, backed by his
real `~/.local/share/gigradar` data — read-only curl/DOM inspection plus
direct binary inspection, with a live vision-AI (`simman`) interactive
click-through as a second, independent confirmation layer (blocked at
research time by a transient Portunus MCP disconnection — retry queued,
not skipped).

## 1. Findings, each with real evidence

**(a) External-link click behavior — code confirmed correct and confirmed
compiled into the real running binary; NOT the bug it first appeared to
be.** `dashboard-client.tsx`'s `/gigs` table row has TWO distinct, real
affordances: the title itself is a real `<a href={url}>` wired to
`openExternalUrl()` (`preventDefault()` + `@tauri-apps/plugin-shell`'s
`open()` in the packaged app), and a separate "View →" button that opens
the in-app detail panel. `strings /Applications/gigradar.app/.../app |
grep allow-open` confirms the `shell:allow-open` capability (PR #175) is
genuinely compiled into the running binary, not just present in source.
**What curl-based verification cannot confirm**: that the `onClick`
handler actually fires and calls the real OS shell correctly at runtime
inside the webview — that requires a real interactive check. This is
QUEUED for `simman` re-verification (blocked by a transient tool
connectivity issue, not skipped) — until that lands, this finding is
"code + binary correct, runtime-unconfirmed," not "confirmed working."
No story yet for this item pending that confirmation — if simman confirms
it works, no fix needed; if it finds a real runtime failure, a follow-up
story will be filed.

**(b) "Click Analyze, nothing visibly happens" — CONFIRMED REAL BUG.**
`src/app/today/today-client.tsx`: the "Today's Picks" card's "Analyze"
button (`handleGeneratePrep`, ~line 325) correctly fetches a real fit
analysis and stores it in `prepByKey` state — but the Picks card itself
(~lines 460-510) never reads `prepByKey` at all, only the error-only
`prepErrorByKey`. The real result only ever renders in a DIFFERENT
section further down the page (the "Full Roster" list, ~line 676) that a
user clicking Analyze on a Picks card has no reason to be looking at. The
button visibly does nothing because, from that card's own perspective, it
genuinely doesn't — the fetch succeeds, the state updates, but nothing on
THAT card ever reads the new state. A real, precisely-diagnosed, low-risk
UI fix.

**(c) "Dashboard claims up to date" — a real structural false-reassurance
risk, not a bug in the strict sense.** `src/lib/status/status-strip.ts`:
the freshness label is `MAX(lastSeen)` across every stored gig — "how
recently was ANY gig touched by ANY completed per-source fetch," not "did
the most recent full scan cycle actually complete." Real data at
verification time happened to look fine (8/10 sources shared one fresh,
complete-cycle timestamp, confirming today's fix chain genuinely works
now) — but the mechanism itself has no concept of a cycle being
partial/hung vs. complete, so a FUTURE partial hang (before the
already-shipped fixes, or a new failure mode) would still show a falsely
reassuring "up to date" label built from whichever sources happened to
finish before the hang. Real fix: the status strip should reflect actual
cycle completion state, not just the most recent per-gig touch.

## 2. Deferred, not dropped

The broader "click-through the whole app, document every dead end"
research goal (item 4 of this epic's original brief) and the interactive
re-confirmation of (a) both require `simman` against the real running
app, blocked by a transient Portunus MCP disconnection during this
research pass. This is explicitly QUEUED for retry, not abandoned — the
two confirmed bugs below are real and worth fixing now regardless; the
broader audit continues once the tool reconnects.

## 3. Scope for this epic

Two real, independently-shippable, precisely-diagnosed stories below.
Each carries its own real post-fix verification requirement against the
actual running app (screenshot-equivalent DOM/state evidence via curl
after rebuilding + relaunching, or simman once available) — not just
`npm test` — per the owner's explicit demand.
