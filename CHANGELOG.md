# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [0.35.1] - 2026-09-05

### Fixed

- `isPortunusAvailable()`'s `portunus --version` check had no timeout, and
  its result is cached for the life of the process — a real, live-
  reproduced hang during v0.35.0's own release verification meant a stuck
  `portunus` process could permanently freeze every future `/config`
  render until a full relaunch. Now bounded to 5 seconds; a hung or
  pathologically slow check resolves to "unavailable," same as if
  `portunus` weren't installed at all.

## [0.35.0] - 2026-09-05

### Added

- A new rate-aware match signal — In-band / Near-band / Out-of-band —
  computed alongside (never replacing) the existing GREEN/YELLOW/RED
  tier. Tier answers "is this the right kind of role" (keyword-only);
  band answers "is the rate actually in range." Triggered by a real,
  live incident: a $50-60/hr consulting gig and several $86k-225k/yr
  salaried roles were tiering GREEN ("Strong fit") despite failing
  every configured group's rate floor entirely.
- A new `/config/match-quality` settings page — per-group near-band
  tolerance percentage and a hide-out-of-band-by-default toggle, both
  real, tunable settings (never hardcoded).
- A new Band filter on every giglist view (`/today`, `/gigs`,
  `/[group]/gigs`), defaulting to hiding out-of-band gigs per each
  group's own setting — the direct fix for "I cannot be filtering
  through 100 $140k/yr salaries."
- `autoDraftOnScan`/auto-fire now also require a gig to be in-band, not
  just green-tier, before drafting or firing automatically.

## [0.34.0] - 2026-09-04

### Changed

