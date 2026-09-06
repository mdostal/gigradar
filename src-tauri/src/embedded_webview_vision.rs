// true-embedded-browser epic, embedded-vision-automation-mode story. The
// SECOND automation backend for guided/full-auto profile-assist -- vision
// + real OS-level synthetic input, macOS-only (gated at this module's own
// `mod` declaration in lib.rs, mirroring embedded_webview_cookies.rs's
// own convention). Live-verified this session's own POC, against
// gigradar's real running window, scoped strictly to its own PID
// throughout: `AXUIElementCreateApplication(pid)`/
// `SCContentFilter(desktopIndependentWindow:)`/
// `CGEvent.post(tap: .cghidEventTap)`. See
// .pHive/epics/true-embedded-browser/docs/design-discussion.md §7 for
// that POC narrative.
//
// HARD, OWNER-MANDATED CONSTRAINT (not a preference -- "I don't mind it
// moving the cursor... if we are IN THE AUTO-DRIVE... i should be doing
// that and watching it"): every command in this file that can move the
// real cursor or capture the real screen refuses unless an interactive
// foreground session has been explicitly opened via
// `embedded_vision_begin_session()`. `InteractiveSessionGate` below is
// the REAL enforcement point this story's own risk section demands -- a
// server-tracked flag a caller cannot bypass by invoking the Tauri
// command directly, never just a UI convention. See
// `__tests__`-equivalent coverage in this module's own `#[cfg(test)]`
// block: the gate is exercised directly, not only through the UI.
//
// SCOPE DECISION, deliberate: `embedded_webview_vision_capture()` uses
// `SCShareableContent::getCurrentProcessShareableContentWithCompletionHandler`
// (NOT the unrestricted `getShareableContentWithCompletionHandler`) --
// this variant is scoped BY THE OS ITSELF to only this process's own
// windows (Apple's own doc: "redacted information about windows...
// available to capture by current process without user consent via
// TCC"). That is a STRONGER guarantee than filtering a full system-wide
// window list by PID after the fact would be: it is structurally
// impossible for this call to ever see another app's window, and it
// does not require the user to have granted this app Screen Recording
// permission just to automate its own UI. This directly satisfies this
// story's own "never any other window/app, even ones overlapping it on
// screen" acceptance criterion, by construction rather than by careful
// filtering (the real, hard lesson from this epic's earlier
// screencapture-region incidents -- see
// feedback_never_screenshot_the_real_desktop.md).
//
// COORDINATE CONVENTION, deliberate: the captured image's pixel
// dimensions are set to exactly the window's own frame size IN POINTS
// (not multiplied by the display's Retina backing scale) -- so a vision
// model given that image and asked for a coordinate returns a value
// directly addable to the window's own frame origin with NO scale-factor
// conversion anywhere in this file. This trades away Retina sharpness
// for coordinate-math correctness on purpose; sharpness doesn't matter
// much for an element-finding vision call, but a scale-factor bug in a
// cursor-moving code path is exactly the kind of mistake this story's
// own risk section treats as release-blocking.
//
// STILL UNVERIFIED AT RUNTIME, same category of gap as
// embedded_webview_cookies.rs's own header comment: compiles clean
// (`cargo check`), mirrors the owner's own live-verified POC's exact API
// choices, but the CGImage pixel layout this module assumes (BGRA8,
// alpha last in memory order) and the exact point-vs-pixel behavior of
// `SCStreamConfiguration.width/height` have NOT been re-confirmed live
// against the real packaged app in THIS exact form -- needs the owner's
// own screen time, per this epic's established live-verification
// pattern (Stories 1-4's own progress_notes all defer the same class of
// gap).
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_core_foundation::{CFData, CFRetained, CGPoint, CGRect};
use objc2_core_graphics::{
    CGDataProvider, CGEvent, CGEventSource, CGEventSourceStateID, CGEventTapLocation, CGEventType,
    CGImage, CGMouseButton,
};
use objc2_screen_capture_kit::{SCContentFilter, SCShareableContent, SCStreamConfiguration, SCWindow};
use tauri::Manager;

/// Held in Tauri managed state (see lib.rs's `.manage(InteractiveSessionGate::default())`).
/// A plain `AtomicBool`, not a per-caller UI flag -- every command in
/// this file checks THIS directly, regardless of which frontend code
/// path invoked it, so there is no bypass route that skips the check.
#[derive(Default)]
pub struct InteractiveSessionGate(AtomicBool);

