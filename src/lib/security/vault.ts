// The encryption-at-rest primitives every consumer story in the
// encrypted-local-storage epic (config-json-encryption, env-encryption,
// session-file-encryption) builds on. See
// .pHive/epics/encrypted-local-storage/docs/design-discussion.md §3 step 1.
//
// Deliberately a GENERIC module: it knows nothing about config.json, .env,
// or session files by name — only the calling code knows where those live,
// which is why getOrCreateKey() takes an injected `hasAnyEncryptedFileFn`
// rather than scanning specific paths itself.
//
// Deliberately STATELESS across calls (no module-level key cache), same
// convention as src/lib/store/path.ts's getDefaultDataDir(): every function
// here re-derives its answer fresh from disk/env each call. This matters
// for correctness, not just style — a cached key would go stale the moment
// a test (or a real key-rotation-by-hand) changes what's on disk under a
// different XDG_CONFIG_HOME, and getOrCreateKey()'s own "same key file in,
// same bytes out" guarantee is easiest to reason about when there is no
// hidden in-memory state to go stale.
//
// Contract: encrypt()/decrypt() require the key to already exist on disk —
// they never create one. Only getOrCreateKey() may mint a new key, and only
// after the caller-supplied hasAnyEncryptedFileFn() has confirmed doing so
// is actually safe (a true first run, not a lost key with orphaned
// encrypted data sitting on disk). This is the epic's H1 mitigation: it
// must be structurally impossible for a plain encrypt()/decrypt() call to
// silently mint an orphan key.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDefaultDataDir } from "../store/path.js";
import { getKeyConfigDir, getKeyPath } from "./key-path.js";

const KEY_LENGTH_BYTES = 32; // AES-256
const IV_LENGTH_BYTES = 12; // GCM's recommended/standard IV length
const ENVELOPE_VERSION = 1;

// Module-scoped (NOT the "no key cache" state the header comment rules
// out — no key material lives here, just a flag) so the collision warning
// below fires once per process, not on every getOrCreateKey() call. See
// .pHive/epics/security-hardening/docs/design-discussion.md §3 step 2 /
// grill finding H2: this is a non-blocking, best-effort notice, so a
// simple in-memory flag (reset on process restart or, in tests, via
// vi.resetModules()) is all it needs to be.
let hasWarnedAboutKeyDataCollision = false;

/**
 * Warns (once per process, never throws) if the resolved key directory
 * ({@link getKeyConfigDir}) and the resolved data directory
 * (`getDefaultDataDir()`) are identical — for ANY reason, not just the
 * Windows-fallback bug this story fixes. Covers the residual case where a
 * user explicitly sets `XDG_CONFIG_HOME` and `XDG_DATA_HOME` to the same
 * value themselves: that's their own configuration choice, not a code bug,
 * so it's a warning rather than a hard failure — see design-discussion.md
 * §3 step 2 (grill finding H2).
 */
function warnIfKeyAndDataDirsCollide(): void {
  if (hasWarnedAboutKeyDataCollision) return;

  const keyDir = getKeyConfigDir();
  const dataDir = getDefaultDataDir();
  if (keyDir !== dataDir) return;

  hasWarnedAboutKeyDataCollision = true;
  console.warn(
    `gigradar: the vault key directory and data directory are the same ("${keyDir}"). ` +
      "The encryption key should live in a directory separate from the data it protects. " +
      "If you set XDG_CONFIG_HOME and XDG_DATA_HOME yourself, point them at different " +
      "locations; this is a non-blocking warning, not an error.",
  );
}

/** The on-disk/on-wire shape produced by encrypt() and consumed by decrypt(). */
interface VaultEnvelope {
  v: number;
  iv: string;
  tag: string;
  data: string;
}

const VAULT_ENVELOPE_KEYS = ["v", "iv", "tag", "data"] as const;

/**
 * Thrown by getOrCreateKey() when the key file is missing but
 * `hasAnyEncryptedFileFn()` reports that encrypted data already exists on
 * disk: the key is gone, so that data is now permanently unreadable. A
 * distinct type (never conflated with a generic Error) so callers — and
 * humans reading a stack trace — can tell "key genuinely lost" apart from
 * any other failure at a glance.
 */
export class VaultKeyLostError extends Error {
  constructor(keyPath: string) {
    super(
      `Vault key not found at ${keyPath}, but encrypted data already exists on disk. ` +
        "That data is now permanently unreadable without the original key file — this " +
        "tool will NOT silently generate a new key, since that would orphan it forever. " +
        "To recover: re-run config setup to re-enter your credentials (this rewrites " +
        "config.json/.env encrypted under a fresh key), and re-capture any browser " +
        "sessions via the session capture UI (this rewrites each session file encrypted " +
        "under the same fresh key). There is no way to recover the original plaintext " +
        "without the missing key.",
    );
    this.name = "VaultKeyLostError";
  }
}

/**
 * Thrown by decrypt() specifically when AES-256-GCM's auth-tag
 * verification fails — i.e. the ciphertext or tag has been altered since
 * encryption. Deliberately a distinct type/message from a generic
 * JSON-parse or envelope-shape failure (see decrypt()'s two `try` blocks
 * below): a tampered file is a meaningfully louder, different failure mode
 * than "this isn't an encrypted envelope at all."
 */
export class VaultTamperError extends Error {
  constructor() {
    super(
      "Encrypted file is corrupted or has been tampered with: the authentication tag " +
        "did not verify. This is NOT a missing-file or format error — the ciphertext or " +
        "tag bytes have changed since encryption.",
    );
    this.name = "VaultTamperError";
  }
}

