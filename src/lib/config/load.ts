// Loads and validates the user's config.json, and (this story) layers in
// secret resolution from a sibling .env file. Both live OUTSIDE the repo
// tree — see docs/ARCHITECTURE.md and src/lib/store/path.ts: this reuses
// getDefaultDataDir() directly (the SAME XDG-style directory the SQLite
// store resolves for gigs.db) rather than re-deriving the location, so
// config.json, .env, and the DB always share one parent directory. There is
// deliberately no separate path-resolution logic for .env — see
// getEnvPath() below.
//
// This module deliberately does NOT create config.json (or .env) if
// they're missing — config.example.json / .env.example (repo root) are the
// user's copy-and-fill-in starting points. A missing config.json is a hard,
// actionable error, never silent scaffolding, and a missing .env is simply
// treated as "no secrets to resolve" (env: references still error
// individually if unset — see resolveEnvReferences()). If a future story
// adds first-run auto-creation of either file here, it must create it with
// mode 0600 (owner-only) to match the permission contract enforced on read
// below.
//
// loadConfig() is NOT a pure read (encrypted-local-storage epic,
// config-json-encryption story — a deliberate, documented departure from
// this module's earlier "only ever reads" invariant). config.json is
// encrypted at rest via src/lib/security/vault.ts: on read, loadConfig()
// detects the on-disk format with isEncryptedEnvelope() — if it's already
// an encrypted envelope, it decrypts before parsing, no further write. If
// it's legacy plaintext, it parses the content as-is AND performs a
// one-time, automatic migration write, re-encrypting that same content back
// to config.json (atomic temp-file+rename, mode 0600). The alternative —
// migrating only on the next saveConfig() — would leave a user who only
// ever runs `npm run radar` non-interactively with a permanently plaintext
// file, defeating this epic's "encrypted by default" framing. See
// .pHive/epics/encrypted-local-storage/docs/design-discussion.md §3 steps 2
// and 5.
//
// .env gets the exact same treatment (env-encryption story, §3 step 3):
// loadDotEnvFile() below detects format, decrypts-and-parses-in-memory (it
// bypasses dotenv.config(), which insists on reading its own file off disk
// and cannot accept already-decrypted content — see that function's own
// doc comment) or migrate-writes legacy plaintext, same atomic discipline
// as config.json above.
//
// Secret-handling contract (this story's highest-stakes requirement — see
// .pHive/epics/local-secrets-config-storage/stories/env-secrets-and-templates.yaml):
// resolved secret values are never logged, never included in a thrown error
// message (errors name the env VAR, never its value), and the loaded
// Config is never serialized/dumped wholesale anywhere in this module. If
// you touch this file, keep auditing that invariant.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { decrypt, encrypt, getOrCreateKey, isEncryptedEnvelope, VaultTamperError } from "../security/vault.js";
import { getDefaultDataDir } from "../store/path.js";
import type { Config, SourceConfig } from "../types.js";
import { ConfigSchema } from "./schema.js";

const CONFIG_FILE_NAME = "config.json";
const ENV_FILE_NAME = ".env";
const ENV_REF_PREFIX = "env:";
/** Matches auth/session-capture.ts's `${sourceId}-session.json` naming convention — see hasAnyEncryptedSessionFile() below. */
const SESSION_FILE_SUFFIX = "-session.json";

/** Full path to config.json (does not imply it exists yet). Same parent directory as getDefaultDbPath(). */
export function getConfigPath(): string {
  return path.join(getDefaultDataDir(), CONFIG_FILE_NAME);
}

/**
 * Full path to the .env file (does not imply it exists yet) — the SAME XDG
 * data directory as config.json and the DB, via getDefaultDataDir(). No
 * separate path-resolution logic on purpose (see file-level comment).
 */
export function getEnvPath(): string {
  return path.join(getDefaultDataDir(), ENV_FILE_NAME);
}

/** True if `mode` grants read access to "group" or "other" (e.g. 0644, 0640, 0604). */
function isGroupOrWorldReadable(mode: number): boolean {
  return (mode & 0o044) !== 0;
}

