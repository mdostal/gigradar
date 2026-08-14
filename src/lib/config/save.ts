// Writes config.json — the write-side counterpart to load.ts, and the
// epic's single highest-stakes correctness requirement (see
// .pHive/epics/dashboard-config-ui/stories/config-write-path.yaml).
//
// THE NON-NEGOTIABLE MECHANISM, do not deviate: this module NEVER imports,
// calls, or derives its data from anything in load.ts other than the plain
// path helper (getConfigPath() — see below) — in particular, never the
// exported function there that reads config.json AND resolves its "env:"
// references to real secret values (via process.env / .env) so
// `runRadar()` has real credentials to work with, nor the private helper it
// uses internally to do that per-source resolution. That resolved,
// secret-bearing object must NEVER enter this write path, full stop. If it
// did, the very first save() call after that reader had resolved a secret
// would write that plaintext secret straight into config.json — silently,
// with no crash and no visible error, the single worst possible outcome
// for this epic (see the story's `risks` block).
//
// Instead, saveConfig() always re-reads config.json ITSELF, fresh, via a
// private fs.readFileSync + JSON.parse (readRawConfigDocument() below) —
// never anything routed through load.ts's resolving reader. Whatever an
// "env:VAR_NAME" string looks like on disk is exactly what gets merged,
// validated, and written back: a literal string, never resolved.
//
// Full-document replace-on-save: the caller's edits are shallow-merged (at
// the top-level Config keys — profile/needs/sources/roleArea/schedule) onto
// the freshly-read raw document, the MERGED RESULT is validated against
// ConfigSchema (load.ts's schema, reused unmodified), and only a
// successful validation is written back — as the complete document,
// replacing the file's entire prior contents. A validation failure writes
// nothing; whatever was on disk before (if anything) is left untouched.
//
// (This file is deliberately audited by grepping it for the read-side
// reader's and its internal helper's exact names — see the story's review
// step — so this header avoids spelling either name out verbatim; "the
// resolving reader" above and below always means the same thing: load.ts's
// exported env-resolving config reader.)
//
// Encrypted at rest (encrypted-local-storage epic, config-json-encryption
// story): config.json is encrypted via src/lib/security/vault.ts.
// readRawConfigDocument() decrypts-if-needed but deliberately never
// migrate-writes (see its own doc comment below — that distinction from
// load.ts's/readRawConfig()'s migrate-on-read behavior is this story's
// highest-stakes correctness requirement, protecting the
// validation-failure-writes-nothing invariant above). saveConfig()'s own
// write always passes the validated document through encrypt() before it
// ever touches disk — this file never writes plaintext JSON.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type ActionResult, actionErr, actionOk } from "../actions/result.js";
import { decrypt, encrypt, getOrCreateKey, isEncryptedEnvelope, VaultTamperError } from "../security/vault.js";
import type { Config } from "../types.js";
import { getConfigPath, migrateNeedsEngagementProfiles } from "./load.js";
import { ConfigSchema } from "./schema.js";

/**
 * The caller's proposed changes, as a raw (not-yet-validated) partial
 * document — e.g. `{ needs: { ...allNeedsFields } }` to replace just the
 * `needs` section, or a full `{ profile, needs, sources }` object for
 * first-run setup. Merging happens at the TOP LEVEL only: an edit that
 * includes `sources` replaces the entire `sources` array (full-section
 * replace), it does not splice/append into the existing array. Any
 * `"env:VAR_NAME"` string anywhere in here (e.g. a source's
 * `settings.apiKey`) is written back byte-for-byte verbatim — this
 * function never looks at, calls, or needs process.env at all.
 */
export type ConfigEdits = Record<string, unknown>;

/**
 * Local, deliberately-DUPLICATED equivalents of load.ts's
 * hasAnyEncryptedFile() / migrateConfigToEncryptedAtomically() — see
 * this file's header comment's NON-NEGOTIABLE MECHANISM: this module never
 * imports anything from load.ts other than the plain getConfigPath() path
 * helper, full stop, so this file stays independently auditable by grep. A
 * few duplicated lines here is the accepted cost of that guarantee; do NOT
 * "clean this up" by importing load.ts's versions.
 *
 * Deliberately narrower than load.ts's hasAnyEncryptedFile(): this file's
 * version below checks config.json only, never .env — saveConfig() and
 * readRawConfig() only ever read/write config.json, so extending this
 * duplicate to .env would just be dead code.
 */

