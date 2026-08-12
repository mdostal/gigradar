// Writes and reads a SINGLE named .env var — the write-side counterpart
// this epic needed once "Anthropic API key" became a UI form field instead
// of a hand-edited dotfile (profile-overview-ingestion epic,
// profile-ingestion-module story; see
// .pHive/epics/profile-overview-ingestion/docs/design-discussion.md §3
// step 1, resolving grill finding U1).
//
// Deliberately separate from load.ts's loadDotEnvFile(): that function
// populates process.env for the CLI/cron path (apply/runner.ts, via
// loadConfig()). The Next.js app's Server Action request path never goes
// through loadConfig() and so never populates process.env from .env at all
// — see design-discussion.md §3 step 4's collaborative-review finding. This
// module's read-side helper (readEnvVar()) is built for exactly that
// caller: it resolves a value fresh from .env on disk, every call, and
// NEVER mutates process.env — the opposite contract from loadDotEnvFile().
//
// THE NON-NEGOTIABLE MECHANISM, matching save.ts's own precedent for
// config.json (see save.ts's header comment for the full rationale): this
// module DUPLICATES, rather than imports, load.ts's private atomic-
// write-then-encrypt helper. load.ts's version is intentionally not
// exported — importing it here (or exporting it just for this) would
// re-couple this module to load.ts's internals the same way save.ts's
// header comment argues against for config.json. A few duplicated lines is
// the accepted cost of keeping this file independently auditable.
//
// Secret-handling contract (this story's highest-stakes requirement, same
// as load.ts's/save.ts's): the var name or value being set or read is
// NEVER logged, NEVER included in a thrown error message or an
// ActionResult error string, and never appears in any error thrown by this
// module. If you touch this file, keep auditing that invariant.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { type ActionResult, actionErr, actionOk } from "../actions/result.js";
import { decrypt, encrypt, getOrCreateKey, isEncryptedEnvelope, VaultTamperError } from "../security/vault.js";
import { getEnvPath, hasAnyEncryptedFile } from "./load.js";

/**
 * Local, deliberately-DUPLICATED equivalent of load.ts's private
 * writeEncryptedAtomically() (temp file in the same directory, then
 * `fs.renameSync`, mode 0600 pinned via chmodSync afterward since
 * writeFileSync's `mode` option is subject to the process umask) — see this
 * file's header comment. Do NOT "clean this up" by importing load.ts's
 * version; it's private for exactly this reason, and save.ts's header
 * comment explains why that duplication is the intended shape here too.
 */
function writeEncryptedAtomically(filePath: string, raw: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(tmpPath, encrypt(raw), { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // tmp file was never created, or is already gone — nothing to clean up.
    }
    throw e;
  }
}

/**
 * Reads .env fresh from disk — decrypting it first if it's already an
 * encrypted envelope (calling getOrCreateKey(hasAnyEncryptedFile) before
 * decrypt(), same discipline as load.ts's loadDotEnvFile()) — and returns
 * its parsed `{ [key]: value }` shape via `dotenv.parse()`. A missing .env
 * returns `{}`, NOT an error: same "missing is fine, no encryption
 * operation attempted" convention load.ts's loadDotEnvFile() uses. Never
 * touches process.env, and never logs or throws with any key/value from
 * the parsed result.
 */
function readEnvFileRaw(): Record<string, string> {
  const envPath = getEnvPath();

  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`gigradar config: could not read "${envPath}": ${e instanceof Error ? e.message : String(e)}`);
  }

  // Ensure the vault key exists (or fail loudly if it's been lost while
  // encrypted data sits on disk) BEFORE attempting any decrypt() below —
  // see vault.ts's getOrCreateKey() doc comment.
  getOrCreateKey(hasAnyEncryptedFile);

  const wasEncrypted = isEncryptedEnvelope(raw);
  let dotenvText: string;
  if (wasEncrypted) {
    try {
      dotenvText = decrypt(raw);
    } catch (e) {
      if (e instanceof VaultTamperError) {
        // Re-thrown as the SAME error type, with an actionable,
        // .env-specific message spliced in ahead of vault.ts's own
        // explanation — mirrors load.ts's loadDotEnvFile(). Never includes
        // any key/value from the file.
        e.message = `gigradar config: "${envPath}" ${e.message}`;
        throw e;
      }
      throw e;
    }
  } else {
    dotenvText = raw;
  }

  return dotenv.parse(dotenvText);
}

/**
 * Serializes a `{ [key]: value }` map back to `KEY=VALUE\n` lines, one per
 * entry. Accepted, documented cosmetic tradeoff (see design-discussion.md
 * §3 step 1): a dotenv.parse()-then-reserialize round trip drops any
 * comments/blank-line formatting from a hand-edited .env the first time
 * this module writes to it — a one-time, harmless normalization, not a
 * bug. Never called with, and never logs, the values it serializes.
 */
function serializeDotEnv(vars: Record<string, string>): string {
  return `${Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

/**
 * Sets (or overwrites) a single named var in .env, encrypted at rest.
 * Preserves every other var already present in .env — whether the existing
 * file was legacy plaintext or already an encrypted envelope — merging at
 * the single-var level rather than replacing the whole file. Calls
 * `getOrCreateKey(hasAnyEncryptedFile)` before `encrypt()` (required —
 * vault.ts's encrypt() throws otherwise if no key exists yet).
 *
 * Never logs `name` or `value`, and never includes `value` in the returned
 * ActionResult's error string on failure (readEnvFileRaw()'s and
 * writeEncryptedAtomically()'s own errors only ever name the .env path,
 * never file contents).
 */
export function setEnvVar(name: string, value: string): ActionResult<void> {
  try {
    const current = readEnvFileRaw();
    current[name] = value;

    // Belt-and-suspenders: ensure the key exists even on a true first
    // write (readEnvFileRaw() above only calls getOrCreateKey() when an
    // existing .env was found to decrypt) — encrypt() below requires it.
    getOrCreateKey(hasAnyEncryptedFile);
    writeEncryptedAtomically(getEnvPath(), serializeDotEnv(current));

    return actionOk<void>(undefined);
  } catch (e) {
    return actionErr(e);
  }
}

/**
 * Read-side helper: resolves a single named var fresh from .env
 * (decrypt-if-needed via vault.ts, `dotenv.parse()`), WITHOUT mutating
 * process.env — the read-side counterpart designed for the Next.js Server
 * Action request path, which never triggers .env-into-process.env loading
 * (see this file's header comment). Returns `undefined` when .env doesn't
 * exist, or exists but doesn't define `name`.
 *
 * Never logs `name` or the resolved value, and never includes either in a
 * thrown error message.
 */
export function readEnvVar(name: string): string | undefined {
  return readEnvFileRaw()[name];
}
