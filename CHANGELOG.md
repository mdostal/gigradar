# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

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
