// career-documents epic, resume-store story. Persistent, encrypted-at-rest
// resume storage -- the missing piece ats-navigator's ats-resume-score
// story deliberately deferred (no persisted resume data existed anywhere
// in this codebase; see that epic's design-discussion.md open question 4).
//
// Mirrors session-capture.ts's writeStorageStateAtomically()/
// browser-session.ts's readStorageStateFile() BYTE-FOR-BYTE: atomic
// temp-file+rename (never a direct write to destPath), mode 0600,
// encrypt()-at-rest via vault.ts's SAME shared key every other encrypted
// file (config.json, session-state files) already uses, via
// getOrCreateKey(hasAnyEncryptedFile) from config/load.js -- reused, not
// reimplemented. Unlike session files, there is no legacy-plaintext format
// to migrate from (this is a brand new file type), so the read path skips
// browser-session.ts's isEncryptedEnvelope()/migrate-on-read branch and
// always expects an encrypted envelope.
//
// ONE resume, not versioned (design-discussion.md §3 open question 1,
// deliberately deferred) -- a fixed filename, not derived from user input.
//
// On-disk shape: encrypt(JSON.stringify({mediaType, dataBase64})). A PDF's
// raw bytes are base64-wrapped into that JSON string before encrypt() --
// vault.ts's encrypt()/decrypt() are string-in/string-out, not raw-byte
// oriented, same as every other consumer of this mechanism.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hasAnyEncryptedFile } from "../config/load.js";
import { decrypt, encrypt, getOrCreateKey, VaultTamperError } from "../security/vault.js";
import { getDefaultDataDir } from "../store/path.js";

const MODULE_PREFIX = "gigradar resume-store";
const RESUME_FILE_NAME = "resume.enc";

export interface ResumeFile {
  data: Buffer;
  mediaType: string;
}

/** Full path to the single persisted resume file (does not imply it exists yet). */
export function getResumePath(): string {
  return path.join(getDefaultDataDir(), RESUME_FILE_NAME);
}

/**
 * Persists `data` (raw resume bytes) encrypted at rest, atomically
 * (temp-file+rename, mode 0600) -- same discipline
 * writeStorageStateAtomically() uses for session files. Always writes to
 * the SAME fixed path (getResumePath()) — a second call overwrites the
 * first; there is no versioning in v1.
 */
export function saveResume(data: Buffer, mediaType: string): { path: string } {
  const destPath = getResumePath();
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });

  getOrCreateKey(hasAnyEncryptedFile);

  const serialized = JSON.stringify({ mediaType, dataBase64: data.toString("base64") });
  const tmpPath = path.join(dir, `.${path.basename(destPath)}.tmp-${crypto.randomUUID()}`);

  try {
    fs.writeFileSync(tmpPath, encrypt(serialized), { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, destPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // tmp file was never created, or is already gone -- nothing to clean up.
    }
    throw e;
  }

  return { path: destPath };
}

/**
 * Reads + decrypts the resume at `filePath`. Returns `undefined` (never
 * throws) when the file simply doesn't exist -- a missing/never-uploaded
 * resume is a normal, expected state, not an error, mirroring
 * cancelCapture()'s own "already gone is fine" precedent. Re-throws
 * vault.ts's VaultTamperError (with an actionable, resume-specific
 * message spliced in) if the file's content has been corrupted/tampered
 * with, same as readStorageStateFile() does for session files.
 */
export function loadResume(filePath: string): ResumeFile | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${MODULE_PREFIX}: could not read resume file at "${filePath}": ${e instanceof Error ? e.message : String(e)}`);
  }

  getOrCreateKey(hasAnyEncryptedFile);

  let jsonText: string;
  try {
    jsonText = decrypt(raw);
  } catch (e) {
    if (e instanceof VaultTamperError) {
      e.message = `${MODULE_PREFIX}: resume file at "${filePath}" ${e.message}`;
      throw e;
    }
    throw e;
  }

  const parsed = JSON.parse(jsonText) as { mediaType: string; dataBase64: string };
  return { data: Buffer.from(parsed.dataBase64, "base64"), mediaType: parsed.mediaType };
}

/** Removes the resume file at `filePath`. Idempotent -- calling it when the file is already gone is a silent no-op, never throws. */
export function deleteResume(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}
