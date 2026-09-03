// true-embedded-browser epic, embedded-webview-cookie-extraction-macos
// story. Reads REAL session cookies (including HttpOnly ones --
// `document.cookie` injection cannot see those) back out of the embedded
// webview after a human completes a real login, macOS-only.
//
// REAL SPIKE FINDING (2026-09-03): the FULL native API chain this needs
// already exists as real, `header-translator`-generated Rust bindings in
// this dependency tree (objc2-web-kit 0.3.2, objc2-foundation 0.3.2 --
// both already transitive deps of tauri-runtime-wry, confirmed present
// via `cargo tree`, not assumed):
//   WKWebView::configuration() -> WKWebViewConfiguration::websiteDataStore()
//   -> WKWebsiteDataStore::httpCookieStore() -> WKHTTPCookieStore::getAllCookies(block)
// and every NSHTTPCookie field this module needs (name/value/domain/path/
// expiresDate/isSecure/isHTTPOnly/sameSitePolicy) is a real, safe
// (non-`unsafe fn`) accessor on objc2_foundation::NSHTTPCookie. No
// hand-written objc FFI needed -- this is real, existing, generated
// bindings, not a guess.
//
// A REAL DESIGN BUG CAUGHT AND FIXED DURING THIS SAME SPIKE, before ever
// compiling it: `getAllCookies()`'s completion block is asynchronous even
// once dispatched onto the main thread (WebKit posts it to a LATER
// main-run-loop iteration, not necessarily reentrantly). An earlier draft
// of this file called it FROM INSIDE a `run_on_main_thread()` closure and
// then blocked that SAME closure on a channel waiting for the block to
// fire -- a real deadlock (the main thread can't process the queued
// completion block while it's itself blocked synchronously waiting for
// it). Fixed: `run_on_main_thread()`'s own closure only DISPATCHES the
// read and returns immediately; the actual result comes back via a
// `tokio::sync::oneshot` the ASYNC command awaits (never blocks any
// thread, including the main one) -- the completion block fires later,
// independently, and completes the oneshot then.
//
// STILL UNVERIFIED AT RUNTIME, per this story's own mandatory-spike
// requirement: whether Tauri's `PlatformWebview::inner()` raw pointer
// safely upgrades to a `Retained<WKWebView>` via `Retained::retain()`,
// and whether the cookies returned actually include a real post-login
// session cookie -- genuinely unconfirmed until this runs against a real
// embedded webview with a real login completed in it. Compiles clean
// (`cargo check`); that is the extent of what's verified so far.
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_foundation::NSHTTPCookie;
use objc2_web_kit::WKWebView;
use tauri::State;

use crate::embedded_webview::EmbeddedWebviewHandle;

/// Matches src/lib/auth/browser-session.ts's `StorageStateCookie` type
/// field-for-field -- this story's whole job is producing a drop-in-
/// compatible session snapshot, never a new shape downstream code has to
/// adapt to.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStateCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    /// Unix seconds, or -1 for a session cookie with no expiry -- same
    /// convention Playwright's own storageState shape uses, which
    /// browser-session.ts's StorageStateCookie type already matches.
    pub expires: f64,
    pub http_only: bool,
    pub secure: bool,
    pub same_site: String,
}

#[derive(serde::Serialize)]
pub struct StorageStateOrigin {
    pub origin: String,
    pub local_storage: Vec<serde_json::Value>,
}

#[derive(serde::Serialize)]
pub struct StorageState {
    pub cookies: Vec<StorageStateCookie>,
    pub origins: Vec<StorageStateOrigin>,
}

/// Converts one real NSHTTPCookie into the StorageStateCookie shape.
/// `sameSitePolicy` maps WebKit's own string constants
/// ("Lax"/"Strict"/"None") onto Playwright's own StorageStateCookie
/// sameSite union ("Lax"/"Strict"/"None") -- happens to already match
/// WebKit's own wording, confirmed by reading WKHTTPCookieStore.rs's
/// sibling NSHTTPCookieStringPolicy constants rather than assumed.
fn convert_cookie(cookie: &NSHTTPCookie) -> StorageStateCookie {
    let expires = cookie
        .expiresDate()
        .map(|date| date.timeIntervalSince1970())
        .unwrap_or(-1.0);
    let same_site = cookie
        .sameSitePolicy()
        .map(|policy| policy.to_string())
        .unwrap_or_else(|| "Lax".to_string());

    StorageStateCookie {
        name: cookie.name().to_string(),
        value: cookie.value().to_string(),
        domain: cookie.domain().to_string(),
        path: cookie.path().to_string(),
        expires,
        http_only: cookie.isHTTPOnly(),
        secure: cookie.isSecure(),
        same_site,
    }
}

