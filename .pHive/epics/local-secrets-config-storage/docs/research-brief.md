# Research Brief: local-secrets-config-storage

## 1. Summary

`Config` (`profile`, `needs`, `sources`, `roleArea`, `schedule`) is fully
typed in `src/lib/types.ts` and already documented as "lives in the user's
own storage, never in the repo" — but nothing actually loads it from disk
yet. `runRadar(config)` takes a `Config` object as a direct parameter; every
current test constructs one in-memory. There is no config-loading module,
no `.env` reader, and no local-settings file convention. `.gitignore`
already excludes `.env`, `.env.local`, and `.local/` (from the original
scaffold) but nothing writes to or reads from those paths today.

## 2. Key files & surfaces

- `src/lib/types.ts` — `Config`, `SourceConfig` (has an explicit `settings?:
  Record<string, unknown>` comment: "Never store raw secrets here in OSS —
  reference an env/keychain entry"), `Profile`, `Needs`, `RoleAreaConfig`.
- `src/lib/apply/runner.ts` — `runRadar(config: Config, ...)`; the consumer
  of whatever this epic builds. No changes needed to its signature — it
  already accepts `Config` as a plain object.
- `src/lib/store/path.ts` — the persistence epic's XDG-style user-data-dir
  resolution (`process.env.XDG_DATA_HOME` fallback pattern) — the closest
  existing precedent for "where does local, non-repo state live" and the
  pattern to mirror for consistency, not duplicate logic.
- `.gitignore` — already has `.env`, `.env.local`, `.local/` (original
  scaffold) plus `*.db`/`*.sqlite*` (added by the persistence epic).
- `docs/ARCHITECTURE.md` — the auth/login-handling section already states
  the rule this epic implements: sources declare `auth: "none"|"api-key"|
  "browser-session"`; secrets are "never stored raw in the repo or in
  Config," referenced via "an env var / keychain / session-profile entry;
  the runner resolves it at run time" — that resolution mechanism doesn't
  exist yet.

## 3. Patterns & conventions

- **XDG-style local-dir resolution already exists** (`src/lib/store/path.ts`)
  — reuse the same `process.env.XDG_...`-first, platform-fallback pattern
  for consistency rather than inventing a second convention.
- **No dotenv-style library is installed.** `package.json` has no `dotenv`
  or similar dependency. Next.js (already a dependency) has built-in
  `.env`/`.env.local` loading for its own runtime, but `runner.ts` is
  invoked via `tsx` (see the `radar` script), NOT through Next.js's
  request lifecycle — so Next's built-in env loading does not cover the
  CLI/cron runner path. A loader is needed either way.
- **Config is a plain object today, constructed by hand in tests** — no
  existing "load Config from disk" function to extend; this is new code,
  not a refactor of existing loading logic.

## 4. Constraints

- **Never commit secrets or Config to the repo** — explicit north_star.avoid
  from kickoff, restated in `docs/ARCHITECTURE.md` and in every story of the
  find-pipeline-foundation epic.
- **`SourceConfig.settings` must never hold a raw secret** — only a
  reference (env var name, keychain entry name, session-profile path).
- **Single-user, local-machine framing** (north_star.expected_scale) — no
  need for a secrets manager, vault integration, or multi-user access
  control; a plain local file pair (settings + `.env`) is proportionate.
- **This epic is storage/loading only** — it does NOT implement any new
  auth-requiring Source adapter (A.Team, GoFractional); it only removes the
  blocker so a later epic can.

## 5. Risks

- **Medium — accidental commit of a real local settings/.env file** if the
  gitignore patterns don't exactly match whatever filename/path convention
  this epic picks. Must be verified with an actual `git status` check
  during implementation, not just assumed correct.
- **Low — config validation gaps.** A malformed local settings file (e.g.
  hand-edited YAML/JSON with a typo) should fail loudly and specifically,
  not silently produce a broken `Config` that then produces confusing
  downstream gate/tiering errors.

## 6. Open questions

1. File format for the local settings file — JSON, YAML, or a `.ts`/`.mjs`
   config module the user edits directly? (Next.js/Node ecosystem
   conventions favor either JSON or a `.mjs` config file; no existing
   precedent in this repo to follow.)
2. Exact file paths/names and whether they live under a `.local/` directory
   in the repo root (already gitignored) vs. an XDG-style out-of-repo
   directory (matching the persistence epic's DB location pattern).
3. Validation approach — the repo already depends on `zod`; is a `zod`
   schema for `Config` the validation mechanism?

## inconsistency_risk_signals

- `docs/ARCHITECTURE.md`'s auth section already asserts secrets are
  "referenced" via "env var / keychain / session-profile entry" as if all
  three mechanisms exist — a draft that treats this as already-implemented
  infrastructure would be wrong; only the `.env`-var-reference mechanism is
  in this epic's scope. Keychain and session-profile resolution (needed for
  `browser-session` auth, i.e. A.Team/GoFractional) are explicitly NOT part
  of this epic — this epic unblocks `api-key`-style secrets only via `.env`;
  full session/browser-profile handling remains future work.