/**
 * True if config.json OR .env OR any `*-session.json` file in the
 * session-state directory exists on disk and its content is a valid
 * encrypted vault envelope (per isEncryptedEnvelope()). This is the
 * `hasAnyEncryptedFileFn` callback getOrCreateKey() consults to tell "true
 * first run" (safe to mint a brand-new key) apart from "the key file is
 * gone but encrypted data still exists" (must throw VaultKeyLostError,
 * never silently orphan that data) — see vault.ts's own doc comment.
 *
 * Originally config.json-only (config-json-encryption story); extended to
 * also check .env (env-encryption story), then extended again here
 * (session-file-encryption story, the epic's final consumer story) to also
 * scan the session-state directory — completing design-discussion.md §3
 * step 1's full check: "config.json OR .env OR any file in the
 * session-state directory." Session filenames are dynamic
 * (`${sourceId}-session.json`, one per configured browser-session source —
 * see auth/session-capture.ts), so this can't be a single fixed path check
 * the way config.json/.env are; see hasAnyEncryptedSessionFile() below.
 * Called from this module's own entry points (loadConfig(),
 * loadDotEnvFile()) AND from auth/session-capture.ts's
 * writeStorageStateAtomically() and auth/browser-session.ts's
 * readStorageStateFile() — any of those could be the first vault operation
 * in the process, so each calls getOrCreateKey(hasAnyEncryptedFile) itself
 * rather than assuming load.ts's entry points always run first.
 */
export function hasAnyEncryptedFile(): boolean {
  return isFileEncrypted(getConfigPath()) || isFileEncrypted(getEnvPath()) || hasAnyEncryptedSessionFile();
}

/** True if `filePath` exists on disk and its content is a valid encrypted vault envelope. A missing file is false, not an error. */
function isFileEncrypted(filePath: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  return isEncryptedEnvelope(raw);
}

/**
 * True if the session-state directory (the SAME XDG data directory as
 * config.json/.env, via getDefaultDataDir() — see
 * auth/session-capture.ts's finishCapture(), which writes each captured
 * session to `<getDefaultDataDir()>/<sourceId>-session.json`) contains at
 * least one `*-session.json` file whose content is a valid encrypted vault
 * envelope. A missing/unreadable directory is false, not an error — same
 * "missing is fine, not fatal" convention as isFileEncrypted() above.
 * Filtered to the `-session.json` suffix (rather than checking every file
 * in the directory) so this never misreads config.json/.env themselves
 * (already checked separately above) or the unrelated gigs.db as a session
 * file.
 */
function hasAnyEncryptedSessionFile(): boolean {
  const dataDir = getDefaultDataDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dataDir);
  } catch {
    return false;
  }
  return entries.filter((name) => name.endsWith(SESSION_FILE_SUFFIX)).some((name) => isFileEncrypted(path.join(dataDir, name)));
}

/**
 * Encrypts `raw` (the exact bytes already read from `filePath`) and writes
 * the result back to `filePath` atomically — a temp file in the same
 * directory, then `fs.renameSync` — with mode 0600, mirroring vault.ts's own
 * writeKeyAtomically() and session-capture.ts's
 * writeStorageStateAtomically(). Shared by both migrateConfigToEncryptedAtomically()
 * (config.json) and .env's own migrate-on-read write in loadDotEnvFile()
 * below — same mechanism, different target file, so there is no reason to
 * duplicate the temp-file+rename logic a second time within this module
 * (unlike the deliberate cross-module duplication between this file and
 * save.ts — see save.ts's header comment for why that one is intentional).
 */
