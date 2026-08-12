# Design Discussion: local-secrets-config-storage

## 0. Prelude

**NORTH STAR** (from `.pHive/project-profile.yaml`):
- **Goal:** Track engagements end-to-end, with each install single-user and
  self-configured.
- **Audience:** Owner first, but generically OSS — single-user, local,
  self-configured.
- **Scale:** Single-user, single-machine. No hosted/multi-tenant in v1.
- **Pain points:** The prior tool was flaky/inconsistent; the rewrite's bar
  is fully tested, working, consistent.

No prior KG decisions found for this requirement.

## 1. What Are We Doing?

`Config` (profile, needs, sources, roleArea, schedule — see `types.ts`) is
fully typed and already documented as living in "the user's own storage,
never in the repo," but nothing loads it. This epic builds that loading
layer: a local settings file for `Config` and a `.env` file for secrets
(API keys, session references), both git-ignored, both 100% local to the
machine running gigradar — never committed to the OSS repo.

"Done": a user can hand-edit a local settings file + `.env`, run
`npm run radar`, and have it load a real `Config` (validated, with clear
errors on mistakes) without ever touching `src/lib`. Nothing about this
epic implements a NEW auth-requiring Source adapter — it removes the
storage blocker so a later epic can build A.Team/GoFractional (both need
non-`"none"` auth) without inventing an ad-hoc scheme under pressure.

**Explicit scope boundary** (this draft narrows an inconsistency the
research brief flagged): `docs/ARCHITECTURE.md`'s auth section describes
three secret-reference mechanisms — env var, keychain, session-profile
entry. This epic builds ONLY the env-var mechanism (a local `.env` file).
Keychain integration and persisted browser-session-profile handling (both
needed for `browser-session`-auth sources like A.Team/GoFractional) are
explicitly follow-on work, not this epic.

## 2. What I Found

- `Config` is a plain object today; every test constructs one by hand. No
  "load Config from disk" function exists to extend — this is new code.
- `SourceConfig.settings` already carries an explicit comment: never store
  raw secrets here, reference an env var/keychain entry instead — this
  epic is what makes that comment actually enforceable/usable.
- `src/lib/store/path.ts` (from the persistence epic) already established
  an XDG-style local-directory-resolution pattern
  (`process.env.XDG_DATA_HOME` first, platform fallback) — reuse this
  exact pattern for consistency rather than inventing a second convention
  for "where does local machine state live."
- No `dotenv`-style package is installed. Next.js's built-in env loading
  doesn't cover the CLI/cron path (`runner.ts` runs via `tsx`, outside
  Next's request lifecycle) — a loader is needed regardless of Next.js.
- `.gitignore` already excludes `.env`, `.env.local`, and `.local/` from
  the original scaffold — this epic needs to confirm whatever exact
  filenames it picks are actually covered, not just assume it.
- `zod` is already a dependency, unused so far — a natural fit for
  validating a hand-edited local settings file with clear error messages.

## 3. My Proposed Approach

1. **Location: outside the repo tree, matching the persistence epic's
   precedent — not `.local/` inside it** (grill C1/P1: an earlier draft put
   both files inside the git working tree, gitignore-only — the same
   codebase already rejected exactly that pattern for the SQLite DB file
   as insufficient defense-in-depth for local secrets/state, and API keys
   are more sensitive than scanned job listings, not less). Both the
   settings file and the `.env` secrets file live in the SAME XDG-style
   user-data directory `src/lib/store/path.ts` already resolves for the DB
   (e.g. `~/.local/share/gigradar/` on macOS/Linux, respecting
   `XDG_DATA_HOME`) — reuse that resolver directly rather than duplicating
   the logic: `config.json` and `.env` sit alongside `gigs.db` in the same
   directory. `.gitignore`'s existing `.env`/`.local/` patterns remain as
   belt-and-suspenders (harmless even though nothing should ever write a
   real secret inside the repo tree now), matching the DB file's own
   pattern exactly.
2. **Local settings file**: `config.json` in that directory. JSON over
   YAML/`.mjs`: zero new parsing dependency (`JSON.parse` is built in), and
   a `.mjs` config module would let arbitrary code execute on load, which
   is unnecessary risk for a config file. Validate against a new `zod`
   schema mirroring the `Config` interface — `roleArea` and `schedule`
   are `.optional()` (never `.default()` or silently coerced, team-review
   finding — architect: `Config`'s own doc comments specify omission as
   meaningful, not an error) — fail loudly with a specific field-level
   error on load, not a generic parse failure.
3. **Secrets file**: `.env` in that same directory. Load via a minimal,
   dependency-free parser (KEY=VALUE lines) — or add the `dotenv` package
   if a minimal hand-rolled parser proves error-prone for edge cases
   (quoting, multiline values); decide during implementation, not here.
   **Env-var-reference convention, fully specified** (grill H1: an earlier
   draft specified this by a single example key name, not a general rule):
   any `SourceConfig.settings` value that is a string with the literal
   prefix `env:` (e.g. `{"apiKey": "env:BRAINTRUST_API_KEY"}`) is treated
   as a reference — the loader resolves it to `process.env.BRAINTRUST_API_KEY`
   at load time and throws a specific error if that env var is declared as
   a reference but unset. **Scope: top-level string values only for v1**
   (team-review finding — architect: `settings` is typed
   `Record<string, unknown>` and can hold nested objects/arrays; walking
   those recursively is real additional design surface, not a trivial
   extension). Document this limitation explicitly in the loader's JSDoc —
   a source needing a nested secret reference is out of scope until a
   concrete case demands it, not silently unsupported.
   **Secret-handling stance** (team-review finding — security-reviewer):
   resolved secret values are never logged, never included in thrown error
   messages (error messages name the *env var name* only, never its
   value), and the loaded `Config` is never serialized/dumped wholesale
   anywhere in this module. This is a hard requirement on the
   implementation, not a suggestion.
