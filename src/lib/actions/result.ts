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
 */
export function actionErr(e: unknown): ActionResult<never> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}
