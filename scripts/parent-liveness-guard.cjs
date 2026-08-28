// runner-registry-and-sidecar-lifecycle epic: belt-and-suspenders half of
// the orphaned-sidecar fix. src-tauri/src/lib.rs's RunEvent::Exit handler
// (tauri-sidecar-exit-cleanup story) kills this process on every GRACEFUL
// Tauri shutdown -- but an external SIGKILL/force-quit sent directly to
// the Tauri process never reaches its own event loop, so that handler
// never fires. Confirmed live this session: exactly that (a `pkill`
// targeting the Tauri process directly) left this exact sidecar orphaned,
// still holding its port.
//
// The robust fix for THAT case has to live here, on the child side: if
// GIGRADAR_PARENT_PID is set (only true when spawned as a GUI child --
// Tauri's sidecar or Electron's child process; a plain `npm run dev`/
// `npm run start` terminal session never sets it, so normal Ctrl+C/shell
// job-control behavior is completely unaffected), poll whether that PID
// is still alive and self-exit the moment it isn't.
//
// Loaded via `NODE_OPTIONS=--require .../parent-liveness-guard.cjs` --
// not edited into server.js directly, since that file is Next's own
// auto-generated `.next/standalone` build output (scripts/
// prepare-tauri-sidecars.sh copies it verbatim), not something this repo
// owns the content of. A --require preload runs before the real
// entrypoint regardless of what that entrypoint is (the raw standalone
// server.js for Tauri, or `next start`'s own CLI for Electron) -- same
// mechanism, one file, both runtime modes.
const POLL_INTERVAL_MS = 10_000;

const parentPidRaw = process.env.GIGRADAR_PARENT_PID;
if (parentPidRaw) {
  const parentPid = Number(parentPidRaw);
  if (Number.isInteger(parentPid) && parentPid > 0) {
    // Signal 0 checks whether a process exists/is signalable without
    // actually sending a real signal -- throws ESRCH once that PID no
    // longer exists. .unref() so this poll alone never keeps the process
    // alive once everything else it's doing has finished.
    setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        process.exit(0);
      }
    }, POLL_INTERVAL_MS).unref();
  }
}
