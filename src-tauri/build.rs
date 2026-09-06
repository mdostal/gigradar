// REAL, PRE-EXISTING BUG FOUND 2026-09-06 while live-verifying
// embedded-automation-bridge: every one of this app's OWN custom
// `#[tauri::command]`s (registered in `lib.rs`'s `generate_handler!`) has
// ALWAYS been unreachable from the frontend, in every build (dev and
// presumably packaged/production too, since capability resolution is
// compiled in, not dev-mode-specific) -- confirmed by a live `invoke()`
// call against `get_update_status` (a long-shipped, unrelated command)
// returning the SAME "not allowed. Plugin not found" error as the new
// embedded_webview_eval command. Root cause: `tauri_build::build()`
// (bare, no `Attributes`) creates NO `AppManifest` at all, so Tauri's ACL
// system never generates ANY permission for this app's own commands --
// plain `generate_handler!` registration alone does NOT imply
// "allowed," contrary to what this file's own prior bare
// `tauri_build::build()` call assumed. Fixed by declaring every command
// here via `AppManifest::commands()`, which auto-generates a real
// `allow-<kebab-case-command>` permission per command that
// `capabilities/default.json` then references.
//
// Every custom command in lib.rs's own `generate_handler!` list MUST be
// added here too -- this list is not auto-derived from that one, so a
// new command with no permission line here will hit this exact same
// "Plugin not found" error, silently, again.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "get_update_channel",
            "get_update_status",
            "install_update",
            "snooze_update",
            "embedded_webview_show",
            "embedded_webview_hide",
            "embedded_webview_navigate",
            "embedded_webview_close",
            "embedded_webview_eval",
            "embedded_webview_read_session",
        ])),
    )
    .expect("gigradar: tauri_build failed");
}
