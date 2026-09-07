// tauri-shell-open-external-links story. A plain `<a href target="_blank">`
// does not reliably shell out to the OS default browser from inside the
// packaged Tauri webview (confirmed live symptom: "clicking the link and
// open and stuff isn't working at all") -- even once the capability is
// granted (src-tauri/capabilities/default.json's "shell:allow-open",
// scoped in src-tauri/tauri.conf.json's plugins.shell.open to http(s)
// URLs only), the webview still needs the actual @tauri-apps/plugin-shell
// `open()` call instead of relying on `target="_blank"` navigation.
// Browser mode (`npm run dev`/`npm run start`) and Electron mode both keep
// working exactly as before -- a bare anchor/`window.open()` is fine there,
// and `@tauri-apps/plugin-shell` has no equivalent capability outside the
// packaged Tauri app -- so this checks isTauri() (the SAME mode-guard
// update-notifier.tsx, config-client.tsx, and embedded-webview.ts already
// share) rather than forcing every call site to branch on runtime mode
// itself.
//
// Call sites should still render a real `<a href={url}>` (for accessible
// role="link" semantics, graceful degradation before JS runs, and native
// middle-click/right-click "open in new tab" support) with an onClick that
// calls `event.preventDefault()` and then this function -- not a `<button>`.
// This function itself is element-agnostic; it only performs the actual
// open once called.
import { isTauri } from "@/lib/is-tauri";

/**
 * Opens `url` in the real OS default browser. Inside the packaged Tauri
 * app this goes through `@tauri-apps/plugin-shell`'s `open()` (the only
 * path that actually shells out from a Tauri webview); in browser/Electron
 * mode it falls back to `window.open()`, which already works there.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
