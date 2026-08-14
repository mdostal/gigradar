// Best-effort native desktop notifications — used by the scheduler
// (notify-on-green-match story) to alert on new green-tier matches without
// requiring the dashboard to be open. Deliberately zero external
// dependencies: shells out to whatever notification tool the OS already
// ships (osascript on macOS, notify-send on Linux), rather than pulling in
// a cross-platform notification npm package for what's ultimately an
// optional, non-critical nicety.
import { execFile } from "node:child_process";

export interface DesktopNotification {
  title: string;
  body: string;
}

const MAX_FIELD_LENGTH = 200;

/**
 * Both `title` and `body` may contain untrusted, scraped content (a real
 * gig's title/company) — never trusted as anything but plain display text.
 * Collapses newlines to spaces (native notification APIs handle embedded
 * newlines inconsistently) and truncates to a sane length before it ever
 * reaches a platform-specific escaping function below.
 */
function sanitizeField(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_FIELD_LENGTH ? `${collapsed.slice(0, MAX_FIELD_LENGTH - 1)}…` : collapsed;
}

/** Escapes a string for safe interpolation into an AppleScript double-quoted string literal. */
function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runOsascriptNotification(title: string, body: string): Promise<void> {
  return new Promise((resolve) => {
    const script = `display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(title)}"`;
    // execFile (never a shell) — argv-level separation, not string
    // concatenation, so the notification content can't break out into a
    // second shell command regardless of what a scraped gig title contains.
    execFile("osascript", ["-e", script], { timeout: 5_000 }, (err) => {
      if (err) console.warn(`gigradar notify: osascript notification failed: ${err.message}`);
      resolve();
    });
  });
}

function runNotifySend(title: string, body: string): Promise<void> {
  return new Promise((resolve) => {
    // Two separate argv entries, never a single interpolated string -- same
    // shell-injection-proof reasoning as the osascript path above. No
    // AppleScript-style string-literal escaping needed here since
    // notify-send takes title/body as plain positional arguments.
    execFile("notify-send", [title, body], { timeout: 5_000 }, (err) => {
      if (err) console.warn(`gigradar notify: notify-send notification failed: ${err.message}`);
      resolve();
    });
  });
}

/**
 * Fires one best-effort native desktop notification. NEVER throws and NEVER
 * lets a notification failure propagate — a missing/broken OS notification
 * tool, an unsupported platform, or a permissions issue always just logs a
 * warning and resolves. Callers (the scheduler) must be free to call this
 * without any try/catch of their own; a notification is a nicety, never
 * something that should be able to break a scan cycle.
 */
export async function sendDesktopNotification(n: DesktopNotification): Promise<void> {
  const title = sanitizeField(n.title);
  const body = sanitizeField(n.body);
  try {
    if (process.platform === "darwin") {
      await runOsascriptNotification(title, body);
    } else if (process.platform === "linux") {
      await runNotifySend(title, body);
    } else {
      console.warn(`gigradar notify: desktop notifications aren't supported on platform "${process.platform}" — skipping.`);
    }
  } catch (e) {
    // Belt-and-braces: runOsascriptNotification()/runNotifySend() already
    // swallow their own errors via their Promise executor, so this branch
    // is unreachable in practice — kept because a caller must NEVER see
    // this function reject, under any circumstance.
    console.warn(`gigradar notify: unexpected notification error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
