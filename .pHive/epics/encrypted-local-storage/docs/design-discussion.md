# Design Discussion: encrypted-local-storage

## 0. Prelude

**NORTH STAR**: single-user, local, self-configured; "runs on a schedule"
(the cron/CLI path must work non-interactively — no passphrase prompts).

No relevant prior decisions (same cross-project global-KG noise pattern as
every prior epic's query — treated as zero results).

## 1. What Are We Doing?

Making encryption-at-rest the DEFAULT for every local secret/state file
gigradar writes — `config.json`, `.env`, and captured session-state
files — replacing today's `0600`-permissions-only protection (established
across three prior epics) with real AES-256-GCM encryption via Node's
built-in `node:crypto` (zero new dependencies). Explicitly the SIMPLER of
two planned passes, per the user's own framing — a "fancier" OS-keychain-backed
design is deliberately out of scope here, a named follow-up.

**Threat model (added post-grill, resolves U1 below).** This protects
against: accidental exposure of these files through channels that don't
respect OS file permissions (a stray `git add`, a full-disk backup or
sync tool with broader read scope than the user intended, casual
directory browsing by another local account on a shared machine). This
does **not** protect against: anything running as the same OS user/account
gigradar itself runs as — the key is deliberately non-interactively
retrievable (see §5), so a process with that level of access could already
read the key and decrypt everything, exactly as it could already read
today's `0600` plaintext files. This is real, meaningful hardening against
the first class of exposure, not a claim of defense against the second.

**Not a diagnosed bug fix.** The user reported "the local config store was
throwing errors everywhere" but explicitly asked to skip diagnosis and go
straight to this hardening pass. Worth stating plainly: this epic is not
confirmed to fix whatever those errors were — if they recur after this
ships, that's a separate, still-undiagnosed issue, not something this
epic silently absorbed.

"Done": every existing plaintext `config.json`/`.env`/session file is
transparently migrated to encrypted-at-rest on next read, every new write
is encrypted by default, `npm run radar` and the dashboard/config UI both
work identically from the user's perspective (the encryption is invisible
in normal use), and a corrupted/tampered file produces a clear, distinct
error rather than a confusing downstream failure.

## 2. What I Found

- Four real plaintext read/write call sites, confirmed by direct code
  read, not assumed: `config/load.ts` (config.json read, `.env` read via
  `dotenv.config()`), `config/save.ts` (config.json write),
  `auth/browser-session.ts` (session file read), `auth/session-capture.ts`
  (session file write).
- `node:crypto`'s `scryptSync`/`randomBytes`/`createCipheriv` are all
  built-in and available — verified directly, not assumed.
- **`.env`'s dotenv integration is the genuinely tricky piece**:
  `dotenv.config({path})` reads its own file from disk — it cannot accept
  already-decrypted in-memory content. `dotenv`'s separate `parse()`
  export DOES accept a raw string and returns a parsed object without
  touching the filesystem — this is the mechanism that makes an encrypted
  `.env` work with the existing dependency, rather than requiring a
  hand-rolled parser.
- The XDG spec (partially already used for `XDG_DATA_HOME`) also defines
  a separate `XDG_CONFIG_HOME` (`~/.config` on POSIX) — unused today, and
  a natural, zero-new-dependency place to put an encryption key SEPARATE
  from the data directory it protects.
- Every existing write in this codebase already uses atomic
  temp-file+rename + explicit `0600` — the encryption layer must preserve
  this, not bypass it.

## 3. My Proposed Approach

