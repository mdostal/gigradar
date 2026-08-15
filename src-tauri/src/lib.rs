// tauri-installer epic, tauri-bare-packaged-app story. Mirrors
// electron/main.ts's own discipline exactly: server code never runs in
// this process's own runtime — this only spawns a REAL Node process (a
// bundled sidecar binary, not the system's Node) running gigradar's
// already-built standalone server, polls it for real readiness, and only
// then creates a window pointed at it. No window exists before the
// server is confirmed ready — same as electron/main.ts, not a "loading
// screen that navigates later" pattern, to keep this story's own scope
// minimal (see structured-outline.md's elicitation notes).
use std::net::TcpStream;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

mod updater;

const SERVER_HOST: &str = "127.0.0.1";
const SERVER_PORT: &str = "3000";
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(300);

/// True once a TCP connect to the server port succeeds — a simple,
/// dependency-free readiness signal (no HTTP client needed just to poll),
/// sufficient because the standalone Next.js server only starts listening
/// once it's genuinely ready to serve, same assumption
/// electron/server-ready.ts's own HTTP-probe already relied on.
fn wait_for_server_ready() -> Result<(), String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    let addr = format!("{SERVER_HOST}:{SERVER_PORT}");
    while Instant::now() < deadline {
        if TcpStream::connect(&addr).is_ok() {
            return Ok(());
        }
        std::thread::sleep(READY_POLL_INTERVAL);
    }
    Err(format!(
        "gigradar server did not become ready at {addr} within {:?}",
        READY_TIMEOUT
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // tauri-real-auto-update story: a native tray menu, not a
            // Next.js page (see updater.rs's own header comment for why).
            // "Check for Updates" triggers a manual check; the channel
            // item's own label IS the toggle ("Update channel: Prod
            // (click to switch)") and updates in place via
            // updater::toggle_channel(); Quit exits the whole app,
            // including the bundled Node sidecar (Tauri kills child
            // processes on app.exit() by default).
            let check_updates_item =
                MenuItem::with_id(app, "check-updates", "Check for Updates", true, None::<&str>)?;
            let toggle_channel_item = MenuItem::with_id(
                app,
                "toggle-channel",
                updater::initial_menu_label(),
                true,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[
                    &check_updates_item,
                    &toggle_channel_item,
                    &PredefinedMenuItem::separator(app)?,
                    &quit_item,
                ],
            )?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("gigradar: no default window icon set").clone())
                .menu(&tray_menu)
                .tooltip("gigradar")
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "check-updates" => {
                        let app_handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(err) = updater::check_for_updates(app_handle).await {
                                log::error!("gigradar: update check failed: {err}");
                            }
                        });
                    }
                    "toggle-channel" => updater::toggle_channel(&toggle_channel_item),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Resolve the bundled server entrypoint's real on-disk path
            // (a Tauri "resource", staged by scripts/prepare-tauri-sidecars.sh
            // into src-tauri/resources/server/, declared in tauri.conf.json's
            // bundle.resources) before spawning the sidecar.
            let resource_dir = app
                .path()
                .resource_dir()
                .expect("gigradar: could not resolve the app's resource directory");
            let server_entry = resource_dir.join("resources/server/server.js");
            // tauri-chromium-sidecar story: PLAYWRIGHT_BROWSERS_PATH is
            // transparently respected by chromium.launch()/executablePath()
            // with ZERO code change needed in browser-session.ts (live-
            // verified this story) -- just point it at the bundled browser.
            let browsers_dir = resource_dir.join("resources/playwright-browsers");

            let sidecar = app
                .shell()
                .sidecar("node")
                .expect("gigradar: bundled node sidecar not found — did scripts/prepare-tauri-sidecars.sh run?")
                .args([server_entry.to_string_lossy().to_string()])
                .env("NODE_OPTIONS", "--experimental-sqlite")
                .env("PLAYWRIGHT_BROWSERS_PATH", browsers_dir.to_string_lossy().to_string())
                .env("PORT", SERVER_PORT);

            let (mut rx, _child) = sidecar
                .spawn()
                .expect("gigradar: failed to spawn the bundled node sidecar");

            // Mirror the spawned server's own stdout/stderr into this
            // process's log output (same "the terminal shows the server's
            // normal logs" convention electron/main.ts's own comment
            // documents) — spawned on a background thread so it never
            // blocks the readiness wait below.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            log::info!("[server] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            log::warn!("[server] {}", String::from_utf8_lossy(&line));
                        }
                        _ => {}
                    }
                }
            });

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                match wait_for_server_ready() {
                    Ok(()) => {
                        let url = format!("http://{SERVER_HOST}:{SERVER_PORT}");
                        WebviewWindowBuilder::new(
                            &app_handle,
                            "main",
                            WebviewUrl::External(url.parse().expect("gigradar: invalid server URL")),
                        )
                        .title("gigradar")
                        .inner_size(1280.0, 860.0)
                        .build()
                        .expect("gigradar: failed to create the main window");

                        // Launch-time update check (acceptance criteria:
                        // "checks for updates on launch and via a manual
                        // trigger") -- non-blocking, never delays the
                        // window that's already up by this point.
                        let update_check_handle = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(err) = updater::check_for_updates(update_check_handle).await {
                                log::error!("gigradar: launch-time update check failed: {err}");
                            }
                        });
                    }
                    Err(message) => {
                        log::error!("gigradar: {message}");
                        // A minimal, dependency-free failure surface for this
                        // story's own scope (matches electron/main.ts's fatal
                        // dialog in SPIRIT, not byte-for-byte — a native error
                        // dialog is a later-story polish item, not blocking
                        // this story's own "does the app even launch" bar).
                        eprintln!("gigradar: {message}");
                        std::process::exit(1);
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
