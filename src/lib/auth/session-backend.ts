// oauth-session-capture-v2 epic, portunus-session-backend story. Portunus
// as an OWNER-SELECTABLE alternative to the local AES-256-GCM vault
// (src/lib/security/vault.ts) for storing captured browser sessions —
// never a forced migration, and gracefully absent (not broken) for OSS
// users without Portunus installed. See CLAUDE.md's core/user-layer
// boundary: this module never assumes Portunus exists.
//
// LIVE-CONFIRMED CLI SHAPE (portunus 0.19.0, 2026-08-15) — do not assume,
// re-check `portunus session store/load --help` against a newer install if
// this ever looks wrong:
//   `portunus session store <site> <account> --ttl-seconds <n> --stdin`
//     reads the JSON value from stdin (never inline/argv), prints a
//     one-line human confirmation to stdout, exits 0 on success.
//   `portunus session load <site> <account>`
//     writes a 0600 tempfile and prints ONLY its path to stdout. The
//     tempfile's content is NOT the raw stored value — it's an envelope:
//     `{ schema: "portunus.session.v1", namespace: {...}, ttl: {...},
//     rotation: {...}, session: <the value passed to store> }`. Exits 1
//     (stderr `portunus: unknown secret: session:<site>:<account>`) if
//     nothing is stored for that site/account.
//
// STDIN/TEMPFILE ONLY, NEVER ARGV. The session JSON never appears as a
// command-line argument (visible in `ps`/shell history) in either
// direction: writeSessionViaPortunus() pipes it via stdin,
// readSessionViaPortunus() reads Portunus's own 0600 tempfile and deletes
// it immediately after — Portunus hands back a path (not the value)
// specifically so the caller controls the tempfile's lifetime; leaving it
// on disk after use would reintroduce the exposure Portunus's own design
// avoids.
//
// NEVER A SILENT FALLBACK. A Portunus write/read failure is a real,
// surfaced error — this module never falls back to the local vault on
// failure. Callers that want "try Portunus, fall back to local" must
// implement that explicitly; this module doesn't hide the distinction.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { isStorageStateShape, type StorageState } from "./browser-session.js";
import type { SourceConfig } from "../types.js";

const MODULE_PREFIX = "gigradar session-backend";

/** The fixed Portunus "account" every gigradar-captured session is stored under — this app has no multi-account concept, so `site` (== sourceId) alone identifies a session. MUST stay identical between writeSessionViaPortunus() and readSessionViaPortunus() callers — a mismatch here would silently make a captured session unreadable. */
export const PORTUNUS_SESSION_ACCOUNT = "gigradar";

/** How long Portunus retains a captured session before treating it as expired — independent of the target site's own cookie expiry. Re-captured (overwritten) on every new Capture Login run, same as the local vault's overwrite-on-recapture behavior. */
export const PORTUNUS_SESSION_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

export type SessionBackend = "local" | "portunus";

let cachedAvailability: Promise<boolean> | undefined;

/**
 * A real, live `portunus --version` child-process check — never assumed.
 * Cached per-process (subsequent calls reuse the first check's result)
 * since this may be called on every `/config` render; a process restart
 * (or a fresh Next.js dev HMR re-evaluation of this module) re-checks.
 */
export function isPortunusAvailable(): Promise<boolean> {
  if (!cachedAvailability) {
    cachedAvailability = new Promise<boolean>((resolve) => {
      const child = spawn("portunus", ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false)); // e.g. ENOENT -- not installed
      child.on("exit", (code) => resolve(code === 0));
    });
  }
  return cachedAvailability;
}

/** Resolves `cfg.settings.sessionBackend` — `"local"` (the default, when absent) or `"portunus"`. Throws for any other value rather than silently treating an unrecognized setting as "local". */
export function sessionBackendFrom(cfg: SourceConfig): SessionBackend {
  const value = cfg.settings?.sessionBackend;
  if (value === undefined) return "local";
  if (value === "local" || value === "portunus") return value;
  throw new Error(
    `${MODULE_PREFIX}: source "${cfg.id}" has an unrecognized settings.sessionBackend value ${JSON.stringify(value)} (expected "local" or "portunus").`,
  );
}

/**
 * Shells out to `portunus session store <site> <account> --ttl-seconds <n>
 * --stdin`, piping the ALREADY origin-scoped-filtered storageState JSON via
 * stdin — never a temp file, never a command-line argument. Throws a
 * specific error including Portunus's own stderr on any non-zero exit or
 * spawn failure.
 */
export async function writeSessionViaPortunus(
  site: string,
  account: string,
  storageState: StorageState,
  ttlSeconds: number,
): Promise<void> {
  const payload = JSON.stringify(storageState);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "portunus",
      ["session", "store", site, account, "--ttl-seconds", String(ttlSeconds), "--stdin"],
      { stdio: ["pipe", "ignore", "pipe"] },
    );

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      reject(new Error(`${MODULE_PREFIX}: failed to spawn portunus for "${site}"/"${account}": ${e.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${MODULE_PREFIX}: portunus session store for "${site}"/"${account}" failed (exit ${code}): ${stderr.trim() || "no error output"}`,
          ),
        );
      }
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

/**
 * Shells out to `portunus session load <site> <account>`, reads the 0600
 * tempfile path it prints on success, parses the envelope Portunus wraps
 * the stored value in, validates the `.session` field against the same
 * storageState shape check browser-session.ts's readStorageStateFile()
 * uses (reused, not duplicated — see isStorageStateShape()'s export), and
 * DELETES the tempfile immediately after reading regardless of outcome.
 *
 * Throws a specific error naming `site`/`account` on: a spawn failure, a
 * non-zero exit (e.g. nothing stored for that site/account — Portunus's
 * own "unknown secret" error is included verbatim), an unexpected envelope
 * shape, or a `.session` payload that doesn't match the expected
 * storageState shape.
 */
export async function readSessionViaPortunus(site: string, account: string): Promise<StorageState> {
  const tempFilePath = await new Promise<string>((resolve, reject) => {
    const child = spawn("portunus", ["session", "load", site, account], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      reject(new Error(`${MODULE_PREFIX}: failed to spawn portunus for "${site}"/"${account}": ${e.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(
            `${MODULE_PREFIX}: portunus session load for "${site}"/"${account}" failed (exit ${code}): ${stderr.trim() || "no error output"}`,
          ),
        );
      }
    });
  });

  try {
    const raw = fs.readFileSync(tempFilePath, "utf8");

    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new Error(`${MODULE_PREFIX}: portunus session load for "${site}"/"${account}" returned a tempfile that is not valid JSON.`);
    }

    if (
      typeof envelope !== "object" ||
      envelope === null ||
      (envelope as Record<string, unknown>).schema !== "portunus.session.v1" ||
      typeof (envelope as Record<string, unknown>).session !== "object" ||
      (envelope as Record<string, unknown>).session === null
    ) {
      throw new Error(
        `${MODULE_PREFIX}: portunus session load for "${site}"/"${account}" returned an unexpected envelope shape (expected schema "portunus.session.v1").`,
      );
    }

    const session = (envelope as Record<string, unknown>).session;
    if (!isStorageStateShape(session)) {
      throw new Error(
        `${MODULE_PREFIX}: portunus session load for "${site}"/"${account}" returned a payload that does not match the expected storageState shape.`,
      );
    }

    return session;
  } finally {
    try {
      fs.unlinkSync(tempFilePath);
    } catch {
      // already gone -- nothing more to clean up.
    }
  }
}