- The Config Dashboard's 6 cards now show real, multi-row detail —
  rate anchor/home base/timezone on Profile, a healthy/needs-login
  breakdown on Sources, each group's real rate range and AI-verify
  state on Groups, a human-readable schedule (new small cron
  humanizer, falling back to the raw cron string for anything it
  doesn't recognize), and kill-switch/rules-armed detail on Automation
  — instead of one generic line per card.
- The group-switcher pills (shown once 2+ groups are configured) now
  link to the giglist while you're browsing gigs, and to the Dashboard
  everywhere else, instead of always dropping you onto the Dashboard.
  Relabeled "Search:" to "Groups:" and "All groups" to "All Groups."

### Fixed

- Two groups sharing the same label could produce duplicate React keys
  on the Config Dashboard's Groups & Needs card.

## [0.33.0] - 2026-09-04

### Fixed

- Gigs that stopped being re-seen by their source (delisted, or source
  listing churn) kept whatever tier they were first stamped with forever,
  even after redKeywords/coreTitles config changed — a real, live example
  being a stale "Fractional COO" match still showing green weeks after
  "coo" was added to the exclusion list. Gigs still in `new` status are
  now periodically re-tiered against current config once they've gone
  stale (3+ days unseen), and archived with a real `expired_unapplied`
  reason once they're old enough (30+ days) that re-tiering no longer
  makes sense.
- The giglist's filter row was invisible after scrolling even slightly —
  only the column-label row was pinned, not the filter row beneath it.
  Both rows are now sticky with matching heights, so filters stay usable
  the whole way down the list.

### Changed

- The sync-status control on the giglist (GoFractional/Wellfound) is now
  a single dropdown driven by a real per-source registry instead of two
  hardcoded buttons — a future third reconciliation adapter needs one
  registry entry, not a UI change.

## [0.32.0] - 2026-09-04

### Fixed

- AI verification (`GroupConfig.aiVerify`) was already correctly running
  and its verdict was already correctly persisted — but the displayed
  tier never consulted it, so a semantically-rejected match still showed
  as a strong green match. A green tier the AI rejects now downgrades to
  yellow with the model's real reason, visible as a badge on the giglist.

### Changed

- Rebuilt `/config` as a real dashboard: a card-grid home (one card per
  section, real status at a glance) plus a collapsible sidebar, with
  every section (Profile, Sources, Groups & Needs, Schedule, Automation,
  Appearance) now its own dedicated page instead of one long scroll.

## [0.31.1] - 2026-09-03

### Fixed

- `/config` took up to ~2.8s to respond (vs. 0.01-0.3s for every other
  route) — a sequential loop spawned one real `portunus` subprocess per
  configured source. Now runs concurrently.

## [0.31.0] - 2026-09-03

### Added

- **Real Dashboard at `/`**: an animated sonar-sweep header (rotating
  scan icon, live Sources/Profile/Last-sweep readout, a real "Sweep now"
  button that triggers an actual scan), a small set of customizable
  glance tiles, a "Today" teaser, and a compact metrics teaser — each
  section links deeper into its own full page rather than duplicating it.
  The giglist/table that used to live at `/` moved to a new **All Gigs**
  (`/gigs`) page.
- **Bulk "Mark as applied elsewhere"** on both the giglist and Drafts —
  a manual reconciliation fallback for sources gigradar can't yet sync
  application status from directly.
- Draft review cards now show rate/TC, tier, and source for the gig
  behind each draft, instead of just a title and company.

### Fixed

- The scheduler's headed-Chrome fallback (`real-chrome.ts`) could target
  the wrong window via Chrome's own ambiguous `window 1` addressing —
  now targets the exact spawned process by pid.
- Unattended scans (scheduled or button-triggered) never fall back to a
  headed browser window on a headless auth failure anymore — they raise
  an Issue instead, matching this project's own "the app should work
  behind the scenes" design goal.
- Several Server Actions only called `revalidatePath("/")` after gigs
  moved off that route to `/gigs`, leaving the giglist showing stale data
  after a sync/status change.

## [0.30.0] - 2026-09-03

### Added

- **Command Center redesign**: a new multi-page information architecture.
  **Signal Deck** is now the default theme and main `/` dashboard (status
  strip, radial signal meter, reworked row interactions). **Daily
  Shortlist** (`/today`) is a fast daily check-in view separate from the
  full working dashboard. **Metrics** (`/metrics`) is a real
  applied/failed/run-rate throughput dashboard with graphs — this
  project's own founding, previously-unbuilt success criterion, finally
  shipped. **Interview workspace** (`/gigs/[key]/interview`) gives an
  interviewing gig its own dedicated page for the full prep packet and
  grounded application materials, promoted out of a table row. **Signal
  Desk** ships as a 5th selectable theme (a calmer, lighter look).
- **Multi-group support**: track separate groups (e.g. different role
  profiles) each with their own sources, needs, and dashboard —
  per-group dashboard routing, MCP `groupId` support, and dashboard
  filtering/grouping by matched engagement profile.
- **AI-driven match verification** (opt-in per group): an LLM
  double-check on top of keyword-based tiering, to catch false positives
  like "Interim Finance Director" matching on "interim."
- **Customizable tiering**: score-threshold and percentile modes as
  alternatives to keyword-based GREEN/YELLOW/RED tiering, configurable
  per group.
- **Chat co-pilot**: persistent memory across sessions, a gated
  config-edit proposal tool, and contextual hover chat available from
  Dashboard, Drafts, and Config.
- **Platform-aware application drafting**: draft content (proposal /
  why-fit / form-fields / cover-letter) now resolves per-platform instead
  of a one-size-fits-all cover letter.
- **Headless-first scanning** with an automatic headed fallback only when
  a source actually needs it, plus an interactive embedded profile-assist
  pane for guided sessions instead of a flashing native window taking
  over the screen.
- Real resume/career context now reaches draft generation and match
  verification, not just profile ingestion.
- A real Playwright end-to-end test scaffold, with CI now gating every
  PR.
- A dead sidecar process now raises a real issue instead of the app
  silently looking frozen.

### Fixed

- GoFractional company-name scraping bug (a doubled leading letter).
- `recordScan()` no longer mass-archives genuinely-applied gigs on a
  backfill write — a real data-corruption bug found and fixed during a
  deep-dive audit.
- SSRF hardening in the profile-link fetcher: DNS-resolution-based IP
  validation (loopback/link-local/RFC1918, including the cloud metadata
  address), a request timeout, and a streaming response-size cap.
- Windows fallback now separates the encryption-key directory from the
  data directory (was previously the same path, defeating the point of
  the separation).

## [0.25.2] - 2026-08-17

### Fixed

- **macOS JIT entitlements** so the signed Tauri bundle's Node sidecar can
  actually start on a fresh install (was silently failing to launch).

## [0.25.1] - 2026-08-17

### Fixed

- **Free-port detection uses a real connect check**, not a bind check —
  fixes a race where the dev server could pick a port another process was
  about to claim.

## [0.25.0] - 2026-08-17

### Added

- **Catalant added as a source preset**, plus 5 more researched
  fractional/contract platforms added to the source-preset list.
- **Profile-assist: read-only embedded live-view pane** (Slice 1 of the
  `embedded-profile-assist` epic) — watch the guided/full-auto session
  drive the browser without leaving `/config`.

### Fixed

- **Profile-assist now offers every configured browser-session source**,
  not just the 3 that were previously hardcoded into the picker.

## [0.24.2] - 2026-08-17

### Fixed

- **No more hardcoded port 3000** in the Tauri/Electron runtime modes —
  both now resolve the real dev-server port dynamically. Gmail OAuth's
  redirect URI is decoupled from the port-resolution logic as part of the
  same fix.
- Install docs updated for the codesign failure mode fixed in 0.24.1.

## [0.24.1] - 2026-08-16

### Fixed

- **Deep ad-hoc codesigning of the whole `.app` bundle**, not just the
  main binary — fixes a Gatekeeper/launch failure on some macOS versions.

## [0.24.0] - 2026-08-16

### Added

- **`ats-navigator` epic** (4 slices): source presets for guided ATS
  platforms (Indeed, Welcome to the Jungle, Zoho Recruit), a preset
  dropdown in `/config`'s Add-a-source flow, chat-guided source onboarding
  (`list_source_presets`/`add_source` tools), and bidirectional ATS
  keyword scanning surfaced in interview-prep packets.
- **`career-documents` epic** (4 slices): encrypted-at-rest resume
  storage, persisting an uploaded resume + a `/config` Resume section,
  persisted links reaching every LLM call site, and a real
  parseability check.
- Docs: the unsigned `.dmg` + Gatekeeper workaround documented everywhere
  a first-time installer would look.

## [0.23.0] - 2026-08-16

### Added

- **Agent chat (`/chat`)** — a real tool-use loop against your own tracked
  gigs: read-only tools first (Slice 1), propose/approve write tools
  (Slice 2, human-in-the-loop before anything mutates), then
  source-connection + screenshot tools (Slice 3).
- 8 broader, engagement-type-agnostic starter role-area templates, on top
  of the original 5 fractional-C-suite-flavored ones.
- A real Download link/CTA on the GitHub Pages site.

## [0.22.0] - 2026-08-16

### Added

- **`oauth-session-capture-v2` epic** (3 slices): spawn-then-attach a real,
  non-fingerprinted Chrome for Capture Login (fixes Google OAuth's
  automation detection), an owner-selectable Portunus session-vault
  backend alongside the local encrypted vault, and an LLM-guided "does
  this look signed in yet?" capture-readiness check.
- **`llm-custom-sources` epic** (4 slices): add any job board as a source
  by URL — an LLM derives the extraction recipe, caches it, supports
  authenticated (browser-session) sources, and handles pagination — plus
  the `/config` UI to add one with zero code.
- **`verification-copilot` epic** (2 slices): shared Cloudflare/human-
  verification detection with its own distinct issue type, plus an in-UI
  co-pilot action to resolve a blocked source directly from `/issues`.
- **`email-digest-ingestion` epic** (4 slices): a generic OAuth2
  mechanism (PKCE, refresh), a Gmail provider, an LLM-driven digest-email
  extractor, and a `/config` "Connect Gmail" flow — job-alert emails
  become another source.
- **`career-crm` epic, Slice 1** (interview prep): `generatePrepPacket()`
  — fit/gap analysis + interview prep, generated on demand and persisted;
  Slice 2 surfaces a "Generate prep packet" action on the dashboard.
- **Profile-assist** (3 autonomy modes): a persistent browser session +
  Manual mode, Guided mode (human-approval-gated tool-use loop), and
  Full-auto mode (unsupervised).
- Brand styling pass tying the app's chrome to the selected app icon's
  palette.
- Dashboard rebuilt on TanStack Table — real per-column sort + filter.

## [0.21.1] - 2026-08-15

### Added

- **True 1-click macOS installer (Tauri).** A real, double-clickable
  `.app`/`.dmg` alongside the existing browser/Electron modes — a Tauri
  shell spawns a bundled, pinned Node sidecar running gigradar's own
  `.next/standalone` server (never Node-SEA/`pkg`-compiled, for
  `node:sqlite`/Playwright native-binding robustness), polls it for real
  readiness, and only then opens a window — no window before the server
  is confirmed up. Playwright's Chromium is bundled too (zero code
  changes needed in `browser-session.ts` — `PLAYWRIGHT_BROWSERS_PATH` is
  transparently respected), so Capture Login and browser-session sources
  work fully packaged, no first-run download.