function writeEncryptedAtomically(filePath: string, raw: string): void {
  const dir = path.dirname(filePath);
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
 * Used only by standalone, externally-facing read entry points (loadConfig()
 * below, save.ts's readRawConfig()) to transparently upgrade a legacy
 * plaintext config.json the first time it's read — never by a read used
 * purely as another write's merge base (see save.ts's
 * readRawConfigDocument(), which decrypts-if-needed but deliberately never
 * calls this).
 */
export function migrateConfigToEncryptedAtomically(configPath: string, raw: string): void {
  writeEncryptedAtomically(configPath, raw);
}

/**
 * Backfills `needs.engagementProfiles` from the deprecated flat
 * `needs.minRate`/`highRate`/`maxHours`/`maxHoursAtHighRate`/
 * `allowContractToHire` fields when the new field is absent —
 * engagement-profiles story. A pre-existing config.json (written before
 * that story) has the old flat shape and would otherwise fail
 * ConfigSchema's validation on every read, since `engagementProfiles` is
 * required with no default. Runs on the PARSED-but-not-yet-validated JS
 * object, before ConfigSchema.safeParse() — a read-time-only shape
 * migration (never writes to disk itself; the caller's own encrypted-at-
 * rest migrate-on-read, if any, handles persistence separately). The old
 * fields are left in place harmlessly (zod strips unknown keys); a
 * subsequent config save naturally drops them since the config UI's draft
 * no longer round-trips them.
 *
 * The single synthesized profile covers contract/fractional/
 * contract-to-hire-or-not exactly as the old flat fields did: CTH included
 * when `allowContractToHire` was true, excluded when false or absent.
 * Nothing here can infer a "full-time" profile — that's new capability
 * with no historical equivalent to migrate from, so a migrated config
 * simply has no full-time profile until the user adds one.
 */
export function migrateNeedsEngagementProfiles(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null) return parsed;
  const doc = parsed as Record<string, unknown>;
  const needs = doc.needs;
  if (typeof needs !== "object" || needs === null) return parsed;
  const needsObj = needs as Record<string, unknown>;
  if ("engagementProfiles" in needsObj) return parsed;
  const { minRate, highRate, maxHours, maxHoursAtHighRate, allowContractToHire } = needsObj;
  if (
    typeof minRate !== "number" ||
    typeof highRate !== "number" ||
    typeof maxHours !== "number" ||
    typeof maxHoursAtHighRate !== "number"
  ) {
    return parsed;
  }
  const types: string[] = ["contract", "fractional"];
  if (allowContractToHire === true) types.push("contract-to-hire");
  const engagementProfiles = [
    {
      id: "default",
      label: "Contract/fractional",
      types,
      minRate,
      highRate,
      maxHours,
      maxHoursAtHighRate,
      rateUnit: "hour",
    },
  ];
  return { ...doc, needs: { ...needsObj, engagementProfiles } };
}

/**
 * Reads, decrypts (if needed), parses, and validates config.json from the
 * XDG data directory. Synchronous by design (not deferred) — this matches
 * the primary caller (src/lib/apply/runner.ts, invoked via tsx) and
 * src/lib/store/path.ts's existing sync style.
 *
 * Throws a specific, actionable error — naming the file and what's wrong —
 * on: a missing file, invalid JSON, a zod validation failure, or a
 * corrupted/tampered encrypted file (vault.ts's VaultTamperError, re-thrown
 * with a config.json-specific message — see the decrypt() call below).
 * Never returns a partial or silently-empty Config.
 *
 * Encrypted-at-rest (config-json-encryption story): see this file's header
 * comment for the migrate-on-read behavior.
 */
