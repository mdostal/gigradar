/**
 * True only inside the packaged Tauri shell -- browser mode (`npm run dev`/
 * `npm run start`) and Electron mode both serve the SAME Next.js build (see
 * docs/ARCHITECTURE.md's "Two runtime modes" section), so this can't be a
 * build-time flag; it has to check what the running window actually is.
 * `window.__TAURI_INTERNALS__` is what `@tauri-apps/api`'s own `invoke()`/
 * `listen()` read internally (verified against the installed package) --
 * this is the same signal, not a separate guess. Shared by update-notifier.tsx
 * and config-client.tsx's version/channel readout so the two components
 * can't drift on what "running inside Tauri" means.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
