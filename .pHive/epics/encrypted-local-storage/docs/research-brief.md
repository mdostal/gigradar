# Research Brief: encrypted-local-storage

## 1. Summary

Every local secret/state file gigradar writes today is plaintext on disk,
protected only by `0600` file permissions (established across three prior
epics: `local-secrets-config-storage`, `browser-session-auth`,
`session-capture-ui`). This epic makes encryption-at-rest the default for
those files, using Node's built-in `node:crypto` (no new dependency) —
explicitly scoped as the SIMPLER of two planned passes; a "fancier"
OS-keychain-backed follow-up is deliberately deferred, per the user's own
framing.

## 2. Key files & surfaces — every current plaintext read/write call site

- `src/lib/config/load.ts:97` — `fs.readFileSync(configPath, "utf8")`,
  reads `config.json` plaintext.
- `src/lib/config/load.ts:165` — `dotenv.config({ path: envPath, ... })`,
  reads `.env` plaintext DIRECTLY OFF DISK via dotenv's own file-reading —
  this is a real complication: `dotenv.config()` doesn't accept
  already-decrypted in-memory content, only a file path it reads itself.
- `src/lib/config/save.ts:75,175` — raw-read then `fs.writeFileSync(configPath,
  ..., {mode: 0o600})` for `config.json`.
- `src/lib/auth/browser-session.ts:109-112` —
  `readStorageStateFile()`'s `fs.readFileSync(filePath, "utf8")`, reads a
  captured session's storageState JSON.
- `src/lib/auth/session-capture.ts:297` —
  `fs.writeFileSync(tmpPath, serialized, {mode: 0o600})` inside an
  atomic temp-file+rename write, for a freshly captured session.
- `src/lib/store/path.ts` — `getDefaultDataDir()`, the existing XDG-style
  resolver (`XDG_DATA_HOME` → `~/.local/share/gigradar`, Windows
  `%LOCALAPPDATA%`) — the location convention already established for all
  of the above.

## 3. Patterns & conventions

- `node:crypto` is Node's built-in module — `scryptSync`, `randomBytes`,
  `createCipheriv`/`createDecipheriv` are all available with zero new
  dependencies (verified directly, not assumed).
- The XDG Base Directory spec (which `path.ts` already partially follows
  for `XDG_DATA_HOME`) ALSO defines a separate `XDG_CONFIG_HOME`
  (`~/.config` on POSIX) — currently unused by this project, but a natural
  fit for storing an encryption KEY separately from the DATA it protects.
- Every write in this codebase already uses atomic temp-file+rename +
  explicit `0600` mode (established in `config-write-path` and
  `session-capture-mechanism`) — the encryption layer should preserve
  this discipline, not bypass it.
- `dotenv`'s `parse()` export (distinct from `config()`) accepts a raw
  string/Buffer and returns a parsed key-value object WITHOUT touching the
  filesystem itself — this is the mechanism that makes decrypting `.env`
  in memory before parsing actually work with the existing dotenv
  dependency, rather than requiring a hand-rolled parser or a
  write-decrypted-plaintext-to-a-temp-file workaround (which would
  defeat the point).

## 4. Constraints

- **Migration, not a breaking change.** Every prior epic's users (including
  this project's own owner, who has already captured a real GoFractional
  session file and hand-configured a `config.json`) have EXISTING plaintext
  files. A hard cutover that fails to read them would break every current
  install. Must detect-and-migrate transparently, not require a manual
  step.
- **No new heavy dependency** — `node:crypto` is sufficient for the
  "simple default" pass; an OS-keychain library (e.g. something in the
  `keytar`-successor space) is explicitly follow-up-epic scope.
- **Self-hosted, single-user, local-machine framing carries through**:
  the key-storage design must not require the user to remember/enter a
  passphrase on every automated cron run — that would break the
  "runs on a schedule" north-star requirement. The key must be
  retrievable non-interactively.

## 5. Risks

- **High — a key stored right next to the data it protects provides
  little real protection** (the naive "just add crypto" trap): if both
  the encrypted file AND its key live in the same directory with the same
  permissions, an attacker (or accidental exposure) that reaches one
  reaches both, and the encryption adds complexity without adding real
  security margin over today's `0600`-plaintext approach.
- **Medium — `.env`'s dotenv integration is genuinely more complex than
  `config.json`'s.** `dotenv.config()` reads its own file; making `.env`
  encrypted requires bypassing that and using `dotenv.parse()` on
  in-memory decrypted content instead — a real code-path change, not just
  "wrap read/write."
- **Medium — migration correctness.** A bug in plaintext-detection during
  migration could either (a) silently fail to migrate (defeating the
  epic's purpose) or (b) try to decrypt already-plaintext content and
  corrupt/lose it. Needs careful, explicit format detection.
- **Low — this does not address the actual root cause of "errors
  everywhere" the user reported**, since that diagnosis was explicitly
  skipped per the user's direction. Worth naming: this epic is a
  deliberate hardening pass, not confirmed to fix a specific bug that was
  never diagnosed.

## 6. Open questions

1. Key storage location — `XDG_CONFIG_HOME`-based separate directory
   (research brief's leaning, given it requires zero new dependencies and
   directly addresses the "key next to data" trap) vs. some other
   separation strategy?
2. Does this epic encrypt the SQLite gig database (`gigs.db`) too, or
   scope to config/secrets files only (`config.json`, `.env`, session
   state)? The gig database holds scraped job-listing data, not
   credentials — a different, lower sensitivity class. Leaning: scope to
   secrets/config files only for this pass; the DB is a separate,
   lower-priority concern.
3. What happens on a corrupted/tampered encrypted file (GCM auth-tag
   mismatch)? Should this be treated the same as "missing," triggering
   whatever fallback each consumer already has, or a distinct, louder
   error?