1. **New module `src/lib/security/vault.ts`**:
   - `getOrCreateKey(): Buffer` — resolves a key file path via a NEW
     `getKeyPath()` (in a new `src/lib/security/key-path.ts`, mirroring
     `store/path.ts`'s XDG-resolution pattern but rooted at
     `XDG_CONFIG_HOME`/`~/.config/gigradar/key` — **not** the same
     directory as the data it protects; this directly addresses the
     research brief's "key next to data" risk). If missing, generates a
     random 32-byte key via `crypto.randomBytes(32)`, writes it
     atomically with `0600`. If present, reads and returns it.
   - `encrypt(plaintext: string): string` — AES-256-GCM: random 12-byte
     IV, `createCipheriv`, returns a JSON envelope string
     `{v:1, iv: base64, tag: base64, data: base64}`.
   - `decrypt(envelopeJson: string): string` — reverse; throws a
     SPECIFIC "encrypted file is corrupted or has been tampered with"
     error on GCM auth-tag mismatch (research brief open question #3,
     decided: distinct from "missing," never silently treated the same —
     a tampered file is a meaningfully different, louder failure mode
     than a first-run absence).
   - `isEncryptedEnvelope(raw: string): boolean` — format detection for
     migration: valid JSON with the exact `{v,iv,tag,data}` shape → encrypted;
     anything else → legacy plaintext.
   - **Key-loss handling (added post-grill, resolves H1 below; refined during
     collaborative review).** Losing the key file is real, permanent data
     loss for every file it protects — that tradeoff is accepted for this
     simpler pass (a passphrase-recoverable or keychain-backed design is the
     deferred "fancier" follow-up), but it must never be SILENT.
     `getOrCreateKey()` only auto-generates a fresh key when NEITHER the key
     file NOR any encrypted file exists yet (a true first run). Determining
     "any encrypted file exists" is NOT just checking `config.json` — the
     collaborative review caught that session-state filenames are dynamic
     (`${sourceId}-session.json`, one per configured browser-session source),
     so a naive single-file check could wrongly conclude "first run" while an
     already-encrypted session file sits on disk, silently minting an orphan
     key that can never decrypt it (exactly the failure H1 was meant to
     close). The real check: `config.json` OR `.env` OR any file in the
     session-state directory whose content `isEncryptedEnvelope()` identifies
     as encrypted. If the key file is missing but any of those is found, throw
     a specific, actionable error naming exactly what's unreadable and what to
     do next (re-run config setup via `/config`, re-capture affected
     sessions), rather than silently minting a new key.
2. **`config.json` migration** (`config/load.ts` + `save.ts`, modified):
   on read, detect format via `isEncryptedEnvelope()`; if encrypted,
   decrypt then parse; if legacy plaintext, parse directly AND
   immediately re-write encrypted (transparent, one-time, automatic
   upgrade — no separate migration step or user action). `save()` always
   writes encrypted, same atomic-write discipline as today, just with the
   plaintext JSON now passed through `encrypt()` before hitting disk.
   **`save.ts` has its OWN independent raw read too** (`readRawConfigDocument()`,
   `save.ts:72-97`, and its public wrapper `readRawConfig()` at `save.ts:110-112`,
   consumed by `src/app/config/page.tsx` to pre-populate the config-editing
   form) — confirmed by direct code read during collaborative review, and
   not originally named in this draft. Both need the same
   detect-and-decrypt-if-needed handling. Crucially, these two call sites
   need DIFFERENT migrate-on-read behavior, to avoid a real bug the
   collaborative review caught: `readRawConfigDocument()`'s internal use
   inside `saveConfig()` (as the merge base, immediately followed by
   `saveConfig()`'s own validate-then-write) must NOT independently trigger
   a migrate-write — if it did, a plaintext file would get rewritten
   encrypted even when the caller's edits then FAIL validation, silently
   breaking `save.test.ts`'s existing "a validation failure writes
   nothing; whatever was on disk before is left completely untouched"
   invariant (`save.ts:29-30`). Only the externally-facing entry points —
   `readRawConfig()` called standalone by the config UI, and `loadConfig()`
   — auto-migrate on read; a read used purely as input to an
   immediately-following write (which will itself re-encrypt the whole
   document) just decrypts, it doesn't separately write.
   **`readRawConfig()`'s meaning is unchanged, just reinterpreted**: "raw"
   already means "not env-resolved" today (see `save.ts:100-108`'s own
   docstring); post-encryption it means "decrypted (if the file was
   encrypted) but still not env-resolved" — never the literal envelope
   bytes.
3. **`.env` migration** (`config/load.ts`, modified): read the raw file
   content directly (bypassing `dotenv.config()`'s own file read).
   Detect format; if encrypted, decrypt to get the real `KEY=VALUE` text;
   if legacy plaintext, use as-is AND re-write encrypted (same
   auto-migrate pattern). Either way, feed the resulting plaintext string
   to `dotenv.parse()` (not `.config()`), then apply the parsed key-values
   to `process.env` manually, replicating the existing `override: false`
   semantics (only set a var if not already present in `process.env`).
   **This hand-rolled apply loop must preserve `load.ts`'s "never log a
   secret" contract** (collaborative-review finding): today that contract is
   upheld for free by `dotenv.config()`'s own internals (called with
   `quiet: true`); once this epic replaces it with a manual
   `for...of Object.entries(parsed)` loop, that loop itself must never log
   or include a key/value pair in any error message — same standard as
   every other line in this file.
4. **Session-state file migration** (`auth/session-capture.ts`'s write,
   `auth/browser-session.ts`'s read, both modified): identical
   detect-and-migrate pattern. `session-capture.ts`'s atomic
   temp-file+rename write now writes the `encrypt()`-wrapped envelope
   instead of the raw storageState JSON. `browser-session.ts`'s
   `readStorageStateFile()` detects format, decrypts if needed, and
   (like the others) re-writes encrypted if it was legacy plaintext.
   **The atomic-write helper needs to be exported** (collaborative-review
   finding): the temp-file+rename write logic currently lives inline in
   `session-capture.ts` (around line 297) and is not exported today, but
   `browser-session.ts`'s migrate-on-read now needs that exact same
   atomic-write discipline to safely rewrite a session file it only opened
   for reading. Export it (e.g. `writeStorageStateAtomically()`) from
   `session-capture.ts` and import it in `browser-session.ts`, rather than
   duplicating the temp-file+rename logic a second time.
5. **Auto-migrate-on-read is an intentional, documented departure from
   `load.ts`'s existing "only ever reads" invariant (added post-grill,
   resolves C1 below).** `src/lib/config/load.ts`'s current file header
   states, as a deliberate design choice, that `loadConfig()` "only ever
   reads" and never writes. Steps 2-4 above have the read paths
   (`loadConfig()`, `.env` loading, `readStorageStateFile()`) perform a
   write when they upgrade legacy plaintext to encrypted. Decision: keep
   auto-migrate-on-read (the alternative — migrating only on next
   save/capture — would leave a user who only ever runs `npm run radar`
   non-interactively with permanently plaintext files, defeating the
   "default" framing of this epic). This departure must be made explicit,
   not silent: the `load.ts` header comment must be updated in the same
   story that implements this, replacing "loadConfig() only ever reads"
   with an accurate statement that it may perform a one-time encrypt-migration
   write on legacy plaintext input, so the invariant the code actually
   documents matches what it does.
6. **Scope: config/secrets files only, NOT the gig database**
   (research brief open question #2, decided): `gigs.db` (scraped
   job-listing data) stays as-is — a genuinely different, lower
   sensitivity class than credentials/session-cookies/personal-profile
   data. Encrypting a SQLite database file is also a materially different,
   larger technical problem (page-level encryption vs. whole-file) not
   justified by this epic's actual risk target.

## 4. What Could Go Wrong

- **High — a naive implementation could put the key next to the data it
  protects, providing encryption in name only.** This is why key storage
  is a first-class design decision (§3 step 1), not an afterthought —
  `XDG_CONFIG_HOME` vs. `XDG_DATA_HOME` gives real separation without any
  new dependency or OS-specific integration.
- **Medium — migration bugs could corrupt or silently fail to protect
  existing files**, especially the user's OWN already-captured
  GoFractional session and hand-configured `config.json`. Needs explicit
  round-trip tests: legacy plaintext in → correctly migrated encrypted
  out → correctly re-readable.
- **Medium — `.env`'s dotenv bypass is real, non-trivial surgery** on a
  working code path (confirmed in `local-secrets-config-storage`'s own
  tests) — needs its own focused review, not folded invisibly into
  "just encrypt the file."
- **Low — this does not fix the undiagnosed "errors everywhere" report.**
  Named explicitly, not silently implied to be resolved.

## 5. Dependencies and Constraints

- Depends on `local-secrets-config-storage` (config/`.env` loading,
  merged), `browser-session-auth` (session file consumption, merged),
  `session-capture-ui` (session file creation, merged) — modifies all
  three's file I/O, not their public APIs/contracts.
- Zero new dependencies — `node:crypto` only.
- Non-interactive requirement: the key must be retrievable without a
  passphrase prompt, so `npm run radar` (cron) keeps working unattended —
  this is WHY the design is "a random key in a separate, permission-locked
  file" rather than "a user-remembered passphrase," which would break the
  north star's scheduled-run requirement.

## 6. Open Questions

1. ~~Key storage location~~ — **resolved**: `XDG_CONFIG_HOME`-based
   separate directory, per §3 step 1.
2. ~~Encrypt the gig database too?~~ — **resolved**: no, scoped to
   config/secrets files only, per §3 step 5.
3. ~~Corrupted/tampered file handling~~ — **resolved**: a distinct, loud
   error, never conflated with "missing," per §3 step 1.

## 6a. Grill Findings Addressed

Grill round 1 (`.pHive/epics/encrypted-local-storage/docs/grill-record.md`,
`unresolved_count: 4`) surfaced 4 findings, all resolved in this revision:

- **H1** (key loss = silent permanent data loss) — resolved in §3 step 1:
  accepted as a tradeoff for this simpler pass, but `getOrCreateKey()` must
  distinguish first-run from lost-key and throw a specific, actionable error
  in the latter case, never silently mint a new orphaned key.
- **H2** (scale estimate omitted existing test rewrites) — resolved in §8:
  file count revised from ~10-12 to ~14-16, the 4 affected existing test
  files named explicitly with confirmed call-site counts.
- **U1** (undefined threat model) — resolved in §1: explicit statement of
  what this does and does not protect against.
- **C1** (auto-migrate-on-read contradicts `load.ts`'s documented
  "only ever reads" invariant) — resolved in §3 step 5: kept as an
  intentional departure (required to make migration truly automatic/default
  rather than contingent on the user next saving via the UI), with the
  `load.ts` header comment update to match made an explicit part of the
  implementing story rather than left as untracked drift.

## 6b. Collaborative Review Findings Addressed

Two independent reviews (backend-implementation lens, test-coverage lens),
run against the grill-revised draft, surfaced 7 concrete findings — all
grounded in direct reads of the real current code, not speculation — all
resolved in this revision:

- `save.ts`'s own independent raw-read path (`readRawConfigDocument()` /
  `readRawConfig()`) was missing from the migration plan entirely — added
  in §3 step 2, including the correct migrate-only-on-standalone-read vs.
  decrypt-only-on-internal-read distinction needed to avoid breaking
  `save.ts`'s existing "no write on validation failure" invariant.
