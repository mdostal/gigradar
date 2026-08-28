"use client";

// tauri-update-notification epic: check_for_updates() (src-tauri/src/updater.rs)
// used to go straight from "found an update" to a silent download+install+
// app.restart() with zero signal to this webview -- @tauri-apps/plugin-updater
// was an installed dependency with ZERO references anywhere in src/app or
// src/lib (grep-verified while planning this epic). This component is the
// other half: it listens for the gigradar://update-status event the Rust
// side now emits at each lifecycle transition and renders a real toast for
// the states a human should see.
//
// Tauri-only: browser mode (npm run dev/start) and Electron mode both serve
// this SAME Next.js build (docs/ARCHITECTURE.md's "Two runtime modes"), so
// this can't be a build-time flag -- isTauri() checks the running window
// itself. Renders nothing at all outside Tauri.
import { useEffect, useState } from "react";
import { isTauri } from "@/lib/is-tauri";

export type UpdateStatusPayload =
  | { status: "Checking" }
  | { status: "Available"; version: string }
  | { status: "Downloading" }
  | { status: "ReadyToInstall"; version: string; deadline_ms: number }
  | { status: "UpToDate" }
  | { status: "Error"; message: string };

/**
 * Human-readable "restarting in Ns"/"restarting in Nm 0Ns" countdown from a
 * deadline_ms epoch timestamp. Clamps to "any moment now" once the deadline
 * has passed -- the grace-period watcher on the Rust side polls on a coarse
 * interval (updater.rs's GRACE_PERIOD_POLL_INTERVAL), so there's a real
 * window where the UI's own 1s tick can outrun it by a few seconds.
 */
export function formatCountdown(deadlineMs: number, nowMs: number): string {
  const remainingMs = deadlineMs - nowMs;
  if (remainingMs <= 0) return "any moment now";
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes <= 0 ? `${seconds}s` : `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

const toastButtonClass =
  "rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-xs font-medium text-theme-text transition-colors hover:bg-theme-surface-raised disabled:opacity-50";

export function UpdateNotifier() {
  const [status, setStatus] = useState<UpdateStatusPayload | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Attach once: seed the CURRENT status via get_update_status (so a late
  // mount -- e.g. this component remounting after a client-side navigation
  // -- recovers an already-ready update instead of waiting for a future
  // event that may never re-fire), then subscribe to future transitions.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");

      const current = await invoke<UpdateStatusPayload>("get_update_status");
      if (!cancelled) setStatus(current);

      unlisten = await listen<UpdateStatusPayload>("gigradar://update-status", (event) => {
        setStatus(event.payload);
      });
    })().catch((err) => {
      console.error("gigradar: update-notifier failed to attach", err);
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Countdown tick -- only runs while there's actually a countdown to show.
  useEffect(() => {
    if (status?.status !== "ReadyToInstall") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  // An update-check failure is not something to interrupt the user over --
  // same "flag, don't fail" convention this repo already applies to
  // transient source-fetch issues (src/lib/notify/issues.ts).
  useEffect(() => {
    if (status?.status === "Error") {
      console.error("gigradar: update check error:", status.message);
    }
  }, [status]);

  if (!status || status.status === "Checking" || status.status === "UpToDate" || status.status === "Error") {
    return null;
  }

  async function handleRestartNow() {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      await invoke("install_update");
    } catch (err) {
      console.error("gigradar: install_update failed", err);
    }
  }

  async function handleSnooze() {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      await invoke("snooze_update");
    } catch (err) {
      console.error("gigradar: snooze_update failed", err);
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2 rounded-md border border-theme-surface-border bg-theme-surface p-3 text-sm text-theme-text shadow-lg">
      {status.status === "Available" && <p>Update v{status.version} available — downloading…</p>}
      {status.status === "Downloading" && <p>Downloading update…</p>}
      {status.status === "ReadyToInstall" && (
        <>
          <p>
            Update v{status.version} ready — restarting in {formatCountdown(status.deadline_ms, now)} to install.
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={handleRestartNow} className={toastButtonClass}>
              Restart now
            </button>
            <button type="button" onClick={handleSnooze} className={toastButtonClass}>
              Snooze 1h
            </button>
          </div>
        </>
      )}
    </div>
  );
}
