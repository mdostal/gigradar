// deep-dive-audit-and-testing-framework epic, sidecar-health-check story.
// Real incident this session: the packaged Tauri app's Node sidecar server
// died silently and sat dead for 2+ days (process alive, port not
// listening) with zero detection -- the owner's own words, "i click and
// nothing happens." No heartbeat/health-check mechanism existed anywhere
// in this codebase (grepped scheduler/notify -- zero hits). The one
// related shipped mechanism, sidecar-orphan-self-detection
// (runner-registry-and-sidecar-lifecycle epic), covers the OPPOSITE
// direction: the sidecar polling its own parent PID and self-exiting if
// the PARENT (the Tauri app) disappears -- not the app staying alive while
// the sidecar itself silently dies. This module is that missing direction.
//
// Runs from the scheduler process (already a separate, independently
// launchd-managed long-running process per the existing scan cron) rather
// than from the Tauri Rust side -- src-tauri/src/lib.rs only does a
// one-time TCP-readiness poll at launch today, and turning that into an
// ongoing watchdog would mean the app polling ITSELF, which can't detect
// its own sidecar going unresponsive.
//
// Reuses raiseIssue()'s existing dedupe/desktop-notification mechanism
// (notify/issues.ts) -- no new notification path, no new persistence
// table.
import { raiseIssue, resolveIssuesForSource } from "../lib/notify/issues.js";

const HEALTH_CHECK_SOURCE = "sidecar-health-check";
const HEALTH_CHECK_TITLE = "gigradar's own server isn't responding";

export interface SidecarHealthCheckOptions {
  /** Defaults to GIGRADAR_PORT (matching src-tauri/src/lib.rs's own port-resolution convention) or 3000. */
  port?: number;
  /** How often to poll. Default 5 minutes -- frequent enough to catch a real outage fast, infrequent enough to be a non-issue in cost/noise. */
  intervalMs?: number;
  /** Consecutive failed checks required before raising an issue -- tolerates a brief restart (e.g. a real app update) without a false alarm. Default 3 (with the default 5-minute interval, ~10-15 minutes of continuous downtime). */
  consecutiveFailureThreshold?: number;
  /** Injectable for tests -- a function that resolves iff the server is healthy, rejects/throws otherwise. Defaults to a real fetch against http://127.0.0.1:{port}/. */
  checkFn?: () => Promise<void>;
  raiseIssueFn?: typeof raiseIssue;
  resolveIssuesForSourceFn?: typeof resolveIssuesForSource;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface SidecarHealthCheckHandle {
  stop: () => void;
  /** Test/inspection hook -- how many consecutive failures have been observed since the last success. */
  getConsecutiveFailures: () => number;
}

async function defaultCheck(port: number): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    if (!res.ok) throw new Error(`gigradar sidecar-health-check: got HTTP ${res.status} from port ${port}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Starts the periodic health check. Never throws -- a check failure is
 * caught, counted, and (past the threshold) reported via raiseIssue();
 * this function's own return is synchronous and always succeeds.
 */
export function startSidecarHealthCheck(options: SidecarHealthCheckOptions = {}): SidecarHealthCheckHandle {
  const envPort = Number(process.env.GIGRADAR_PORT);
  const port = options.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : 3000);
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000;
  const threshold = options.consecutiveFailureThreshold ?? 3;
  const checkFn = options.checkFn ?? (() => defaultCheck(port));
  const raiseIssueFn = options.raiseIssueFn ?? raiseIssue;
  const resolveIssuesForSourceFn = options.resolveIssuesForSourceFn ?? resolveIssuesForSource;
  const setIntervalFn = options.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIntervalFn = options.clearIntervalFn ?? ((handle: ReturnType<typeof setInterval>) => clearInterval(handle));

  let consecutiveFailures = 0;
  let issueRaisedThisOutage = false;

  async function tick(): Promise<void> {
    try {
      await checkFn();
      const wasFailing = consecutiveFailures > 0;
      consecutiveFailures = 0;
      if (wasFailing && issueRaisedThisOutage) {
        resolveIssuesForSourceFn(HEALTH_CHECK_SOURCE);
        issueRaisedThisOutage = false;
      }
    } catch (e) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= threshold && !issueRaisedThisOutage) {
        const message = e instanceof Error ? e.message : String(e);
        await raiseIssueFn({
          severity: "error",
          source: HEALTH_CHECK_SOURCE,
          title: HEALTH_CHECK_TITLE,
          message: `gigradar's local server has not responded to ${consecutiveFailures} consecutive health checks. If the app looks frozen, quitting and relaunching it usually fixes this. (${message})`,
          context: { port, consecutiveFailures },
        });
        issueRaisedThisOutage = true;
      }
    }
  }

  const handle = setIntervalFn(() => void tick(), intervalMs);

  return {
    stop: () => clearIntervalFn(handle),
    getConsecutiveFailures: () => consecutiveFailures,
  };
}