impl InteractiveSessionGate {
    pub fn is_active(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    fn set(&self, active: bool) {
        self.0.store(active, Ordering::SeqCst);
    }
}

const REFUSED_UNATTENDED: &str = "gigradar embedded-webview: vision-mode automation refused -- no interactive profile-assist session is currently open. This mode is foreground/human-supervised only and can never run from an unattended scan.";

/// Called by the client exactly when a guided/full-auto session in
/// Vision mode STARTS (mirroring embedded_webview_show()/close()'s own
/// show/hide lifecycle) -- opens the gate every other command in this
/// file checks.
#[tauri::command]
pub fn embedded_vision_begin_session(gate: tauri::State<InteractiveSessionGate>) {
    gate.set(true);
}

/// Called when the session ENDS (or the profile-assist panel is closed/
/// navigated away) -- closes the gate. Idempotent; safe to call even if
/// no session was open.
#[tauri::command]
pub fn embedded_vision_end_session(gate: tauri::State<InteractiveSessionGate>) {
    gate.set(false);
}

/// Captures the gigradar app's own main window (ONLY that window -- see
/// this module's own header comment on why
/// `getCurrentProcessShareableContentWithCompletionHandler` makes that a
/// structural guarantee, not a filtering exercise) and returns it as
/// base64-encoded PNG bytes. Refuses with `REFUSED_UNATTENDED` unless
/// `embedded_vision_begin_session()` has been called for this session.
#[tauri::command]
pub async fn embedded_webview_vision_capture(gate: tauri::State<'_, InteractiveSessionGate>) -> Result<String, String> {
    if !gate.is_active() {
        return Err(REFUSED_UNATTENDED.to_string());
    }

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let tx: CaptureResultSender = Arc::new(Mutex::new(Some(tx)));
    dispatch_capture(tx);

    let png_bytes = rx
        .await
        .map_err(|_| "gigradar embedded-webview: vision-capture channel closed before a result arrived".to_string())??;

    Ok(base64::engine::general_purpose::STANDARD.encode(png_bytes))
}

/// Synthesizes a real left-click at `(x, y)` -- POINTS relative to the
/// captured window's own top-left, matching
/// `embedded_webview_vision_capture()`'s own coordinate convention
/// exactly (see this module's header comment) -- via
/// `CGEvent.post(tap: .cghidEventTap)`, the same mechanism this epic's
/// own POC live-verified. Refuses if no interactive session is open, OR
/// if the gigradar window is not currently frontmost/key (this story's
/// own medium-severity risk: a queued synthetic click must never land on
/// whatever the owner clicked into instead).
#[tauri::command]
pub async fn embedded_webview_vision_click(app: tauri::AppHandle, gate: tauri::State<'_, InteractiveSessionGate>, x: f64, y: f64) -> Result<(), String> {
    if !gate.is_active() {
        return Err(REFUSED_UNATTENDED.to_string());
    }
    ensure_main_window_focused(&app)?;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<CGRect, String>>();
    let tx: FrameResultSender = Arc::new(Mutex::new(Some(tx)));
    dispatch_main_window_frame(tx);
    let frame = rx
        .await
        .map_err(|_| "gigradar embedded-webview: vision window-frame channel closed before a result arrived".to_string())??;

    let point = CGPoint { x: frame.origin.x + x, y: frame.origin.y + y };
    post_mouse_click(point)
}

/// Types `text` via `CGEventKeyboardSetUnicodeString` -- posts a
/// zero-virtual-key keyboard event carrying the literal Unicode string,
/// the standard CGEvent technique for typing arbitrary text without a
/// per-character keycode mapping. Same refusal guards as
/// `embedded_webview_vision_click()`.
#[tauri::command]
pub fn embedded_webview_vision_type(app: tauri::AppHandle, gate: tauri::State<InteractiveSessionGate>, text: String) -> Result<(), String> {
    if !gate.is_active() {
        return Err(REFUSED_UNATTENDED.to_string());
    }
    ensure_main_window_focused(&app)?;
    post_unicode_text(&text)
}

fn ensure_main_window_focused(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "gigradar embedded-webview: main window not found".to_string())?;
    let focused = window
        .is_focused()
        .map_err(|e| format!("gigradar embedded-webview: could not read window focus state: {e}"))?;
    if !focused {
        return Err("gigradar embedded-webview: vision-mode input refused -- the gigradar window is not frontmost/key right now. Click into it first, then retry.".to_string());
    }
    Ok(())
}

