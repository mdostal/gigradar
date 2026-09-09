// The shared Server Action result convention for this epic
// (dashboard-config-ui). Established here by the dashboard-results-view
// story's status-change action; the epic's other Server Action (config-save,
// a later story) reuses this same shape rather than each action inventing
// its own error handling. See docs/ARCHITECTURE.md's "Server Actions"
// section.
//
// The point: a Server Action's thrown exception crossing the client/server
// boundary uncaught surfaces to the browser as an opaque, unhandled 500 with
// no actionable message. Every Server Action in this app instead catches its
// own errors and returns this typed shape, so a client component can always
// branch on `result.ok` and show a real message.
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Build a success result. */
export function actionOk<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

/**
 * Build a failure result from a caught error. Never re-throws or lets the
 * original error value itself cross the boundary — only its message string.
 *
 * real-app-diagnosability epic follow-up (2026-09-09): every one of this
 * app's ~105 actionErr() call sites CATCHES its own error and returns it as
 * plain data -- exactly the pattern this file's own header comment
 * describes as the point (a clean, actionable client-side message instead
 * of an opaque unhandled 500). The real cost, discovered live diagnosing a
 * GoFractional Capture Login that silently never saved a session despite
 * the owner retrying it multiple times: a caught-and-returned error is
 * NEVER an uncaught exception, so it never reached server-side logs either
 * -- including after this same epic's OTHER real fix (registering
 * tauri_plugin_log unconditionally in the packaged app). The error message
 * really did exist, but only for the few seconds it was visible in an
 * in-app toast before being dismissed; nothing durable ever recorded it.
 * `console.error` here, in this ONE shared function every action already
 * funnels through, gives blanket real-server-side visibility into every
 * action's real failures going forward -- without touching any of the 105
 * call sites individually, and without changing this function's own
 * client-facing contract (still just the message string, never the
 * original error value).
 */
export function actionErr(e: unknown): ActionResult<never> {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`gigradar action error: ${message}`);
  return { ok: false, error: message };
}