export function loadConfig(): Config {
  const configPath = getConfigPath();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(configPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `gigradar config: no config.json found at "${configPath}". ` +
          "Create one there (profile, needs, and sources are required; roleArea and schedule are optional) " +
          "before running gigradar.",
      );
    }
    throw new Error(
      `gigradar config: could not read "${configPath}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Permission check on READ (config.json holds no secrets by itself, so
  // this warns rather than throws — same warn-don't-throw pattern the .env
  // loader below uses too, since even there the story treats this as
  // non-fatal, just prominent).
  const mode = stat.mode & 0o777;
  if (isGroupOrWorldReadable(mode)) {
    console.warn(
      `gigradar config: "${configPath}" is readable by group or other (mode ${mode.toString(8).padStart(3, "0")}). ` +
        `Run \`chmod 600 ${configPath}\` to restrict it to your own user.`,
    );
  }

  // Ensure the vault key exists (or fail loudly if it's been lost while
  // encrypted data sits on disk) BEFORE attempting any decrypt() below —
  // see vault.ts's getOrCreateKey() doc comment.
  getOrCreateKey(hasAnyEncryptedFile);

  const raw = fs.readFileSync(configPath, "utf8");
  const wasEncrypted = isEncryptedEnvelope(raw);

  let jsonText: string;
  if (wasEncrypted) {
    try {
      jsonText = decrypt(raw);
    } catch (e) {
      if (e instanceof VaultTamperError) {
        // Re-thrown as the SAME error type (never conflated with a generic
        // Error) with an actionable, config.json-specific message spliced
        // in ahead of vault.ts's own explanation.
        e.message = `gigradar config: "${configPath}" ${e.message}`;
        throw e;
      }
      throw e;
    }
  } else {
    jsonText = raw;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(
      `gigradar config: "${configPath}" is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!wasEncrypted) {
    // Legacy plaintext: transparently upgrade to an encrypted envelope, one
    // time, automatic — see this file's header comment.
    migrateConfigToEncryptedAtomically(configPath, raw);
  }

  const migrated = migrateNeedsEngagementProfiles(parsed);

  const result = ConfigSchema.safeParse(migrated);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`gigradar config: "${configPath}" failed validation:\n${details}`);
  }

  // Load .env (if present) into process.env BEFORE resolving any "env:"
  // references below, then resolve them. Order matters: a reference to a
  // var that only .env defines must still resolve.
  loadDotEnvFile();

  return {
    ...result.data,
    sources: result.data.sources.map(resolveSourceEnvReferences),
  };
}

/**
 * Loads .env (if it exists) from the same XDG data directory as config.json
 * into process.env. Missing .env is NOT an error: it's an optional file,
 * and a config.json with no "env:" references never needs one — a missing
 * .env returns immediately, before any encryption operation is attempted.
 * An existing .env that's group- or world-readable gets a loud, non-fatal
 * console warning (naming the file, never its contents) — for a file that
 * may hold real secrets, this is load-bearing, not a hygiene nit.
 *
 * Encrypted-at-rest (encrypted-local-storage epic, env-encryption story):
 * .env is encrypted via src/lib/security/vault.ts, same migrate-on-read
 * discipline as config.json (see this file's header comment) — on read,
 * detects the on-disk format with isEncryptedEnvelope(); if already an
 * encrypted envelope, decrypts before parsing, no further write; if legacy
 * plaintext, parses the content as-is AND performs a one-time, automatic
 * migration write, re-encrypting that same content back to .env (atomic
 * temp-file+rename, mode 0600).
 *
 * This deliberately bypasses `dotenv.config()` (which reads its own file
 * off disk and cannot accept already-decrypted in-memory content): the raw
 * file is read directly via fs.readFileSync, decrypted if needed, then fed
 * to `dotenv.parse()` (parsing only, no file I/O) to get a
 * `{ [key]: value }` object. That object is applied to process.env with a
 * hand-rolled loop replicating dotenv.config()'s `override: false`
 * semantics exactly: never override a value already present in process.env
 * (e.g. one the shell/CI already exported).
 *
 * Secret-handling contract (see this file's header comment): the apply loop
 * below must never log, include in an error message, or otherwise surface
 * any key or value parsed from .env.
 */
function loadDotEnvFile(): void {
  const envPath = getEnvPath();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(envPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // no .env — fine, nothing to load, no encryption operation attempted
    throw new Error(
      `gigradar config: could not read "${envPath}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const mode = stat.mode & 0o777;
  if (isGroupOrWorldReadable(mode)) {
    console.warn(
      `gigradar config: SECURITY WARNING — "${envPath}" is readable by group or other ` +
        `(mode ${mode.toString(8).padStart(3, "0")}) and may contain secrets. ` +
        `Run \`chmod 600 ${envPath}\` now to restrict it to your own user.`,
    );
  }

  // Ensure the vault key exists (or fail loudly if it's been lost while
  // encrypted data sits on disk) BEFORE attempting any decrypt() below —
  // see vault.ts's getOrCreateKey() doc comment. Idempotent with
  // loadConfig()'s own getOrCreateKey() call above (same key file, same
  // bytes back out every time — see vault.ts's header comment) — calling it
  // again here keeps this function correct on its own, independent of
  // caller order.
  getOrCreateKey(hasAnyEncryptedFile);

  const raw = fs.readFileSync(envPath, "utf8");
  const wasEncrypted = isEncryptedEnvelope(raw);

  let dotenvText: string;
  if (wasEncrypted) {
    try {
      dotenvText = decrypt(raw);
    } catch (e) {
      if (e instanceof VaultTamperError) {
        // Re-thrown as the SAME error type (never conflated with a generic
        // Error) with an actionable, .env-specific message spliced in ahead
        // of vault.ts's own explanation — mirrors loadConfig()'s config.json
        // handling above. Never includes any key/value from the file.
        e.message = `gigradar config: "${envPath}" ${e.message}`;
        throw e;
      }
      throw e;
    }
  } else {
    dotenvText = raw;
  }

  if (!wasEncrypted) {
    // Legacy plaintext: transparently upgrade to an encrypted envelope, one
    // time, automatic — see this file's header comment and
    // migrateConfigToEncryptedAtomically()'s config.json equivalent above.
    writeEncryptedAtomically(envPath, raw);
  }

  const parsed = dotenv.parse(dotenvText);

  // Manual override:false apply, replicating dotenv.config()'s default
  // precedence exactly: never override a value already present in
  // process.env (e.g. one the shell/CI already exported). This loop must
  // never log, throw with, or otherwise surface any key or value from
  // `parsed` — see this function's doc comment.
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

/**
 * Resolves a single "env:VAR_NAME"-prefixed string to `process.env.VAR_NAME`
 * — the one place the `env:` reference convention is implemented. Exported
 * so other modules that need to resolve a settings-style value which MAY be
 * an env: reference (e.g. src/lib/auth/browser-session.ts, resolving a
 * storageState path setting) reuse this exact logic instead of
 * re-implementing the prefix convention. A value that doesn't start with
 * `env:` is returned unchanged (a no-op) — callers can pass any string
 * through this unconditionally.
 *
 * `context` is a short human-readable description of what's being resolved
 * (e.g. `source "gofractional" settings.sessionStatePath`), used ONLY to
 * build the thrown error message below — never logged or included anywhere
 * else.
 *
 * Throws a specific error NAMING THE VAR (never any value, resolved or
 * otherwise) if a referenced env var is unset. Never logs or returns the
 * resolved secret anywhere except as the return value itself.
 */
export function resolveEnvString(value: string, context: string): string {
  if (!value.startsWith(ENV_REF_PREFIX)) return value;

  const varName = value.slice(ENV_REF_PREFIX.length);
  const envValue = process.env[varName];
  if (envValue === undefined) {
    throw new Error(
      `gigradar config: ${context} references env var "${varName}", ` +
        `but it is not set. Set it in "${getEnvPath()}" or your shell environment.`,
    );
  }
  return envValue;
}

/**
 * Resolves "env:VAR_NAME" references in a SourceConfig's settings — TOP-
 * LEVEL string values only. A nested settings value (e.g.
 * settings.auth.apiKey = "env:X") is explicitly OUT OF SCOPE for v1 and is
 * left untouched (the literal string, unresolved) rather than silently
 * broken or recursively walked — see design_decisions in this story's YAML
 * for why (SourceConfig.settings is Record<string, unknown> and can hold
 * arbitrary nested shapes; recursing adds real design surface — depth
 * limits, array handling — no current use case demands).
 *
 * Delegates the actual "env:" prefix handling to resolveEnvString() above.
 */
function resolveSourceEnvReferences(source: SourceConfig): SourceConfig {
  if (!source.settings) return source;

  const resolvedSettings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source.settings)) {
    resolvedSettings[key] =
      typeof value === "string" ? resolveEnvString(value, `source "${source.id}" settings.${key}`) : value;
  }

  return { ...source, settings: resolvedSettings };
}
