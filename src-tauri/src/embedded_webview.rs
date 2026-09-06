// true-embedded-browser epic, embedded-webview-child-mechanism story. A
// real, long-lived child webview embedded INSIDE the main gigradar
// window (never a separate OS-level window) -- the actual fix for the
// window-flashing/focus-stealing problem this epic exists to solve (see
// .pHive/epics/true-embedded-browser/docs/design-discussion.md).
//
// REAL SPIKE FINDING (2026-09-03, confirmed by reading the vendored
// crate source directly, not assumed from docs): `Window::add_child()`
// only compiles when the `tauri` crate is built with the "unstable"
// Cargo feature (see Cargo.toml's own comment on this dependency) --
// confirmed via `~/.cargo/registry/.../tauri-2.11.5/src/window/mod.rs`'s
// own `#[cfg(any(test, all(desktop, feature = "unstable")))]` gate on
// that exact method.
//
// LONG-LIVED, REUSED, NEVER RECREATED PER CALL -- mirrors real-chrome.ts's
// own persistent-profile precedent (project memory
// gigradar-real-chrome-persistent-profile.md). `show()` creates the
// child webview lazily on first call; every later call reuses the SAME
// `Webview` handle (navigate/reposition it, never rebuild it).
use std::sync::Mutex;
use tauri::{LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl};

/// Held in Tauri's managed state (see lib.rs's `.manage(EmbeddedWebviewHandle::default())`)
/// so every command invocation can find the SAME child webview instance
/// rather than each one creating its own.
#[derive(Default)]
pub struct EmbeddedWebviewHandle(Mutex<Option<Webview>>);

impl EmbeddedWebviewHandle {
    /// A cheap clone of the live `Webview` handle, for callers OUTSIDE
    /// this module that need it directly (e.g.
    /// embedded_webview_cookies.rs's own read_session command) --
    /// `Webview` itself is a thin, `Clone`-able reference type (Tauri's
    /// own convention, same as `AppHandle`), never the actual native
    /// webview resource. `None` when show() hasn't been called yet.
    pub fn webview_handle(&self) -> Option<Webview> {
        self.0.lock().ok()?.clone()
    }
}

const CHILD_LABEL: &str = "embedded-browser";
const MAIN_WINDOW_LABEL: &str = "main";

/// Shows (creating on first call, reusing thereafter) the embedded child
/// webview at `url`, positioned/sized per the frontend's own real layout
/// measurement (a ref'd `<div>`'s `getBoundingClientRect()` -- see the
/// `src/lib/tauri/embedded-webview.ts` frontend bridge this command is
/// called from). Coordinates are LOGICAL pixels (Tauri's own DPI-aware
/// unit), matching what a browser's own `getBoundingClientRect()` already
/// reports -- no manual DPI scaling needed at either end.
#[tauri::command]
pub fn embedded_webview_show(
    app: tauri::AppHandle,
    handle: tauri::State<EmbeddedWebviewHandle>,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let parsed_url: tauri::Url = url
        .parse()
        .map_err(|e| format!("gigradar embedded-webview: invalid url \"{url}\": {e}"))?;

    let mut guard = handle
        .0
        .lock()
        .map_err(|_| "gigradar embedded-webview: handle mutex poisoned".to_string())?;

    if let Some(webview) = guard.as_ref() {
        // Reuse: reposition/resize and navigate the EXISTING webview,
        // never rebuild -- see this module's own header comment.
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| format!("gigradar embedded-webview: failed to reposition: {e}"))?;
        webview
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| format!("gigradar embedded-webview: failed to resize: {e}"))?;
        webview
            .navigate(parsed_url)
            .map_err(|e| format!("gigradar embedded-webview: failed to navigate: {e}"))?;
        webview
            .show()
            .map_err(|e| format!("gigradar embedded-webview: failed to show: {e}"))?;
        return Ok(());
    }

    let main_window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "gigradar embedded-webview: main window not found".to_string())?;

    let builder = WebviewBuilder::new(CHILD_LABEL, WebviewUrl::External(parsed_url));
    let webview = main_window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| format!("gigradar embedded-webview: failed to create child webview: {e}"))?;

    *guard = Some(webview);
    Ok(())
}