- **Real GitHub Actions release pipeline.** Pushing a `vX.Y.Z` (prod) or
  `vX.Y.Z-dev.N` (dev channel) tag builds and publishes a real, signed
  `.dmg` to GitHub Releases (`.github/workflows/tauri-release.yml`).
- **Real in-app auto-update**, dev/prod channel toggle included. A native
  tray menu ("Check for Updates", "Update channel: Dev/Prod", "Quit") —
  checks on launch and on demand, downloads, installs, and restarts.
  Channel preference is a small sibling file next to gigradar's own data
  dir (installer-level state, not `Config`), defaulting to prod (the
  safer choice). Prod's endpoint uses GitHub's own "latest release" alias
  (only resolves non-prerelease tags); dev's endpoint is a `latest.json`
  kept current on a dedicated `dev-manifest` branch, since GitHub has no
  "latest prerelease" equivalent. Live-verified end to end: a real
  installed build detected and applied a real published update, channel
  preference intact across the update-triggered restart. Signed with a
  local test keypair for now — the real production signing key is a
  later, owner-gated step (Portunus-vaulted).
- **App icon picker.** 10 new icon candidates (Gemini "Nano Banana"),
  plus the original hand-drawn mark, selectable per-install from
  `Config → Appearance` — drives both the web app's favicon and the
  desktop app's bundle icon. `iso-radar` is the new default.
- **Dashboard table rebuilt on TanStack Table.** Every column now has
  both a sort control and its own filter control (previously one
  combined search box + a separate filter panel): independent title/
  company text filters, min-rate and max-weekly-hours thresholds, and a
  seen-within-window preset (24h/7d/30d) are all genuinely new.

## [0.21.0] - 2026-08-14

### Added

- **Severity-tiered issue signaling.** A durable `issues` store
  (`warning`/`error`), `raiseIssue()`/`resolveIssue()`/`listIssues()`
  with dedupe-on-open (a repeatedly-failing source raises once, not once
  per cycle), reusing the existing desktop-notification mechanism
  best-effort. Wired into three real, already-existing failure paths:
  per-source fetch errors, auto-draft failures (both `warning`), and
  auto-fire evaluation/submit failures (`warning`/`error`). A new
  `/issues` dashboard page (open issues, Resolve action, collapsed
  resolved history) and a nav badge (hidden at zero open, amber for
  warnings-only, red whenever any error is open).

### Fixed

- **Test isolation**: several pre-existing scheduler/backoff tests were
  silently writing fixture rows to the real production database as an
  unintended side effect of the new `raiseIssue()` wiring above. Added a
  global vitest safety net (`vitest.setup.ts`) so no test can touch the
  owner's real database again, even incidentally.

## [0.20.0] - 2026-08-14

### Added