4. **Loader module** (`src/lib/config/` — new): exports a synchronous
   `loadConfig(): Config` (team-review decision — tpm: sync vs. async is a
   public-API-shape decision, not safe to defer to implementation time;
   sync matches the primary caller, `runner.ts` via `tsx`, and mirrors
   `path.ts`'s existing sync style; a future async wrapper is trivial to
   add on top if the eventual Next.js UI epic needs one, so nothing is
   foreclosed) that resolves the shared XDG directory (reusing
   `src/lib/store/path.ts`'s `getDefaultDataDir()`, confirmed by team
   review to need no changes — a plain `path.join()` at each call site),
   reads and validates `config.json`, reads `.env` from the same
   directory, and resolves every top-level `env:`-prefixed
   `SourceConfig.settings` value, throwing a clear error (naming the env
   var, never its value) if a referenced env var is declared but unset.
   **File permissions** (team-review finding — security-reviewer): the
   loader creates `config.json`/`.env` (if missing, from the example
   templates) with mode `0600` (owner-only), and warns loudly if an
   existing file is group- or world-readable.
5. **Gitignore verification**: confirm via `git check-ignore` (not just
   visual inspection) that nothing under the resolved XDG directory could
   ever be tracked even if a user's `XDG_DATA_HOME` happened to point
   inside the repo — belt-and-suspenders on top of the outside-repo default.
6. **Example/template files**: `config.example.json` and `.env.example`,
   both committed AT THE REPO ROOT (these are documentation, not the real
   files — they contain placeholder/dummy values only) so a new user knows
   the expected shape without needing to read TypeScript types or guess
   the XDG path. `config.example.json` must validate against the same zod
   schema as the real loader (team-review finding — tpm: prevents silent
   schema drift where the example goes stale relative to the real
   `Config` type) — enforced by a test, not just eyeballed at write time.

## 4. What Could Go Wrong

- **Medium — accidentally committing a real secret or settings file**
  (downgraded from the earlier in-repo-tree draft's High: defaulting
  outside the repo tree, matching the persistence epic's pattern, removes
  the primary risk — gitignore is now defense-in-depth, not the only
  safeguard). Still verify with an actual `git check-ignore` during
  implementation, not just visual inspection.
- **Medium — silent misconfiguration.** A missing or malformed settings
  file must fail with a specific, actionable error (which field, what's
  wrong) — not a generic crash or, worse, a silently-empty `Config` that
  makes every gig look like "no matches" (echoes the existing
  no-silent-zero rule for sources, applied here to config loading too).
- **Low — scope creep toward keychain/session-profile handling.** Explicitly
  out of scope per §1; only env-var secret references ship here.

## 5. Dependencies and Constraints

- Depends on `src/lib/store/path.ts`'s existing XDG-directory resolver
  (reused, not duplicated) and the `Config`/`SourceConfig` types already in
  `src/lib/types.ts` (unmodified).
- `zod` is already a dependency (validation). `dotenv` may be added if
  needed (see §3) — a small, well-known, zero-risk addition if used.
- Must not require any changes to `runRadar()`'s signature — it already
  accepts a plain `Config` object; this epic only builds what constructs
  one from disk.

## 6. Open Questions

1. ~~Hand-rolled `.env` parser vs. adding the `dotenv` package~~ —
   **resolved by user**: use `dotenv` (well-known, handles quoting/
   multiline edge cases the hand-rolled option would need to reinvent).
2. ~~Should `loadConfig()` be sync or async?~~ — **resolved during team
   review**: sync. See §3 step 4.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest
  Platforms: Node.js only
  Automated: loader unit tests (valid config loads correctly; missing file
    produces a specific error; malformed JSON produces a specific error; an
    `env:`-prefixed settings value referencing an unset env var throws with
    a specific message naming the var (never the value); a resolved `env:`
    reference correctly flows into the loaded Config's `SourceConfig.settings`;
    config omitting `roleArea`/`schedule` validates successfully; the loader
    correctly resolves the shared XDG directory via `src/lib/store/path.ts`'s
    existing resolver; created `config.json`/`.env` have mode `0600`;
    `config.example.json` validates against the same zod schema as the real
    loader) + a real gitignore check (`git check-ignore` against the
    resolved XDG path and against `.env`/`config.json` at repo root, not
    just visual inspection of the gitignore file).
  Manual: none required — this is pure local file I/O with no live network
    or external service dependency.
  Not verifying: keychain integration, browser-session-profile handling —
    both explicitly out of scope (§1).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~6-8 (new src/lib/config/ module + tests, .local/config.example.json,
    .env.example, possible small .gitignore confirmation edit)
  Subsystems: config loading (new, single self-contained module)
  Migration required: no
  Cross-team coordination: no
  Unknowns: 2 open questions above, neither blocking (both resolvable during implementation)

  RECOMMENDATION: Proceed directly to stories
  RATIONALE: Single new, self-contained module with no cross-subsystem
    interaction (unlike find-pipeline-foundation's three interacting
    subsystems) — no H/V slicing needed to sequence this correctly.
```