/// Hides the embedded webview without destroying it -- the underlying
/// `Webview` (and whatever session/navigation state it holds) survives;
/// `embedded_webview_show()` later just repositions/re-shows the SAME
/// instance.
#[tauri::command]
pub fn embedded_webview_hide(handle: tauri::State<EmbeddedWebviewHandle>) -> Result<(), String> {
    let guard = handle
        .0
        .lock()
        .map_err(|_| "gigradar embedded-webview: handle mutex poisoned".to_string())?;
    match guard.as_ref() {
        Some(webview) => webview
            .hide()
            .map_err(|e| format!("gigradar embedded-webview: failed to hide: {e}")),
        None => Ok(()), // never created yet -- hiding a nonexistent webview is a no-op, not an error
    }
}

/// Navigates the ALREADY-SHOWING embedded webview to a new url, without
/// touching position/size. Errors if the webview hasn't been created yet
/// (a caller should always `show()` first).
#[tauri::command]
pub fn embedded_webview_navigate(
    handle: tauri::State<EmbeddedWebviewHandle>,
    url: String,
) -> Result<(), String> {
    let parsed_url: tauri::Url = url
        .parse()
        .map_err(|e| format!("gigradar embedded-webview: invalid url \"{url}\": {e}"))?;
    let guard = handle
        .0
        .lock()
        .map_err(|_| "gigradar embedded-webview: handle mutex poisoned".to_string())?;
    match guard.as_ref() {
        Some(webview) => webview
            .navigate(parsed_url)
            .map_err(|e| format!("gigradar embedded-webview: failed to navigate: {e}")),
        None => Err(
            "gigradar embedded-webview: not yet created -- call embedded_webview_show() first"
                .to_string(),
        ),
    }
}

/// true-embedded-browser epic, embedded-automation-bridge story. Runs
/// arbitrary JS against the embedded webview and returns its result --
/// the real mechanism `src/lib/tauri/embedded-webview.ts`'s frontend
/// find/click/type helpers are built on. Cross-platform Tauri API (no
/// macOS-specific FFI needed at all, unlike embedded_webview_cookies.rs's
/// native cookie read) -- confirmed via the vendored crate source
/// (`~/.cargo/registry/.../tauri-2.11.5/src/webview/mod.rs`'s own
/// `eval_with_callback()`), not assumed from docs.
///
/// ASYNC, using the SAME oneshot-channel + `Arc<Mutex<Option<Sender>>>`
/// bridging pattern embedded_webview_cookies.rs's `dispatch_cookie_read()`
/// already established, for the SAME reason: `eval_with_callback()`'s own
/// callback type is `impl Fn(String) + Send + 'static` (an ObjC-block-
/// style "may be invoked more than once" contract, even though this
/// specific API only ever calls it once in practice) -- a plain
/// `oneshot::Sender::send()` consumes `self`, so only `FnOnce`; wrapping
/// it in `Arc<Mutex<Option<_>>>` lets one `Fn` closure send at most once
/// via `.take()`, matching the cookie-read command's own documented
/// reasoning exactly.
///
/// Per `eval_with_callback()`'s own doc comment, a thrown JS exception is
/// silently swallowed on Windows rather than surfaced -- the frontend
/// bridge (`evalInEmbeddedWebview()`) works around this by having every
/// injected script wrap its own body in try/catch and always resolve to
/// a `{ok, result}` or `{ok: false, error}` JSON string itself, never
/// relying on eval_with_callback() to report a JS-level throw.
#[tauri::command]
pub async fn embedded_webview_eval(
    handle: tauri::State<'_, EmbeddedWebviewHandle>,
    js: String,
) -> Result<String, String> {
    let webview = handle.webview_handle().ok_or_else(|| {
        "gigradar embedded-webview: not yet created -- call embedded_webview_show() first".to_string()
    })?;

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));

    webview
        .eval_with_callback(js, move |result: String| {
            if let Ok(mut guard) = tx.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(result);
                }
            }
        })
        .map_err(|e| format!("gigradar embedded-webview: eval failed: {e}"))?;

    rx.await
        .map_err(|_| "gigradar embedded-webview: eval channel closed before a result arrived".to_string())
}

/// Destroys the embedded webview entirely (not just hides it) -- for a
/// real "I'm done with this session, tear it down" moment (e.g. cancelling
/// a Capture Login), as distinct from `hide()`'s "keep it around, just out
/// of view" semantics.
#[tauri::command]
pub fn embedded_webview_close(handle: tauri::State<EmbeddedWebviewHandle>) -> Result<(), String> {
    let mut guard = handle
        .0
        .lock()
        .map_err(|_| "gigradar embedded-webview: handle mutex poisoned".to_string())?;
    if let Some(webview) = guard.take() {
        webview
            .close()
            .map_err(|e| format!("gigradar embedded-webview: failed to close: {e}"))?;
    }
    Ok(())
}