/// Reads every real cookie currently held by the embedded webview's own
/// WKWebsiteDataStore. Requires embedded_webview_show() (embedded_webview.rs)
/// to have created the webview already -- errors if it hasn't.
///
/// ASYNC command, on purpose -- see this module's own header comment for
/// the real deadlock this avoids. `run_on_main_thread()` below only
/// dispatches the read (returns immediately); the oneshot it completes
/// fires later, from WKHTTPCookieStore's own completion block, on a
/// LATER main-thread run-loop tick -- this function's own `.await` never
/// blocks any real OS thread while that happens.
#[tauri::command]
pub async fn embedded_webview_read_session(handle: State<'_, EmbeddedWebviewHandle>) -> Result<StorageState, String> {
    let webview = handle
        .webview_handle()
        .ok_or_else(|| "gigradar embedded-webview: not yet created -- call embedded_webview_show() first".to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<StorageStateCookie>, String>>();
    // Sender wrapped in Arc<Mutex<Option<_>>>, NOT a bare borrowed
    // reference -- the ObjC completion block (see dispatch_cookie_read())
    // needs its OWN independent, reference-counted ownership: if this
    // async command were ever cancelled/dropped BEFORE WebKit's
    // completion block fires (e.g. the caller times out), a borrowed
    // `&Mutex` tied to this function's own stack would dangle by the time
    // the block later runs -- a real use-after-free this Arc avoids
    // entirely by keeping the Mutex alive for as long as the block's own
    // clone of the Arc is alive, independent of this function's lifetime.
    // Mutex<Option<_>> (not a bare Sender) because block2::RcBlock::new()
    // requires an `Fn` closure (see dispatch_cookie_read()'s own doc
    // comment) -- oneshot::Sender::send() consumes self, so only
    // `.take()`-through-a-lock lets the SAME `Fn` closure send at most once.
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));

    // with_webview() ITSELF already dispatches its closure onto the main
    // thread (its own doc examples call it directly from setup(), no
    // extra run_on_main_thread() wrapping) -- an earlier draft of this
    // file wrapped it in a REDUNDANT run_on_main_thread() call and tried
    // to bridge the resulting !Send PlatformWebview (it wraps a raw
    // *mut c_void, which cannot cross a channel) back out; this single
    // call is the correct, simpler shape.
    webview
        .with_webview(move |platform_webview| {
            dispatch_cookie_read(&platform_webview, tx);
        })
        .map_err(|e| format!("gigradar embedded-webview: with_webview dispatch failed: {e}"))?;

    let cookies = rx
        .await
        .map_err(|_| "gigradar embedded-webview: cookie-read channel closed before a result arrived".to_string())??;

    Ok(StorageState { cookies, origins: vec![] })
}

/// MUST run on the main thread (WKHTTPCookieStore is MainThreadOnly --
/// see objc2-web-kit's own WKHTTPCookieStore.rs `#[thread_kind = MainThreadOnly]`)
/// -- guaranteed here since with_webview()'s own closure already runs
/// there (see this module's `embedded_webview_read_session()` doc
/// comment). Casts Tauri's raw `*mut c_void` WKWebView pointer to a real,
/// reference-counted `Retained<WKWebView>` via `Retained::retain()` --
/// RETAINS a NEW reference to an object Tauri/wry still owns (never
/// `Retained::from_raw()`, which would incorrectly consume Tauri's own
/// existing reference). Dispatches getAllCookies() and returns
/// immediately -- `tx` is completed later, from INSIDE the completion
/// block, never from this function's own return.
///
/// `tx` is an OWNED `Arc<Mutex<Option<Sender<...>>>>` (see
/// `embedded_webview_read_session()`'s own doc comment on why a borrowed
/// reference here would be a real use-after-free risk on cancellation) --
/// the `Mutex<Option<_>>` layer is separately needed because
/// `block2::RcBlock::new()` requires an `Fn` closure (an ObjC block's
/// contract allows more than one invocation in general, even though
/// getAllCookies' OWN contract promises exactly one) -- a closure that
/// moves and consumes a oneshot::Sender via `.send(self)` is only
/// `FnOnce`. The Mutex<Option<_>>'s `.take()` lets the SAME `Fn` closure
/// send at most once via shared reference, no-op-ing (not panicking) if
/// WebKit ever called it again.
type CookieResultSender = std::sync::Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<Vec<StorageStateCookie>, String>>>>>;

fn dispatch_cookie_read(platform_webview: &tauri::webview::PlatformWebview, tx: CookieResultSender) {
    fn send_once(tx: &CookieResultSender, result: Result<Vec<StorageStateCookie>, String>) {
        if let Ok(mut guard) = tx.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(result);
            }
        }
    }

    let Some(_mtm) = MainThreadMarker::new() else {
        send_once(&tx, Err("gigradar embedded-webview: cookie read attempted off the main thread".to_string()));
        return;
    };

    let raw_ptr = platform_webview.inner() as *mut WKWebView;
    // SAFETY: `raw_ptr` is Tauri's own live WKWebView pointer for the
    // webview this exact command is scoped to -- retain() adds a new
    // reference rather than assuming ownership of Tauri's existing one,
    // matching the documented pattern for borrowing a raw Objective-C
    // pointer safely. This call itself happens on the main thread (see
    // this function's own doc comment).
    let webview: Retained<WKWebView> = match unsafe { Retained::retain(raw_ptr) } {
        Some(w) => w,
        None => {
            send_once(&tx, Err("gigradar embedded-webview: WKWebView pointer was null".to_string()));
            return;
        }
    };

    let cookie_store = unsafe { webview.configuration().websiteDataStore().httpCookieStore() };

    let block = block2::RcBlock::new(move |cookies_ptr: std::ptr::NonNull<objc2_foundation::NSArray<NSHTTPCookie>>| {
        let cookies_array = unsafe { cookies_ptr.as_ref() };
        let converted: Vec<StorageStateCookie> = cookies_array.iter().map(|c| convert_cookie(&c)).collect();
        send_once(&tx, Ok(converted));
    });
    unsafe { cookie_store.getAllCookies(&block) };
    // `block` must outlive the async ObjC call -- RcBlock is
    // reference-counted on the ObjC side once passed to getAllCookies(),
    // so letting this Rust-side RcBlock drop at the end of this function
    // is safe (matches objc2's own documented RcBlock contract: the
    // callee retains its own reference for as long as it needs the block).
}