- `readRawConfig()`'s post-encryption meaning clarified in §3 step 2:
  decrypted-but-env-unresolved, consistent with what "raw" already means
  today.
- `session-capture.ts`'s atomic-write helper needs exporting for reuse by
  `browser-session.ts`'s migrate-on-read — added in §3 step 4.
- Key-loss detection needed to scan the session directory (dynamic
  filenames), not just check `config.json` — refined in §3 step 1.
- The manual `.env` → `process.env` apply loop must preserve the
  never-log-a-secret contract — added in §3 step 3.
- The GCM tamper test's methodology was ambiguous (byte-flip-in-JSON-text
  risks testing base64 decoding, not auth-tag verification) — corrected in
  §7.
- The verification plan didn't name the 4 existing test files needing
  rewrites, nor the new `XDG_CONFIG_HOME` test-isolation need — both added
  to §7.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest; node:crypto (built-in)
  Platforms: Node.js only
  Automated: vault.ts unit tests (encrypt/decrypt round-trip; tamper
    detection — decode the envelope's base64 `data`/`tag` fields to raw
    bytes, flip a bit WITHIN the decoded ciphertext, then re-encode before
    decrypting, to actually exercise the GCM auth-tag mismatch path rather
    than just breaking base64 decoding, which is a different, less
    interesting failure the naive "flip a byte in the JSON text" approach
    would mostly hit instead — refined during collaborative review; confirm
    a specific "corrupted or tampered" error, not a generic parse failure;
    key generation + persistence across multiple getOrCreateKey() calls
    returns the SAME key; the key-loss-vs-first-run distinction from §3
    step 1, including the multi-file/session-directory scan case);
    migration tests for each of config.json, `.env`, and session files —
    legacy plaintext fixture in, confirm correct parse AND confirm the file
    on disk is now encrypted after the read; the .env dotenv.parse()-based
    override:false semantics test (an already-set process.env var is not
    overwritten by a decrypted .env value, matching current behavior
    exactly); the no-write-on-validation-failure regression test from
    save.test.ts, re-verified specifically against a LEGACY PLAINTEXT input
    file (confirming saveConfig()'s internal raw-read does NOT trigger an
    independent migrate-write before validation, per §3 step 2's resolution
    of the collaborative review's flagged bug).
  Updating existing tests (scope named explicitly per grill finding H2 and
    confirmed by direct inspection): all fixture/assertion call sites in
    load.test.ts, save.test.ts, browser-session.test.ts, and
    session-capture.test.ts that construct or read plaintext file content
    directly must be rewritten for the encrypted-envelope format; all four
    files also need `XDG_CONFIG_HOME` isolation added alongside their
    existing `XDG_DATA_HOME` isolation (collaborative-review finding — the
    new key file resolves under `XDG_CONFIG_HOME`, and without isolating it
    in tests the same way `XDG_DATA_HOME` already is, tests would read/write
    the real dev machine's `~/.config/gigradar/key`).
  Manual: a full local smoke test — with an EXISTING plaintext
    config.json/.env/session file (simulating a real upgrade from a
    pre-epic install), run npm run radar and confirm it still works, then
    confirm the files are now encrypted on disk; open /config, confirm
    the form still loads/saves correctly.
  Not verifying: OS-keychain integration (explicitly the deferred
    "fancier" follow-up epic, not this one); gig-database encryption
    (explicitly out of scope, §3 step 5).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~14-16 (new src/lib/security/vault.ts + key-path.ts +
    their new tests; modifications to load.ts/save.ts/browser-session.ts/
    session-capture.ts; and — confirmed by direct inspection, not estimated,
    per grill finding H2 — 4 EXISTING test files whose fixtures/assertions
    construct or read plaintext file content directly and must be rewritten
    for the new encrypted-envelope format: save.test.ts (8 read/writeFileSync
    call sites), load.test.ts (3), browser-session.test.ts (3),
    session-capture.test.ts (2))
  Subsystems: encryption/key-management (new), migration logic touching
    THREE already-shipped consumer modules
  Migration required: YES — this is itself a migration epic for every
    existing plaintext file, a different character from most prior
    epics' "build something new" shape
  Cross-team coordination: no
  Unknowns: 0 remaining (all three open questions resolved above)

  RECOMMENDATION: Needs H/V planning (Medium)
  RATIONALE: Unlike role-templates' pure-addition shape, this epic
    MODIFIES four already-shipped, already-tested, security-sensitive
    files across three prior epics' work — real regression risk on
    working code, not just new-code risk. The vault module itself should
    land and be proven first (mirroring every prior epic's "isolate the
    highest-stakes piece" pattern — config-write-path, persistence-layer-sqlite,
    session-capture-mechanism), with each consumer's migration as a
    separate, focused story after it. Not Large: no structural unknowns
    remain (all three open questions resolved), a vertical slice plan is
    sufficient to sequence the vault-first-then-consumers shape correctly.
```