/** Config.json-only equivalent of load.ts's hasAnyEncryptedFile() — see that function's doc comment for the full rationale. */
function hasAnyEncryptedConfigFile(configPath: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return false;
  }
  return isEncryptedEnvelope(raw);
}

/** Same atomic-write mechanism as load.ts's migrateConfigToEncryptedAtomically() — see that function's doc comment. */
function migrateConfigToEncryptedAtomically(configPath: string, raw: string): void {
  const dir = path.dirname(configPath);
  const tmpPath = path.join(dir, `.${path.basename(configPath)}.tmp-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(tmpPath, encrypt(raw), { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, configPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // tmp file was never created, or is already gone — nothing to clean up.
    }
    throw e;
  }
}

/** The result of a raw, decrypt-if-needed (but never migrate-writing) read of config.json — see readRawConfigDocument() below. */
interface RawConfigRead {
  document: Record<string, unknown>;
  /**
   * True only when config.json existed on disk AND was legacy plaintext
   * (not an encrypted envelope) — the signal readRawConfig() (below) uses
   * to decide whether IT should migrate-write. Always false when the file
   * didn't exist (ENOENT -> `{}`, nothing to migrate) or was already
   * encrypted.
   */
  wasLegacyPlaintext: boolean;
  /**
   * The exact raw bytes read from disk, present only when the file existed.
   * A migrate-write (performed by readRawConfig(), never here) re-encrypts
   * THESE bytes verbatim — never a JSON.stringify() round-trip of the
   * parsed value, which could subtly reformat the content.
   */
  rawBytes: string | null;
}

/**
 * Reads config.json fresh from disk, independent of and never routed
 * through load.ts's resolving reader (or the private helper it uses to
 * resolve each source's settings). ENOENT (no config.json yet) is NOT an
 * error here — it resolves to `{ document: {}, ... }`, the "empty/template"
 * starting shape, specifically so this module works for first-run / initial
 * setup, not just editing an already-valid file (see the story's
 * `design_decisions`: load.ts's resolving reader deliberately throws hard
 * on a missing file; that would make a config UI built on this module
 * unusable for initial setup).
 *
 * Any OTHER read failure (unreadable file, invalid JSON, a root value that
 * isn't a JSON object) throws — these are real, actionable problems, not
 * the "nothing here yet" case ENOENT represents.
 *
 * Decrypts an encrypted envelope transparently (ensuring the vault key
 * exists first via getOrCreateKey() — see vault.ts), but — CRITICALLY,
 * unlike load.ts's loadConfig() — never migrate-writes a legacy plaintext
 * file itself. This function is used internally by saveConfig() as its
 * merge base, immediately followed by saveConfig()'s own validate-then-
 * write; if THIS function independently rewrote a plaintext file encrypted
 * ahead of that validation, a failed validation would silently break the
 * "a validation failure leaves the file completely untouched" invariant
 * (see save.test.ts). Only the standalone, externally-facing readRawConfig()
 * wrapper below (never followed by a write of its own) migrate-writes.
 */
function readRawConfigDocument(configPath: string): RawConfigRead {
  getOrCreateKey(() => hasAnyEncryptedConfigFile(configPath));

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { document: {}, wasLegacyPlaintext: false, rawBytes: null };
    throw new Error(
      `gigradar config: could not read "${configPath}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const wasEncrypted = isEncryptedEnvelope(raw);
  let jsonText: string;
  if (wasEncrypted) {
    try {
      jsonText = decrypt(raw);
    } catch (e) {
      if (e instanceof VaultTamperError) {
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

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`gigradar config: "${configPath}" does not contain a JSON object at its root.`);
  }

  // Same read-time-only shape migration load.ts's loadConfig() applies —
  // see migrateNeedsEngagementProfiles()'s doc comment. Needed here too:
  // this document feeds BOTH the config UI's initial read (readRawConfig())
  // AND saveConfig()'s own currentRaw merge base, and a caller that saves
  // partial edits (omitting `needs` entirely, relying on the merge to keep
  // the existing section) would otherwise re-validate the OLD flat shape
  // and fail.
  const migrated = migrateNeedsEngagementProfiles(parsed) as Record<string, unknown>;

  return { document: migrated, wasLegacyPlaintext: !wasEncrypted, rawBytes: raw };
}

/**
 * Public wrapper around readRawConfigDocument(), for callers OUTSIDE this
 * module that need the raw, unresolved, not-yet-validated document — namely
 * the config-editing UI (src/app/config/page.tsx), to pre-populate its form.
 * Exists so that page has a legitimate way to read config.json without ever
 * importing load.ts's resolving reader (see this file's header comment):
 * this is the exact same ENOENT-tolerant, non-resolving read saveConfig()
 * itself uses, just exposed for a read-only caller. Any "env:VAR_NAME"
 * string comes back exactly as written — this function never touches
 * process.env.
 *
 * Its post-encryption meaning is unchanged, just reinterpreted: "raw"
 * already meant "not env-resolved" — it now also means "decrypted (if the
 * file was encrypted) but still not env-resolved," never the literal
 * envelope bytes. UNLIKE readRawConfigDocument()'s internal use inside
 * saveConfig(), this IS a standalone, externally-facing read entry point —
 * same as loadConfig() — so it DOES auto-migrate a legacy plaintext file to
 * an encrypted envelope on read.
 */
export function readRawConfig(): Record<string, unknown> {
  const configPath = getConfigPath();
  const { document, wasLegacyPlaintext, rawBytes } = readRawConfigDocument(configPath);
  if (wasLegacyPlaintext && rawBytes !== null) {
    migrateConfigToEncryptedAtomically(configPath, rawBytes);
  }
  return document;
}

/** Formats zod issues the same way load.ts's own reader does, for one consistent error shape across read and write. */
function formatValidationError(configPath: string, error: import("zod").ZodError): string {
  const details = error.issues
    .map((issue) => `  - ${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("\n");
  return `gigradar config: edited document for "${configPath}" failed validation:\n${details}`;
}

/**
 * Validates and writes `edits` (shallow-merged onto the current raw
 * document) to config.json, at the path getConfigPath() resolves (the same
 * one load.ts's resolving reader reads — never a different path).
 *
 * On success: the file is fully overwritten with the validated document
 * (mode 0600, explicitly — see chmodSync below), and the returned
 * `ActionResult` carries the validated `Config`.
 *
 * On a ConfigSchema validation failure: returns `{ ok: false, error }` with
 * a specific, field-level message (mirroring load.ts's own error format)
 * — and writes NOTHING to disk. Whatever existed at config.json before
 * this call (if anything) is left completely untouched.
 *
 * Never imports, calls, or derives from load.ts's resolving reader or the
 * private per-source helper it uses internally — see this file's header
 * comment. Never resolves, logs, or otherwise touches an "env:"-prefixed
 * string's real value; such strings are opaque data to this function.
 */
export function saveConfig(edits: ConfigEdits): ActionResult<Config> {
  if (typeof edits !== "object" || edits === null || Array.isArray(edits)) {
    return actionErr(new Error("gigradar config: edits must be a JSON object."));
  }

  const configPath = getConfigPath();

  let currentRaw: Record<string, unknown>;
  try {
    // .document only — readRawConfigDocument() never migrate-writes (see
    // its doc comment); saveConfig()'s own write below re-encrypts the
    // whole document regardless, so there is nothing this call needs the
    // wasLegacyPlaintext/rawBytes fields for.
    currentRaw = readRawConfigDocument(configPath).document;
  } catch (e) {
    return actionErr(e);
  }

  // Top-level shallow merge only — a section present in `edits` (e.g.
  // `sources`) fully replaces that section of the current document rather
  // than being deep-merged into it. Any "env:" string inside `edits` rides
  // along completely unexamined, exactly like every other string value.
  const merged: unknown = { ...currentRaw, ...edits };

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    return actionErr(new Error(formatValidationError(configPath, result.error)));
  }

  const validated = result.data;

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // `mode` on writeFileSync is subject to the process umask (so an 0o600
    // request can land as something looser on a permissive umask) —
    // chmodSync afterward pins the exact bits, same belt-and-suspenders
    // approach this repo's own tests use (see
    // src/lib/config/__tests__/load.test.ts's writeConfig() helper).
    // The validated document is passed through encrypt() before ever
    // touching disk — saveConfig() always writes an encrypted envelope,
    // never plaintext (readRawConfigDocument() above already ensured the
    // vault key exists).
    fs.writeFileSync(configPath, encrypt(`${JSON.stringify(validated, null, 2)}\n`), { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
  } catch (e) {
    return actionErr(
      new Error(`gigradar config: could not write "${configPath}": ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  return actionOk(validated);
}