- **Graduated auto-fire trust system.** Real, per-`(sourceId, tier)`
  submission automation — off by default, earned rather than flipped on.
  `Config.autoFire` (a global `killSwitch` plus per-pair
  `{enabled, minApprovals, dailyCap}` rules); `approvedCount()`/
  `isGraduated()` (pure computation over real approval history, never a
  separate driftable counter); `evaluateAutoFire()`'s full 6-step decision
  tree (kill switch → rule exists → enabled → graduated → a `SubmitAdapter`
  is registered → 4 default checks: tier=green, draft-content sanity,
  freshness/not-delisted, daily fire cap); an append-only
  `autofire_decisions` audit table logging every evaluation, fired or not;
  a `SubmitAdapter` registry (mirrors `Source`'s own registration pattern)
  with a double-submit safety net (`'submitting'` status +
  `markDraftSubmitting()`/`markDraftFailed()`); scheduler wiring
  (isolated per-gig, never crashes a cycle); and a `/config` Auto-fire
  section (kill switch, rule editor, on-demand trust-status check).
  **The first real `SubmitAdapter` (GoFractional) is paused, not
  shipped** — live-verified that GoFractional's job-detail page still
  shows a Cloudflare verification challenge even from a real,
  authenticated, human-worked session. "No `SubmitAdapter` registered"
  is the correct, safe, fully-tested state every pair reaches today; see
  docs/ARCHITECTURE.md's roadmap entry for the live-verified finding and
  a likely real fix flagged for a future story.
- **Local dev-update helper** (`npm run update`, `scripts/update.sh`) —
  pulls the configured channel branch (`dev` by default, `prod` = `main`),
  rebuilds, and restarts the local web server + scheduler in place. A
  same-day dogfooding convenience, not the real end-user auto-updater
  (that's a separate, future 1-click-installer epic).

## [0.19.0] - 2026-08-14

### Added

- **LinkedIn `Source` adapter (`src/lib/sources/linkedin.ts`, `auth: "none"`).**
  Fetches LinkedIn's public, fully server-rendered guest job-search page
  (`/jobs/search/?keywords=...&f_JT=...`) — live-verified (both a real headed
  browser and a bare cookieless `fetch()`) to return real, current listings
  with zero authentication required, no Playwright dependency. Extracts
  id/title/company/location/an absolute posted date per card; strips
  ephemeral tracking query params (`position`/`pageNum`/`refId`/`trackingId`)
  from each `Gig.url`, keeping only the stable per-listing permalink.
  `rate`/`weeklyHours` are left `undefined` — LinkedIn's guest cards show
  neither, never guessed. Registered in the runner, scheduler, and MCP
  server's source lists alongside every other adapter (fixing, in the same
  pass, a pre-existing gap where the MCP server was only registering 4 of
  the project's then-9 adapters).
- **Deliberate, documented exception to this project's `robots.txt`
  convention** for the LinkedIn adapter only — see
  `docs/ARCHITECTURE.md`'s "Deliberate exception: `linkedin.ts` and
  `robots.txt`" section for the full rationale (personal, local-only,
  never-republished use is a materially different situation from operating
  a public scraping service against a `Disallow: /` aimed at bulk/commercial
  crawlers). Scoped to this one adapter; every other adapter's
  `robots.txt`-respecting default is unchanged.

## [0.18.0] - 2026-08-14

### Added

- **Desktop notifications on new green-tier matches (`Config.notifyOnGreenMatch`,
  opt-in, off by default).** Each scheduled scan that finds one or more
  BRAND-NEW (never seen before) green-tier matches fires one best-effort
  native desktop notification (macOS `osascript`, Linux `notify-send`) —
  one summarizing notification per cycle, never one per gig. A gig re-seen
  on a later scan is never re-notified, even if still green-tier. A
  notification failure (unsupported platform, missing OS tool) is logged
  and swallowed — never breaks the scan. New `src/lib/notify/desktop.ts`,
  zero external dependencies; untrusted scraped content (gig title/company)
  is sanitized and escaped before ever reaching a shell command. Live-fired
  a real notification end-to-end through the actual scheduler pipeline to
  confirm.
- `runRadar()` now also returns `newlyInsertedKeys` (from `recordScan()`'s
  own insertion signal) — the new mechanism the notify feature uses to tell
  "just discovered this cycle" apart from "already existed, re-seen."
- **Closed a real gap found while building this:** `autoDraftOnScan` has
  existed since the `auto-draft-on-scan` epic but had ZERO config UI
  wiring — hand-edit-config.json only. Both `autoDraftOnScan` and the new
  `notifyOnGreenMatch` now have real checkboxes in `/config`'s Schedule
  section. Live-verified against the owner's real config.json: "Auto-draft"
  correctly showed pre-checked (matching the value set earlier by hand),
  "Notify" correctly showed unchecked.
- 14 new tests (610 total, 3 opt-in real-browser tests).

## [0.17.1] - 2026-08-14

### Fixed

- **Sticky dashboard table header, take two — found the real root cause.**
  A prior attempt (0.16.0) was reverted after a live-confirmed rendering
  glitch (a scrolled-past row bleeding through above the header). Root
  cause, confirmed by direct DOM experimentation against the live page: the
  table wrapper's `overflow-x-auto` (needed for horizontal scroll on narrow
  viewports) implicitly computes `overflow-y: auto` too, per the CSS2.1
  overflow computed-value rule — so it was already a scroll container, just
  with no bounded height, which broke a page-relative sticky attempt (the
  sticky cells' containing block was that div, not the viewport). Fixed by
  bounding the wrapper (`max-h-[70vh] overflow-auto`) and adding
  `isolation: isolate` to each sticky `<th>` — confirmed live to be the
  actual missing ingredient for the bleed-through: `z-index` alone didn't
  reliably force a new stacking context for a sticky table cell in testing.
  Live-verified against the real running dashboard (296 real gigs) at both
  a small and large scroll offset, and confirmed column sorting still works
  correctly with the header stuck.

## [0.17.0] - 2026-08-13

### Added

- **Ranked engagement profiles — real job-requirements filtering, replacing
  the old flat `minRate`/`allowContractToHire`.** `Needs.engagementProfiles`
  is now a list of named profiles, each with its own accepted engagement
  type(s) (contract / fractional / contract-to-hire / full-time) and its own
  rate floor, in its own unit ($/hr or $/yr total comp). A gig is checked
  against every profile whose type it matches — not just the first — so it
  can clear more than one at once, and each match is recorded
  (`Gig.matchedProfileIds`, persisted). Concretely: a user can say "I want
  $250+/hr fractional or contract work, AND I'd also take a full-time role
  but only above $700k total comp" — a $500k salaried listing is excluded
  while a $750k one passes, and a good hourly contract still passes
  independently. A gig's real engagement type comes from the strongest
  available signal: an explicit `contractToHire` flag, a source's own
  `employmentType` (BuiltIn's real `JobPosting` JSON-LD reports
  `"FULL_TIME"`/`"CONTRACTOR"` — live-confirmed and now extracted), a $/year
  rate (a strong real-world full-time signal — confirmed against 74 of the
  owner's own real tracked listings), or unknown (falls back to hourly
  profiles, matching this project's pre-existing behavior exactly).
- Config UI: the old 4-number-fields-plus-a-checkbox Needs section is now a
  real repeatable profile editor — add/remove profiles, per-profile
  engagement-type checkboxes, rate unit selector (hours fields hide
  automatically for a $/year profile, live-verified).
- A config.json still in the old flat shape (every existing install, until
  next save) is migrated transparently on read into one equivalent profile
  — live-verified against the owner's own real config.
- 30 new tests (576 total, 3 opt-in real-browser tests) — new `gate.test.ts`
  (gate.ts previously had zero dedicated unit tests despite being the
  core matching logic).

## [0.16.0] - 2026-08-12

### Added

- **Dashboard table sorting + a Source filter.** All 8 data-backed columns
  (Source, Title, Company, Tier, Status, Rate, Weekly hrs, Seen) are now
  clickable sort headers — click once for ascending, click again to reverse,
  click a different column to jump straight to ascending on it. Tier sorts
  green→yellow→red (its actual meaning, not alphabetical); Status follows
  its real lifecycle order (new→applied→interview→archived/ignored), not
  alphabetical either. Missing values (no company, no rate, no tier) always
  sort last, in both directions — never silently interleaved as if they
  were zero. New `Source` filter dropdown (options built from the sources
  actually present in your data, never a hardcoded list) combines with the
  existing tier/status/search filters as AND. Live-verified against the
  real running dashboard (228 real gigs): clicking Rate sorted ascending
  ($15/hr → up), clicking again reversed it ($185,000/yr salary listings on
  top).
- 18 new tests (564 total, 3 opt-in real-browser tests) — `dashboard-sort.ts`
  is a new pure, directly-unit-tested module mirroring
  `dashboard-filter.ts`'s existing pattern.
- **General dashboard/nav styling pass.** Nav header: sticky at the top of
  the page, a "gigradar" wordmark, and active-link highlighting
  (`usePathname()`). Dashboard: filter controls grouped into one cohesive
  card, status strip rendered as pills, table gets zebra-striped rows, a row
  hover state, and a card-style border/shadow. Tried (and reverted) a sticky
  table header: `position: sticky` on `<thead>`/per-`<th>` produced a real,
  live-confirmed rendering glitch (a scrolled-past row bleeding through
  above the header) that couldn't be cleanly resolved in this pass, so the
  header stays in normal flow rather than shipping a visible bug — flagged
  as a real follow-up, not silently dropped.

## [0.15.1] - 2026-08-12

### Fixed

- **Capture Login / browser-session Google OAuth rejection.** Both headed
  browser launches (`session-capture.ts`'s guided login capture and
  `browser-session.ts`'s per-run session use) were launching Playwright's
  *bundled* Chromium build ("Chrome for Testing"), which Google's sign-in
  flow actively fingerprints and rejects ("This browser or app may not be
  secure"), independent of session validity. Fixed by launching the real,
  locally-installed Google Chrome (`channel: "chrome"`) instead, via a new
  shared `launchHeadedBrowser()` helper — confirmed live to launch, navigate
  to `accounts.google.com`, and close cleanly using the real Chrome binary.
  Falls back to bundled Chromium (with a one-time warning) on machines
  without Chrome installed, so the module keeps working everywhere; only the
  OAuth-rejection risk is unresolved in that fallback case.
- 3 new tests covering the real-Chrome-preferred launch, the
  bundled-Chromium fallback path, and the both-launches-fail error case
  (551 total).
- **Config UI's Settings editor showed a misleading API-key hint for
  sources that need no credentials at all.** Braintrust and BuiltIn are
  both `auth:"none"` — their optional `settings` (`roleIds`, `category`)
  are listing filters, not credentials — but the Settings editor showed
  the same "value — e.g. env:BRAINTRUST_API_KEY"-style hint for every
  source regardless of its actual auth type. `KNOWN_SOURCES`
  (`src/lib/sources/origins.ts`) now carries each source's real `auth`
  field, and the Settings editor picks a hint that actually matches: a
  plain "no credentials needed" note for `auth:"none"`, a
  `sessionStatePath`-specific note for `auth:"browser-session"`
  (GoFractional, A.Team, Wellfound), and the API-key hint only for a
  future `auth:"api-key"` source. Live-verified in the running dashboard:
  Braintrust's Settings row now reads "value (optional listing filter —
  this source needs no credentials)"; GoFractional/A.Team show
  "value — e.g. a sessionStatePath, or env:VAR_NAME" with an explanatory
  note pointing at "Capture login".

## [0.15.0] - 2026-08-12

### Added

- **`auto-draft-on-scan` epic.** A new, OPT-IN (`Config.autoDraftOnScan`,
  off by default) integration between `scan-scheduler` and
  `assisted-apply-drafting`: when enabled, each scheduled scan
  auto-generates real drafts for up to 5 new green-tier matches per
  cycle, so a scheduled overnight run leaves real, ready-to-review
  drafts in `/drafts` instead of just a longer gig list. This is
  auto-DRAFTING only — nothing about submission changes; the existing
  manual review/approve/mark-submitted flow is untouched, matching this
  project's confirmed "assisted, not auto" posture. A gig with ANY
  existing draft (draft/approved/rejected/submitted) is never
  auto-drafted again. Both prerequisites (an Anthropic API key, an apply
  profile) are checked once per cycle, not rediscovered per-gig, so a
  missing one logs one clear line instead of repeating per eligible gig
  forever.
- 8 new tests (546 total, 3 opt-in real-browser tests).


## [0.14.1] - 2026-08-12

### Fixed

- **`builtin-jd-capture` epic.** BuiltIn's adapter previously captured
  only a short list-card snippet as each gig's `description` — now it
  fetches each listing's own detail page (real, structured `JobPosting`
  JSON-LD, more robust than a hand-rolled HTML regex) for the full job
  posting text. Both role-area tiering and LLM-drafted applications
  directly consume `gig.description`, so this measurably improves match
  quality and draft quality — live-verified: 25/25 real current listings
  went from ~300-500 character snippets to 3-10K character full
  descriptions. Bounded to 4 concurrent detail-page requests at a time;
  a single listing's detail fetch failing falls back to the snippet
  rather than failing the whole scan.
- 5 new tests (538 total, 3 opt-in real-browser tests).


## [0.14.0] - 2026-08-12

### Added

- **`scan-scheduler` epic.** `Config.schedule` has existed since the
  project's very first epic but nothing ever read it — `npm run
  scheduler` is the real thing: a standalone, long-running process
  (`croner`, zero dependencies, timezone-aware via `Profile.timezone`)
  that fires real scans on your configured cadence. Per-source
  exponential backoff (doubling per consecutive failure, capped at 24h,
  resetting on the next success) means a source that starts erroring
  gets skipped for a while instead of hammered every cycle — the
  retry/backoff gap `adapter-batch-public-boards` explicitly deferred to
  this epic, now closed. The scheduler never writes to `config.json`
  under any circumstance (grep-verifiable, regression-tested) — backoff
  filtering is strictly in-memory per cycle. If no schedule is
  configured yet, it idles and rechecks hourly rather than exiting,
  so it plays nicely with a process supervisor set up ahead of time.
- A real, copy-pasteable macOS `launchd` template
  (`docs/scheduler-launchd-template.plist`) for keeping the scheduler
  alive across a machine restart — generic placeholders only, matching
  the legacy tool's own real, proven precedent structurally.
- 26 new tests (534 total, 3 opt-in real-browser tests).


## [0.13.0] - 2026-08-12

### Added

- **`assisted-apply-drafting` epic — the first real INTERACT
  implementation.** `stageApplication()` has been a documented
  `TODO(build)` stub since the project's very first epic; it's now real.
  A new, optional `Config.applyProfile` section (email, phone, LinkedIn,
  headline, bio, rate anchor — encrypted at rest like everything else in
  `config.json`) feeds an LLM call (`@anthropic-ai/sdk`) that drafts a
  real, per-gig application grounded strictly in your actual profile
  data — never fabricating unstated experience, and treating the gig's
  own scraped title/company/description as clearly-delimited untrusted
  data, never instructions.
- **A real review/approve workflow, not a black box.** Drafts land in a
  new `/drafts` page: full editable text, Approve/Reject, and once
  approved, the real gig listing link plus a copy-ready draft. "Mark
  submitted" atomically updates both the draft's own status AND the
  underlying gig's status to "applied" — one action, two consistent
  states, never a desync. Matches this project's standing, confirmed
  architecture principle: **assisted, not auto — nothing submits
  itself.** A minimal guardrail (no red-tier drafting) prevents wasting
  a real LLM call on a gig already flagged clearly off-target; a full
  4-check auto-fire gate and real per-source submit automation are
  explicitly named, deliberately separate, later epics — not silently
  folded into this one.
- A "Generate draft" button appears on green/yellow-tier dashboard rows
  only — never offered for a red-tier gig the backend would reject
  anyway.
- 55 new tests (508 total, 3 opt-in real-browser tests).


## [0.12.1] - 2026-08-12

### Fixed

- **`security-hardening` epic — two confirmed pre-launch findings from
  the security audit.** (1) On Windows, the vault key and all encrypted
  data resolved to the identical default directory, defeating the
  encrypted-local-storage epic's core security property — the key's
  Windows fallback now resolves to a genuinely separate directory, with
  a new test asserting this can't silently regress, plus a non-blocking
  warning if the two ever collide for any reason (including a user
  setting both XDG override vars to the same value themselves). (2) The
  resume/link ingestion feature's link-fetching had zero SSRF
  protection — it now resolves every hostname via real DNS before
  fetching and blocks loopback/link-local (including the cloud metadata
  IP)/RFC1918 targets (with IPv4-mapped-IPv6 bypass addresses
  normalized first), enforces a 10-second timeout and a 5MB streaming
  response cap covering the ENTIRE fetch — including the body-streaming
  phase, not just getting response headers (a real gap a slow-trickle
  response could otherwise exploit, caught and fixed during this epic's
  own review) — and never echoes raw fetch-error detail back to the
  caller.
- 22 new tests (453 total, 3 opt-in real-browser tests).


## [0.12.0] - 2026-08-12

### Added

- **`adapter-batch-public-boards` epic.** Four new source adapters, ported
  from the owner's real legacy pipeline: **FractionalJobs**, **Fractionus**,
  and **FractionalFinders** (all public boards, `auth:"none"`, zero login —
  live-verified with 63/53/8 real listings respectively) follow the same
  fetch()+regex pattern as the existing BuiltIn adapter, not the legacy
  tool's heavier Playwright approach these sites don't actually need.
  **Wellfound** (`auth:"browser-session"`) extracts listings from the
  page's `__NEXT_DATA__` JSON via new recursive-walk logic, with its own
  dedicated Capture Login session (never reusing GoFractional's, unlike
  the legacy tool). The three public adapters are enabled in the owner's
  real local config today; Wellfound is left unenabled pending a real
  Capture Login and a URL-scheme fix (see below).
- The owner's real local `config.json` now has 7 configured sources.
- 49 new tests (431 total, 3 opt-in real-browser tests).

### Known issue

- **Wellfound's board URLs from the legacy tool are dead** — both
  `/role/l/chief-technology-officer` and `/role/l/vp-of-engineering`
  return HTTP 404 today (confirmed live; the site was restructured since
  the legacy tool was built). The adapter's `__NEXT_DATA__`-extraction
  logic is real and tested, but against a clearly-labeled SYNTHETIC
  fixture, not real captured data — the real board URL still needs to be
  found before this adapter can actually run. Standing follow-up, not
  silently claimed as working.


## [0.11.0] - 2026-08-12

### Added

- **`electron-wrapper` epic.** An optional native-window runtime mode —
  `npm run electron` builds and opens gigradar as a real desktop app,
  alongside the existing (completely unchanged) `npm run dev`/`start`
  browser mode. Server code never runs inside Electron's own bundled Node
  runtime — the main process spawns the exact same `npm run start`
  command as a genuine child process and displays it in a window, so
  Electron's own runtime never needs to support `node:sqlite` directly.
  Live-verified on a real machine, not just reasoned through: the window
  opens with the real dashboard and real data, and shutdown cleanly kills
  the full process tree (a naive single-process kill was tested and
  found insufficient, since `next start` spawns a `next-server`
  grandchild — the process-group-kill design was validated by that real
  failure, not assumed).
- 6 new tests (388 total, 3 opt-in real-browser tests).


## [0.10.0] - 2026-08-12

### Added

- **`agent-integration` epic.** A real MCP server (`src/mcp/server.ts`,
  `@modelcontextprotocol/sdk`, stdio transport, `npm run mcp`) exposing 5
  tools — `list_gigs`, `get_gig`, `update_gig_status`, `get_status_summary`,
  `run_scan` — so any MCP client (Claude Desktop, Claude Code, or another)
  can work with a running gigradar instance directly: list/filter tracked
  gigs, change a gig's status, check setup status, or trigger a real scan.
  Every tool is a thin wrapper around the exact `src/lib` functions the
  dashboard and CLI already use — no parallel logic. `update_gig_status`
  enforces the real status enum at the tool's own schema boundary, before
  the handler ever runs. `get_status_summary` only ever reads the
  non-resolving config reader — a resolved secret can never cross this
  boundary.
- **`CLAUDE.md`** — this repo's first, a short pointer to
  `docs/ARCHITECTURE.md` plus the core/user-layer boundary and
  secret-handling rules stated plainly.
- **`docs/mcp-setup.md`** — copy-pasteable MCP client config for both
  Claude Desktop and Claude Code, written against the real shipped tool
  names.
- `src/app/status-strip.ts` relocated to `src/lib/status/` so both the
  dashboard and the new MCP server import the same logic from one neutral
  location, rather than the MCP layer reaching sideways into `src/app`.
- 15 new tests (382 total, 3 opt-in real-browser tests).

## [0.9.1] - 2026-08-12

### Fixed

- **`npm run radar` never actually ran anything.** `runRadar()` was fully
  built and tested since the very first epic, but the CLI entrypoint at
  the bottom of `src/lib/apply/runner.ts` was left as an unimplemented
  `TODO(build)` stub — the script exited 0 having done nothing. Found
  while producing a real, populated dashboard screenshot for this
  project's GitHub Pages site. Now loads the local config, runs one real
  scan, and prints passers + any per-source errors. Source registration
  (`registerSource()`) happens inside the CLI-only code path, not at
  module scope, so `runner.test.ts`'s network-free test doubles (registered
  under the same ids as the real adapters) don't collide with the real ones.

### Added

- A GitHub Pages site (`docs/index.html`) — the project's public landing
  page, once the repo is public: features, a real dashboard screenshot,
  a 4-step "how it works," and an OSS/license section.

## [0.9.0] - 2026-08-12

### Added

- **`profile-overview-ingestion` epic.** A shared nav header (Dashboard /
  Config) and a dashboard status strip — sources configured, profile
  completeness, and last scan time — so the two existing pages are
  actually connected and show real status at a glance.
- **Resume/link → Profile skills ingestion.** An "Extract from
  resume/link" control in `/config`'s Profile section: upload a resume
  (PDF or plain text) and/or paste public links (GitHub, portfolio),
  and Claude's API extracts `{roles, skills}`, merged (case-insensitive,
  deduplicated) into the existing draft — never a silent overwrite,
  nothing persisted until the user's own explicit Save. gigradar's first
  external API dependency (`@anthropic-ai/sdk`) and first LLM use,
  entered as an explicit, per-use, opt-in action.
- The Anthropic API key gets its own UI field (writes to `.env`,
  encrypted at rest) rather than requiring a hand-edited dotfile — a real
  gap caught during design review: the epic's own "no hand-editing"
  north star would otherwise have been violated by its own headline
  feature.
- Uploaded resume content and fetched link text are processed in-memory
  only for the duration of the extraction call and never written to
  disk — a deliberate scope decision that avoids a new sensitive-file
  storage surface entirely.
- Link fetching strips `<script>`/`<style>` element content (not just
  tags) before extracting visible text, and detects known login-wall
  signatures (e.g. LinkedIn) rather than a false-positive-prone
  page-length heuristic — LinkedIn is explicitly documented as not
  reliably supported in v1.
- 59 new tests (367 total, 3 opt-in real-browser/API tests).

## [0.8.0] - 2026-08-11

### Added

- **`encrypted-local-storage` epic — encryption-at-rest by default.**
  `config.json`, `.env`, and every captured browser session-state file
  are now encrypted at rest with AES-256-GCM (`src/lib/security/vault.ts`,
  `node:crypto` only, zero new dependencies), replacing the prior
  `0600`-permissions-only protection. The encryption key lives in a
  separate directory (`XDG_CONFIG_HOME`) from the data it protects
  (`XDG_DATA_HOME`) — never next to it. Existing plaintext files migrate
  transparently and automatically on next read; no manual step required.
  A corrupted or tampered file throws a specific, distinct error rather
  than failing silently or looking like "missing." Losing the key file is
  real, permanent, unrecoverable data loss for what it protects — accepted
  as a tradeoff for this simpler pass, but never silent: losing the key
  while encrypted data still exists throws a specific, actionable error
  rather than silently minting an orphan key. Threat model: this protects
  against accidental exposure through channels that don't respect OS file
  permissions (a stray `git add`, an over-broad backup/sync tool, casual
  browsing by another local account) — it does not protect against
  anything with the same OS-user access gigradar itself runs as. Scoped to
  config/secrets/session files only; the SQLite gig database is unchanged
  (lower sensitivity class, not credentials). An OS-keychain-backed
  design is a deliberately deferred, separate follow-up.
- Went through a full grill (4 findings) + collaborative review (7
  findings) pass before any code was written — including catching a real
  bug before it happened: a naive migrate-on-read implementation would
  have silently broken `save.ts`'s existing "a validation failure leaves
  the file completely untouched" guarantee.
- 34 new tests (278 total, 3 opt-in real-browser tests).

## [0.7.0] - 2026-08-11

### Added

- **`role-templates` epic.** Five generic fractional C-suite role
  templates (CTO, COO, CFO, CMO, CPO) — a "Start from a template" picker
  in `/config`'s role-area section, populating `coreTitles`/`keywords`/
  `redKeywords` with real, thought-through content, including genuine
  title-abbreviation traps (e.g. CMO ↔ Chief Medical Officer, CPO ↔ Chief
  Procurement Officer) as `redKeywords` so tiering doesn't misclassify.
- 17 new tests (222 total, 3 opt-in real-browser tests).

## [0.6.0] - 2026-08-11

### Added

- **`session-capture-ui` epic — guided login through the UI.** A
  "Capture login" button per browser-session source in the config
  editor: opens a real headed Chromium window, you log in normally, click
  "I'm done," and gigradar saves an origin-scoped, sanity-checked,
  atomically-written, `0600`-permissioned session file — no more manual
  `playwright-cli` CLI dance (kept documented as a fallback).
- `src/lib/auth/session-capture.ts` — a genuinely new pattern for this
  codebase: a `globalThis`-pinned capture-session map that survives
  Next.js dev's Hot Module Reloading (a real, previously-undocumented
  failure mode caught during design review before any code was written).
- Shared `src/lib/sources/origins.ts` registry — `gofractional.ts`/
  `ateam.ts`'s origin allowlists extracted to one source of truth, reused
  by both the adapters and the new capture mechanism.
- 44 new tests (205 total, 3 opt-in real-browser integration tests).

### Fixed

- A real hang in `finishCapture()`/`cancelCapture()`/the idle timeout,
  found during real-browser integration testing:
  `browser.removeAllListeners("disconnected")` was also stripping
  Playwright's own internal listener that `browser.close()` depends on to
  resolve — invisible to mocked tests alone.

## [0.5.0] - 2026-08-11

### Added

- **`dashboard-config-ui` epic — gigradar's first UI.** A Next.js 15
  app-router dashboard (Tailwind v4) reading the SQLite store: tier tabs,
  status filters, search, sortable results, and status-change actions
  that actually persist across a production build (a real
  `revalidatePath()` gotcha was caught and regression-tested, not just
  assumed away).
- **Secret-safe config write path** (`src/lib/config/save.ts`) — always
  re-reads raw `config.json` directly; never touches `loadConfig()`'s
  resolved output, so an `env:` reference can never be overwritten with
  its real secret value. First-run (no `config.json` yet) is
  ENOENT-tolerant, not a hard error.
- **Config editing UI** (`/config`) — a real form for Profile/Needs/
  Sources/RoleArea/schedule, with a key/value pairs editor for source
  settings instead of a raw JSON textarea, so a user can configure
  gigradar without ever hand-editing JSON.
- Localhost-only binding by default (`-H 127.0.0.1` on `dev`/`start`) —
  no LAN exposure of pipeline/config data from an unauthenticated
  dev/prod server.
- 31 new tests (158 total).

### Deferred

- Guided browser-session login/session-capture UI and role/engagement
  templates were both scoped out of this epic (confirmed/cut during
  planning review) to keep it honestly sized — each becomes its own
  small follow-on epic.

## [0.4.0] - 2026-08-11

### Added

- **`browser-session-auth` epic.** A generic `auth:"browser-session"`
  mechanism (`src/lib/auth/browser-session.ts`, real `playwright`
  dependency) for sources needing a logged-in session rather than an API
  key. Mandatory per-source origin-scoping filters a storageState file
  down to only that source's own domains before it ever reaches a browser
  context — a real storageState file can carry many unrelated sites'
  sessions (one covers 23 origins including Google SSO); loading it
  unscoped would leak unrelated credentials.
- Real, live-verified **GoFractional** adapter (20 real gigs confirmed via
  a live run) — headed Chromium + a valid stored session, with no
  privilege escalation needed, contrary to the legacy tool's more
  elaborate approach.
- **A.Team** adapter, built on the identical mechanism, code- and
  fixture-tested; live verification is explicitly deferred (its stored
  session is logged out — re-authentication is a standing owner follow-up,
  not a blocker).
- 28 new tests (127 total).

### Changed

- Extracted `env:`-reference string resolution in
  `src/lib/config/load.ts` into a reusable `resolveEnvString()`, shared
  between API-key and browser-session-path resolution.

## [0.3.0] - 2026-08-11

### Added

- **`local-secrets-config-storage` epic.** A local `config.json` +
  `.env` loading layer (`src/lib/config/`), both stored outside the repo
  tree in the same XDG data directory the persistence layer already
  resolves for the SQLite DB — never relying on `.gitignore` alone.
- `env:`-prefixed `SourceConfig.settings` values (e.g.
  `"env:BRAINTRUST_API_KEY"`) resolve against `.env` at load time; a
  referenced-but-unset var throws naming the var, never a value. Resolved
  secrets are never logged, never appear in error messages, and the loaded
  `Config` is never serialized wholesale.
- `config.example.json` / `.env.example` templates at the repo root,
  schema-checked against the real loader so they can't silently drift.
- 20 new tests (72 total), including a real `git check-ignore` subprocess
  check and a file-permission (`0600`) warning path.

## [0.2.0] - 2026-08-11

### Added

- **`find-pipeline-foundation` epic.** Real SQLite-backed persistence
  (`src/lib/store/`) replacing the previous in-memory-only dedup — WAL mode,
  a single shared connection, and a delisting-detection algorithm that only
  flags a gig unavailable when its source is confirmed still working.
- Real, live `Source` adapters for **Braintrust** and **BuiltIn** (both
  public boards, no login required), each with fixture-based unit tests and
  a confirmed one-time live verification run.
- **Role-area tiering** (`src/lib/matching/tiering.ts`) — green/yellow/red
  classification wired into `runRadar()` after the existing gate, driven by
  a user-supplied `RoleAreaConfig` (never hardcoded keywords).
- Full test coverage for all of the above: 43 tests across 6 files, zero
  live-network calls in the automated suite.

### Changed

- `runRadar()` now persists every scan through the new store instead of an
  in-memory `Set`, and stamps a `tier` onto each `MatchResult`.
