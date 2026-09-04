# Design discussion — config-detail-and-scan-hardening

## 0. Context

Follow-on to `config-rebuild-and-match-quality` (all 6 autonomously-executable
stories shipped, released as v0.33.0). During today's release verification and
live dogfooding, the owner surfaced three real, confirmed problems that don't
belong in that epic (it's closed) and don't belong as ad-hoc fixes (owner's
explicit, repeated directive: everything goes through `/plan` → `/execute`,
looped until the backlog is 0, then grilled/triaged/verified before release).

## 1. Goal

Three independent, real fixes:

1. The Config Dashboard's 6 cards render a single generic one-liner each
   ("10 configured", "1 group", a raw cron string, "Off") instead of the rich,
   multi-field detail the approved "Concept C" card-grid design actually had.
   Owner confirmed via direct screenshot comparison: "this is what i asked for
   — not [this] — wtf."
2. The owner's real, live config bundles all three engagement-rate profiles
   (fractional/hourly, full-time, fallback-hourly) into one group, and has
   AI-verify off. Owner already confirmed (via AskUserQuestion, same session)
   the fix: split into a Fractional/Hourly group and a Full-Time group, both
   with `aiVerify: true`.
3. `/config` hangs indefinitely on the FIRST request after a fresh packaged-
   app launch (every request after that is fast). New evidence gathered today
   (0% CPU, main thread blocked in `kevent`, zero child processes spawned
   during the hang) meaningfully narrows what was, until today, a fully
   unresolved mystery.

## 2. Proposed approach

**Story A — rich config dashboard cards.** Extend `ConfigSectionMeta` (in
`src/app/config/config-sections.ts`) from a single `summary(data): string` to
a `details(data): {label, value}[]` — one row per real, computed fact, no
fabricated numbers. `src/app/config/page.tsx`'s card renders each row instead
of one summary line. Concretely:

- **Profile**: name, top 2 roles, `applyProfile.rateAnchor` (if set, as
  `$X/hr`), `profile.homeBase.city` (if set), timezone.
- **Sources**: a real 3-way breakdown from `ConfigPageData.sessionReadiness`
  (`"connected"` / `"no-login-needed"` counted as healthy, `"needs-login"` as
  needing attention) — richer and more accurate than the existing
  `computeSourceCounts()`, which only distinguishes "has settings" from
  "doesn't."
- **Groups & Needs**: one row per group — its label, its engagement profiles'
  real rate range (formatted per `rateUnit`: `"$150+/hr"` for an hourly
  profile with no upper bound, `"$250k–$400k TC"` for a salaried one), and
  `aiVerify: on/off`.
- **Schedule**: a small human-readable cron formatter (new,
  `src/lib/schedule/describe-cron.ts`) for the common shapes this app's own
  schedule field actually produces (`M H * * *`, `M H1,H2,H3 * * *`,
  `M H * * 1-5` and similar weekday-range forms) — falls back to showing the
  raw cron string verbatim for anything it doesn't recognize, never a wrong
  guess.
- **Automation**: kill-switch state, plus `rules configured` / `rules armed`
  counts (real data already computed once in the existing `summary()` —
  reused, not duplicated).
- **Appearance**: unchanged (already accurate: "Icon & theme").

**No new "Google connection" card.** Verified: today's config schema has no
generic, app-wide Google-connection concept — OAuth is scoped to specific
sources (e.g. a `gmail-digest` source's own settings). Inventing a 7th card
for a concept that isn't real would repeat exactly the mistake this epic
exists to fix (showing something that isn't backed by real data). If a
specific Google-connected source needs its own status row, that belongs
inside the Sources card's own detail rows as a per-source case, not a new
top-level section — out of scope for this epic unless a story finds a clean,
real hook for it.

**Story B — real profile/group restructuring.** A one-off, reviewed script
(matching this session's own established pattern for live-config edits: real
`readRawConfig()`/`saveConfig()` calls, never hand-edited JSON) that:
1. Reads the current single group (`default-search-1`).
2. Writes two groups — `fractional-hourly` (engagement profiles `a-fractional-hourly` + `c-fallback-hourly`) and `full-time` (engagement profile `b-fulltime`) — each carrying the SAME `roleArea` (25 coreTitles / 96 redKeywords, unchanged) as the original group, and `aiVerify: true`.
3. Re-reads the config afterward to confirm the write round-tripped correctly (profile/sources untouched, exactly 2 groups, correct engagement-profile assignment, `aiVerify: true` on both).

This story runs against the owner's real `~/.local/share/gigradar/config.json`
— that's the point, not a violation of this session's "never touch real user
data" testing discipline (which is about not using real data as a *test
fixture*, not about declining genuine, owner-directed configuration changes).

**Story C — /config cold-start hang, focused investigation.** Today's new
evidence (cold-start-only; 0% CPU; blocked in `kevent`; zero children spawned)
rules out the two hypotheses the earlier investigation (this session, `/config`
latency work) already eliminated (portunus itself being slow; a PATH ENOENT).
Zero children spawned during the hang is the most useful new fact — it means
the hang happens BEFORE `isPortunusAvailable()`'s `portunus --version` spawn
ever fires, not inside it. Candidate angles for this story to check (not to
assume the answer up front):
- Whether the FIRST request to *any* route (not specifically `/config`) hangs
  the same way — if so, this is a Tauri-sidecar-cold-start issue, not a
  `/config`-specific one, which redirects the fix entirely.
- A one-time cost in whatever runs before user code on the very first request
  in this specific packaged runtime (Next.js build-manifest lazy compilation,
  a bundled-binary Gatekeeper/quarantine check on first `exec`, or a
  first-connection cost in the Tauri sidecar's own stdio/IPC bridge).
This story's acceptance is a conclusively identified root cause OR a real fix
— not another inconclusive pass. If genuinely inconclusive after a real,
focused attempt, document precisely what was ruled out (same discipline as
every prior pass) rather than guessing.

## 3. Dependencies

Story A and Story C are independent of each other and of Story B — no shared
files, no ordering requirement. Story B is also independent (touches only the
owner's live config.json, no application code). All three can execute in
parallel; sequenced here only by write-conflict safety in this lean, single-
assistant execution model (config-sections.ts/page.tsx for A; scheduler/sidecar
code for C — no overlap).

## 4. Risks

- **Story A**: a wrong/fabricated number is worse than a sparse one — every
  row must trace to a real field, verified against `readRawConfig()` output,
  not assumed from the schema.
- **Story B**: restructuring the owner's live, actively-scanned config while
  the scheduler is running — mitigated by editing via the app's own
  `saveConfig()` (which does a top-level shallow merge, so a bad write can't
  corrupt unrelated top-level keys) and by re-reading to confirm before
  declaring done.
- **Story C**: this exact bug already survived one full investigation this
  session. Real risk of spending the same time again for the same
  inconclusive result — mitigated by testing the new "any route, not just
  /config" hypothesis FIRST, since it's cheap and would redirect the whole
  investigation if true.

## 5. Verification

Stories A and C: strictly in-app, curl-only against an isolated dev server
(`XDG_DATA_HOME` override) — never a real browser, never Playwright, matching
this session's standing constraint. Story B: verified by re-reading the real
config.json after the write (not a browser check) and, per the owner's own
follow-up request, a real re-scan afterward to confirm both new groups
produce sane per-group tiering.

## 6. Scale

Small-to-medium: three independently scoped, well-understood fixes against an
already-mapped codebase. No H/V planning needed — straight to stories.
