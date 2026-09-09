// session-keepalive-refresh story (real-app-diagnosability epic follow-up).
// Owner's own real, repeated complaint (2026-09-09): "the sessions need to
// be maintained and refreshed -- that's simple, they come with tokens and
// liveliness and refresh, so just fucking do the work." Real, already-
// documented root cause (ateam.ts's own header comment, 2026-08-30,
// ateam-session-lifetime-blocker story, never fixed until now): "the
// session's own lifetime after capture appears short -- a fresh capture
// scraped real listings successfully, but a SEPARATE process reconnecting
// to the saved session file some minutes later failed isAuthenticatedATeam()
// -- consistent with a short-TTL token needing an active refresh this bare
// cookie-replay never exercises." A normal scan (or Capture Login) opens
// the browser, does its real work in a few seconds, and closes -- if a
// site's own client-side JS silently refreshes its session token on a
// background timer while the tab stays open, a scan that fast never gives
// that timer a chance to fire even once.
//
// THE FIX: periodically (more often than the real 30-min scan cycle) open
// each browser-session-auth source's REAL session, navigate to its real
// authenticated URL, and DWELL there for a real, meaningful duration
// (`dwellMs`) before closing -- giving any such background refresh timer a
// genuine chance to run. Reuses browser-session.ts's own
// withBrowserSession() (same three-tier self-healing acquisition every
// other browser-session-auth consumer already gets, headless for
// `attended: false`) rather than a second, parallel session-acquisition
// mechanism. On success, ALWAYS re-extracts and re-saves the (possibly
// now-refreshed) storageState -- regardless of which tier actually
// answered -- so a keepalive that merely confirmed tier 1 still works
// still captures whatever the dwell may have refreshed, not just the
// self-heal-only write-back withBrowserSession() itself does for tier 3.
//
// Best-effort, honestly: this is real engineering against an OBSERVED
// symptom, not a guarantee about any specific site's actual session
// architecture (a fixed, non-renewable absolute expiry -- which no amount
// of activity can extend -- remains possible and is not disprovable
// without directly observing that site's own server-side session logic).
// A keepalive failure is treated exactly like a normal scan's own
// session failure -- logged, not silently swallowed -- so this is honestly
// diagnosable either way, matching this epic's own standing discipline.
import type { Page } from "playwright";
import type { SourceConfig } from "../types.js";
import { withBrowserSession, filterStorageStateToAllowlist, type StorageState } from "./browser-session.js";
import { sessionBackendFrom } from "./session-backend.js";
import { writeStorageStateAtomically } from "./session-capture.js";
import { SOURCE_ORIGINS } from "../sources/origins.js";
import { isAuthenticatedGoFractional } from "../sources/gofractional.js";
import { isAuthenticatedATeam } from "../sources/ateam.js";
import { isAuthenticatedWellfound } from "../sources/wellfound.js";

const MODULE_PREFIX = "gigradar session-keepalive";

/**
 * How long to sit on the real, authenticated page before closing again.
 * Deliberately generous (this runs headlessly, unattended, on its own
 * timer -- there is no human waiting on it) -- long enough to give a
 * plausible background refresh timer a real chance, short enough that a
 * handful of these running back-to-back across sources stays a
 * reasonable, bounded background cost.
 */
export const DEFAULT_KEEPALIVE_DWELL_MS = 20_000;

export interface KeepAliveTarget {
  sourceId: string;
  /** The same real, authenticated URL that source's own fetch() already uses -- reusing a URL/auth-check pairing already proven live, never a new, unverified one. */
  url: string;
  isAuthenticated: (page: Page) => Promise<boolean>;
}

/**
 * The three real `browser-session`-auth sources this codebase has today
 * (origins.ts's own KNOWN_SOURCES) -- a new browser-session source added
 * later needs one new entry here, mirroring sync-status-registry.ts's own
 * "one entry per real adapter" convention.
 */
export const KEEPALIVE_TARGETS: readonly KeepAliveTarget[] = [
  { sourceId: "gofractional", url: "https://www.gofractional.com/jobs", isAuthenticated: isAuthenticatedGoFractional },
  { sourceId: "ateam", url: "https://platform.a.team/mission-control/all", isAuthenticated: isAuthenticatedATeam },
  { sourceId: "wellfound", url: "https://wellfound.com/jobs", isAuthenticated: isAuthenticatedWellfound },
];

/**
 * Runs one keepalive visit for `target` against `cfg`'s configured
 * session. Throws exactly the same real errors withBrowserSession() itself
 * would (session invalid, verification challenge, etc.) -- a caller
 * iterating multiple targets should catch per-target, matching
 * runner.ts's own per-source try/catch convention, never letting one
 * source's failure abort the others.
 */
export async function keepAliveSession(target: KeepAliveTarget, cfg: SourceConfig, dwellMs: number = DEFAULT_KEEPALIVE_DWELL_MS): Promise<void> {
  const allowedOrigins = SOURCE_ORIGINS[target.sourceId];
  if (!allowedOrigins || allowedOrigins.length === 0) {
    throw new Error(`${MODULE_PREFIX}: no origin allowlist registered for source "${target.sourceId}" (see src/lib/sources/origins.ts).`);
  }

  const sessionBackend = sessionBackendFrom(cfg);
  const sessionStatePath = cfg.settings?.sessionStatePath;
  if (sessionBackend === "local" && (typeof sessionStatePath !== "string" || sessionStatePath.length === 0)) {
    throw new Error(`${MODULE_PREFIX}: source "${target.sourceId}" is using the local session backend but has no settings.sessionStatePath configured.`);
  }

  await withBrowserSession(
    {
      sourceId: target.sourceId,
      storageStatePathSetting: sessionBackend === "local" ? (sessionStatePath as string) : undefined,
      sessionBackend,
      allowedOrigins: [...allowedOrigins],
      url: target.url,
      isAuthenticated: target.isAuthenticated,
      // This is an unattended, timer-driven background job -- never a
      // human watching for a window. Also what lets withBrowserSession()
      // reach its real-chrome self-heal tier HEADLESSLY on a session
      // failure (real-chrome-unattended-self-heal story) rather than
      // giving up after tier 1 alone.
      attended: false,
    },
    async (page) => {
      await page.waitForTimeout(dwellMs);

      // Re-save regardless of which tier answered -- the whole point of
      // dwelling is to capture whatever the site's own background JS may
      // have refreshed during that wait, not just what a tier-3 self-heal
      // already writes back on its own. Local-backend only, same as every
      // other write-back in this codebase (a portunus-backed session has
      // its own separate write path this function does not duplicate).
      if (sessionBackend === "local" && typeof sessionStatePath === "string") {
        const fresh = (await page.context().storageState()) as StorageState;
        const scoped = filterStorageStateToAllowlist(fresh, [...allowedOrigins]);
        // Never overwrite a good, scoped session with an empty one -- a
        // keepalive that somehow lost its cookies mid-dwell should leave
        // the last-known-good file alone, matching session-capture.ts's
        // own "zero cookies -> don't write" sanity check.
        if (scoped.cookies.length > 0) {
          writeStorageStateAtomically(sessionStatePath, scoped);
        }
      }
    },
  );
}
