// stale-pages-and-source-status epic, source-login-status-badge story. A
// cheap, passive check for the /config Sources list badge — deliberately
// NOT the same thing as capture-guidance.ts's checkCaptureReadiness(),
// which needs a live, currently-open Playwright Page and an LLM call, and
// only makes sense mid-Capture-Login. This module answers a narrower
// question with no browser/LLM involved at all: "does source X already have
// a captured session on disk (or in Portunus) that at least PARSES as a
// storageState?" — not whether that session is still valid/unexpired (see
// this story's design-discussion.md §7 open question 1: shipping the simple
// version deliberately, expiry-awareness is a real, flagged fast-follow).
import { SOURCE_ORIGINS } from "../sources/origins.js";
import type { SourceConfig } from "../types.js";
import { readStorageStateFile } from "./browser-session.js";
import { PORTUNUS_SESSION_ACCOUNT, readSessionViaPortunus, sessionBackendFrom } from "./session-backend.js";
import { sessionStatePathFor } from "./session-capture.js";

export type SessionReadiness = "no-login-needed" | "connected" | "needs-login";

/**
 * Same predicate as config-client.tsx's showsCaptureLogin(), re-expressed
 * against the raw (server-side) SourceConfig shape rather than the client's
 * DraftSource/pairs shape — not imported from config-client.tsx directly
 * since that's a "use client" module and this runs in a Server Component.
 */
function needsBrowserSessionAuth(cfg: SourceConfig): boolean {
  if (cfg.id in SOURCE_ORIGINS) return true;
  return cfg.settings?.customAuth === "browser-session";
}

/**
 * Checks whether `cfg` already has a usable captured session, WITHOUT
 * spawning a browser or calling an LLM — safe to call on every /config
 * render for every configured source (same cost class as the existing
 * isPortunusAvailable() check page.tsx already pays once per render).
 *
 * Local backend reuses readStorageStateFile() (decrypt + shape-check,
 * migrate-on-read for legacy plaintext files) rather than a parallel
 * raw-JSON-parse implementation — session files are encrypted at rest, so a
 * decrypt-free read would misreport every legitimately-encrypted session as
 * "needs-login". Any thrown error (missing file, bad decrypt, wrong shape)
 * is treated as "needs-login", never surfaced to the caller.
 *
 * Portunus backend calls readSessionViaPortunus() (a real subprocess spawn,
 * same cost as isPortunusAvailable()'s own check) and treats any rejection
 * (not found, portunus unavailable, wrong shape) as "needs-login".
 *
 * The whole body is wrapped in one top-level try/catch (in addition to the
 * per-backend ones below) so a single malformed source config — e.g.
 * sessionBackendFrom() throwing on an unrecognized settings.sessionBackend
 * value — degrades that one source's badge to "needs-login" rather than
 * crashing the entire /config page's render. This is a passive status
 * check; it must never be the reason the whole page fails to load.
 */
export async function checkSessionReadiness(cfg: SourceConfig): Promise<SessionReadiness> {
  try {
    if (!needsBrowserSessionAuth(cfg)) return "no-login-needed";

    if (sessionBackendFrom(cfg) === "portunus") {
      try {
        await readSessionViaPortunus(cfg.id, PORTUNUS_SESSION_ACCOUNT);
        return "connected";
      } catch {
        return "needs-login";
      }
    }

    try {
      readStorageStateFile(sessionStatePathFor(cfg.id));
      return "connected";
    } catch {
      return "needs-login";
    }
  } catch {
    return "needs-login";
  }
}