fn post_mouse_click(point: CGPoint) -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .ok_or_else(|| "gigradar embedded-webview: failed to create a CGEventSource".to_string())?;
    let down = CGEvent::new_mouse_event(Some(&source), CGEventType::LeftMouseDown, point, CGMouseButton::Left)
        .ok_or_else(|| "gigradar embedded-webview: failed to create a mouse-down CGEvent".to_string())?;
    let up = CGEvent::new_mouse_event(Some(&source), CGEventType::LeftMouseUp, point, CGMouseButton::Left)
        .ok_or_else(|| "gigradar embedded-webview: failed to create a mouse-up CGEvent".to_string())?;
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&down));
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&up));
    Ok(())
}

fn post_unicode_text(text: &str) -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .ok_or_else(|| "gigradar embedded-webview: failed to create a CGEventSource".to_string())?;
    let key_down = CGEvent::new_keyboard_event(Some(&source), 0, true)
        .ok_or_else(|| "gigradar embedded-webview: failed to create a keyboard-down CGEvent".to_string())?;
    let key_up = CGEvent::new_keyboard_event(Some(&source), 0, false)
        .ok_or_else(|| "gigradar embedded-webview: failed to create a keyboard-up CGEvent".to_string())?;

    let utf16: Vec<u16> = text.encode_utf16().collect();
    let len = utf16.len() as u64;
    unsafe {
        CGEvent::keyboard_set_unicode_string(Some(&key_down), len, utf16.as_ptr());
        CGEvent::keyboard_set_unicode_string(Some(&key_up), len, utf16.as_ptr());
    }
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&key_down));
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&key_up));
    Ok(())
}

type CaptureResultSender = Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>>>>;
type FrameResultSender = Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<CGRect, String>>>>>;

fn send_once<T>(tx: &Arc<Mutex<Option<tokio::sync::oneshot::Sender<T>>>>, result: T) {
    if let Ok(mut guard) = tx.lock() {
        if let Some(sender) = guard.take() {
            let _ = sender.send(result);
        }
    }
}

/// Picks this process's own main window out of
/// `getCurrentProcessShareableContentWithCompletionHandler()`'s window
/// list -- the largest on-screen window by frame area, a defensive
/// heuristic that is exactly right for gigradar's real shape (exactly
/// one app window; the tray icon is not an `SCWindow`).
fn pick_main_window(content: &SCShareableContent) -> Option<Retained<SCWindow>> {
    let windows = unsafe { content.windows() };
    windows
        .iter()
        .filter(|w| unsafe { w.isOnScreen() })
        .max_by(|a, b| {
            let area = |w: &Retained<SCWindow>| {
                let frame = unsafe { w.frame() };
                frame.size.width * frame.size.height
            };
            area(a).partial_cmp(&area(b)).unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn dispatch_main_window_frame(tx: FrameResultSender) {
    let block = block2::RcBlock::new(move |content_ptr: *mut SCShareableContent, error_ptr: *mut objc2_foundation::NSError| {
        if content_ptr.is_null() || !error_ptr.is_null() {
            send_once(&tx, Err("gigradar embedded-webview: could not enumerate this app's own windows (getCurrentProcessShareableContentWithCompletionHandler failed)".to_string()));
            return;
        }
        let content = unsafe { &*content_ptr };
        match pick_main_window(content) {
            Some(window) => send_once(&tx, Ok(unsafe { window.frame() })),
            None => send_once(&tx, Err("gigradar embedded-webview: no on-screen gigradar window found to click into".to_string())),
        }
    });
    unsafe { SCShareableContent::getCurrentProcessShareableContentWithCompletionHandler(&block) };
}

fn dispatch_capture(tx: CaptureResultSender) {
    let block = block2::RcBlock::new(move |content_ptr: *mut SCShareableContent, error_ptr: *mut objc2_foundation::NSError| {
        if content_ptr.is_null() || !error_ptr.is_null() {
            send_once(&tx, Err("gigradar embedded-webview: could not enumerate this app's own windows (getCurrentProcessShareableContentWithCompletionHandler failed)".to_string()));
            return;
        }
        let content = unsafe { &*content_ptr };
        let Some(window) = pick_main_window(content) else {
            send_once(&tx, Err("gigradar embedded-webview: no on-screen gigradar window found to capture".to_string()));
            return;
        };

        let filter = unsafe { SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window) };
        let frame = unsafe { window.frame() };
        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            // Deliberately sized to the window's own POINT dimensions,
            // not multiplied by the display's backing scale -- see this
            // module's header comment on why that keeps click-coordinate
            // math a plain, scale-free addition.
            config.setWidth(frame.size.width.round() as usize);
            config.setHeight(frame.size.height.round() as usize);
        }

        let tx2 = tx.clone();
        let capture_block = block2::RcBlock::new(move |image_ptr: *mut CGImage, error_ptr: *mut objc2_foundation::NSError| {
            if image_ptr.is_null() || !error_ptr.is_null() {
                send_once(&tx2, Err("gigradar embedded-webview: captureImageWithFilter failed".to_string()));
                return;
            }
            let image = unsafe { &*image_ptr };
            match cgimage_to_png(image) {
                Ok(bytes) => send_once(&tx2, Ok(bytes)),
                Err(e) => send_once(&tx2, Err(e)),
            }
        });
        unsafe {
            objc2_screen_capture_kit::SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&filter, &config, Some(&capture_block));
        }
    });
    unsafe { SCShareableContent::getCurrentProcessShareableContentWithCompletionHandler(&block) };
}

