// career-documents epic, resume-store story -- redesigned as
// keyed/versioned storage by the resume-store-multi-resume-and-tailoring
// story (usability-and-completeness-audit epic). Persistent,
// encrypted-at-rest resume storage; the missing piece ats-navigator's
// ats-resume-score story deliberately deferred (no persisted resume data
// existed anywhere in this codebase; see that epic's design-discussion.md
// open question 4).
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
// KEYED/VERSIONED (resume-store-multi-resume-and-tailoring story): each
// resume gets its own generated `resumeId` and its own encrypted file
// under `<data dir>/resumes/<resumeId>.enc`, rather than v1's single fixed
// `resume.enc` at the data-dir root -- so multiple stored resumes are each
// independently retrievable, never overwriting each other. `getResumePath()`
// (the OLD fixed single-resume path) is kept, unmodified, purely so
// `config/load.ts`'s `migrateApplyProfileResumes()` can recognize and wrap
// a pre-existing single-resume install's file into the new list on read --
// nothing NEW ever writes to that path again.
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
import type { ResumeRecord } from "../types.js";

const MODULE_PREFIX = "gigradar resume-store";
/** v1's single fixed resume filename -- kept ONLY for migrateApplyProfileResumes() to recognize a pre-existing install (see this file's header comment). Never written to by any function below. */
const LEGACY_RESUME_FILE_NAME = "resume.enc";
/** Directory each keyed resume's own encrypted file lives under, alongside config.json/gigs.db. */
const RESUMES_DIR_NAME = "resumes";

export interface ResumeFile {
  data: Buffer;
  mediaType: string;
}

/** Full path to v1's single fixed resume file (does not imply it exists) -- LEGACY, see this file's header comment. Only ever consulted by the migration path; new resumes never write here. */
export function getResumePath(): string {
  return path.join(getDefaultDataDir(), LEGACY_RESUME_FILE_NAME);
}

/** The directory each keyed resume's own encrypted file lives under (does not imply it exists yet). */
export function getResumeDir(): string {
  return path.join(getDefaultDataDir(), RESUMES_DIR_NAME);
}

/** A fresh, stable, URL/filename-safe resume id -- generated once per resume, never re-derived from its label (which the user can freely rename). */
export function newResumeId(): string {
  return crypto.randomUUID();
}

/** Full path to a specific resume's own encrypted file (does not imply it exists yet). */
export function getResumeFilePath(resumeId: string): string {
  return path.join(getResumeDir(), `${resumeId}.enc`);
}

/**
 * Persists `data` (raw resume bytes) encrypted at rest, atomically
 * (temp-file+rename, mode 0600) -- same discipline
 * writeStorageStateAtomically() uses for session files, and this module's
 * own v1 saveResume() already used. Each `resumeId` gets its OWN file
 * (`getResumeFilePath()`) -- unlike v1, saving a SECOND resume never
 * touches the first one's file; two calls with the SAME `resumeId` still
 * overwrite (a deliberate re-upload/replace of that one resume), matching
 * v1's own overwrite-on-same-path semantics scoped down to one resume
 * instead of the whole store.
 *
 * `resumeId` defaults to a freshly generated one so every pre-existing
 * caller/test that only ever passed `(data, mediaType)` keeps working
 * unchanged -- it just now lands in `resumes/<generated-id>.enc` instead
 * of the old fixed `resume.enc` path.
 */
export function saveResume(data: Buffer, mediaType: string, resumeId: string = newResumeId()): { id: string; path: string } {
  const destPath = getResumeFilePath(resumeId);
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

  return { id: resumeId, path: destPath };
}

/**
 * Reads + decrypts the resume at `filePath`. Returns `undefined` (never
 * throws) when the file simply doesn't exist -- a missing/never-uploaded
 * resume is a normal, expected state, not an error, mirroring
 * cancelCapture()'s own "already gone is fine" precedent. Re-throws
 * vault.ts's VaultTamperError (with an actionable, resume-specific
 * message spliced in) if the file's content has been corrupted/tampered
 * with, same as readStorageStateFile() does for session files.
 *
 * Unchanged by the keyed/versioned redesign -- still a plain path-in,
 * file-out loader, so every existing call site keeps working: a caller
 * resolves WHICH resume it wants (via `pickResume()` below, or directly
 * against a `ResumeRecord.path`) and hands this function that one path.
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

/**
 * Resolves WHICH stored resume a caller should use: the one matching
 * `resumeId` if given and found, else the FIRST entry in `resumes` --
 * preserving today's implicit "the one resume" behavior byte-for-byte for
 * an install that has (or has only ever had) a single resume. Returns
 * `undefined` when `resumes` is empty/unset, or when a `resumeId` was
 * given but doesn't match any stored record (never throws, never silently
 * substitutes a DIFFERENT resume than the one explicitly asked for --
 * callers treat that the same as "no resume on file", exactly like a
 * deleted-but-still-referenced file already degrades gracefully via
 * `loadResume()`'s own ENOENT handling).
 */
export function pickResume(resumes: ResumeRecord[] | undefined, resumeId?: string): ResumeRecord | undefined {
  if (!resumes || resumes.length === 0) return undefined;
  if (resumeId === undefined) return resumes[0];
  return resumes.find((r) => r.id === resumeId);
}