function isVaultEnvelopeShape(value: unknown): value is VaultEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== VAULT_ENVELOPE_KEYS.length) return false;
  if (!VAULT_ENVELOPE_KEYS.every((k) => k in obj)) return false;
  return (
    typeof obj.v === "number" &&
    typeof obj.iv === "string" &&
    typeof obj.tag === "string" &&
    typeof obj.data === "string"
  );
}

/**
 * True only for content that is valid JSON matching the exact
 * `{v, iv, tag, data}` shape (all four required, `v` a number, the other
 * three strings, no extra keys). Anything else — any other valid JSON
 * (e.g. a plaintext config.json or storageState document) or non-JSON
 * text — is false: legacy plaintext, safe to treat as such.
 */
export function isEncryptedEnvelope(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return isVaultEnvelopeShape(parsed);
}

/**
 * Writes `key` to `keyPath` ATOMICALLY (temp file in the same directory,
 * then `fs.renameSync`) with mode 0600, mirroring
 * src/lib/auth/session-capture.ts's writeStorageStateAtomically() and
 * src/lib/config/save.ts's write discipline: `writeFileSync`'s `mode` is
 * subject to the process umask, so `chmodSync` afterward pins the exact
 * bits. On any failure the temp file is removed before re-throwing — never
 * a partial/empty key file left at `keyPath`.
 */
function writeKeyAtomically(keyPath: string, key: Buffer): void {
  const dir = path.dirname(keyPath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(dir, `.${path.basename(keyPath)}.tmp-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(tmpPath, key, { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, keyPath);
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
 * Resolves the vault's 32-byte AES-256 key.
 *
 * - If the key file already exists, reads and returns its bytes (same
 *   bytes every call — the file's content never changes once written).
 * - If it doesn't: calls the caller-injected `hasAnyEncryptedFileFn()`
 *   (only the caller knows where config.json/.env/session files live).
 *   - Returns true (encrypted data exists, key is lost) → throws
 *     {@link VaultKeyLostError}. Never silently mints a replacement key.
 *   - Returns false (true first run) → generates `crypto.randomBytes(32)`,
 *     writes it atomically with mode 0600 to {@link getKeyPath}, and
 *     returns it.
 *
 * Never logs the key, and never includes key bytes in any error message.
 *
 * Also checks (every call, but warns at most once per process) whether the
 * resolved key directory and data directory are identical — see
 * {@link warnIfKeyAndDataDirsCollide}. Purely a non-blocking `console.warn`;
 * never affects this function's return value or throws on its own.
 */
export function getOrCreateKey(hasAnyEncryptedFileFn: () => boolean): Buffer {
  warnIfKeyAndDataDirsCollide();

  const keyPath = getKeyPath();

  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath);
  }

  if (hasAnyEncryptedFileFn()) {
    throw new VaultKeyLostError(keyPath);
  }

  const key = crypto.randomBytes(KEY_LENGTH_BYTES);
  writeKeyAtomically(keyPath, key);
  return key;
}

/**
 * Reads the vault key directly off disk for use by encrypt()/decrypt().
 * Deliberately does NOT create a key — encrypt()/decrypt() must never be
 * able to mint an orphan key the way a careless getOrCreateKey() call
 * could; only getOrCreateKey() (with its caller-supplied safety check) is
 * allowed to do that. Callers are expected to have already called
 * getOrCreateKey() at least once (e.g. at the top of their read/write
 * entry point) before ever calling encrypt()/decrypt().
 */
function readExistingKey(): Buffer {
  const keyPath = getKeyPath();
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Vault key not found at ${keyPath}. Call getOrCreateKey() first to create or load ` +
        "the encryption key before calling encrypt() or decrypt().",
    );
  }
  return fs.readFileSync(keyPath);
}

/**
 * Encrypts `plaintext` with AES-256-GCM under the vault key: a fresh random
 * 12-byte IV per call (`crypto.randomBytes(12)` — GCM's IV must never
 * repeat under the same key), `createCipheriv`, and returns a JSON
 * envelope string `{v:1, iv: base64, tag: base64, data: base64}`.
 */
export function encrypt(plaintext: string): string {
  const key = readExistingKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: VaultEnvelope = {
    v: ENVELOPE_VERSION,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64"),
  };
  return JSON.stringify(envelope);
}

/**
 * Reverses encrypt(). Throws {@link VaultTamperError} — distinctly,
 * specifically — when the GCM auth tag fails to verify (corrupted or
 * tampered ciphertext/tag). A generic JSON-parse failure or an
 * envelope that doesn't match the expected shape throws a plain `Error`
 * instead: a different, less alarming failure mode ("this isn't an
 * encrypted envelope"), never conflated with tamper detection.
 */
export function decrypt(envelopeJson: string): string {
  const key = readExistingKey();

  let parsed: unknown;
  try {
    parsed = JSON.parse(envelopeJson);
  } catch {
    throw new Error("Cannot decrypt: input is not valid JSON.");
  }
  if (!isVaultEnvelopeShape(parsed)) {
    throw new Error("Cannot decrypt: input does not match the expected {v, iv, tag, data} envelope shape.");
  }

  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const ciphertext = Buffer.from(parsed.data, "base64");

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // createDecipheriv/update/final all throw the same way on auth-tag
    // mismatch (and on a malformed IV length) — either way, this is the
    // "ciphertext isn't trustworthy" case the tamper error exists for.
    throw new VaultTamperError();
  }
}