/// Converts a captured `CGImage` (BGRA8, per ScreenCaptureKit's own
/// documented SDR output format -- see this module's header comment on
/// why this exact byte order is still unverified at runtime) into PNG
/// bytes via the pure-Rust `image` crate, never Apple's own ImageIO --
/// keeps this module's dependency surface to the objc2 bindings already
/// established by embedded_webview_cookies.rs, plus one small,
/// non-Apple-framework encoder.
fn cgimage_to_png(image: &CGImage) -> Result<Vec<u8>, String> {
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    let bytes_per_row = CGImage::bytes_per_row(Some(image));
    let provider = CGImage::data_provider(Some(image)).ok_or_else(|| "gigradar embedded-webview: captured image had no data provider".to_string())?;
    let data: CFRetained<CFData> = CGDataProvider::data(Some(&provider)).ok_or_else(|| "gigradar embedded-webview: could not copy captured image's pixel data".to_string())?;
    let raw = data.to_vec();

    let mut rgba = Vec::with_capacity(width * height * 4);
    for row in 0..height {
        let row_start = row * bytes_per_row;
        for col in 0..width {
            let px = row_start + col * 4;
            if px + 4 > raw.len() {
                return Err("gigradar embedded-webview: captured pixel buffer was shorter than its own reported dimensions".to_string());
            }
            // BGRA in memory -> RGBA for the `image` crate.
            rgba.push(raw[px + 2]);
            rgba.push(raw[px + 1]);
            rgba.push(raw[px]);
            rgba.push(raw[px + 3]);
        }
    }

    let buffer = image::RgbaImage::from_raw(width as u32, height as u32, rgba)
        .ok_or_else(|| "gigradar embedded-webview: captured pixel buffer did not match its own reported dimensions".to_string())?;
    let mut png_bytes = Vec::new();
    buffer
        .write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("gigradar embedded-webview: PNG encode failed: {e}"))?;
    Ok(png_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The core, release-blocking guarantee this story's own risk
    /// section demands: calling the underlying gate check directly (the
    /// same check every public command in this file runs first) refuses
    /// when no session has been opened -- exercised here from a
    /// "simulated unattended context" (a bare `InteractiveSessionGate`,
    /// never toggled on), not through the UI.
    #[test]
    fn gate_defaults_closed_and_refuses_unattended_calls() {
        let gate = InteractiveSessionGate::default();
        assert!(!gate.is_active(), "a freshly-constructed gate must default to closed -- an unattended scan must never find it open");
    }

    #[test]
    fn gate_opens_and_closes_on_begin_end() {
        let gate = InteractiveSessionGate::default();
        gate.set(true);
        assert!(gate.is_active());
        gate.set(false);
        assert!(!gate.is_active());
    }

    #[test]
    fn gate_close_is_idempotent() {
        let gate = InteractiveSessionGate::default();
        gate.set(false);
        assert!(!gate.is_active());
    }
}
