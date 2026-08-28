// tauri-real-auto-update story. Two responsibilities:
//   1. The dev/prod channel preference -- a small sibling file next to
//      gigradar's own data dir (src/lib/store/path.ts's getDefaultDataDir()
//      on the Node side), NOT inside config.json (that's user Config, this
//      is installer-level state -- see this story's own design_decisions).
//      Only the macOS/POSIX + XDG_DATA_HOME branch of path.ts's resolution
//      is mirrored here, matching this epic's macOS-only scope (see
//      scripts/prepare-tauri-sidecars.sh's own scope note) -- add the
//      Windows LOCALAPPDATA branch here too if/when this epic goes
//      cross-platform.
//   2. Building the right update-manifest endpoint for the stored channel
//      and running an update check/install.
//
// Endpoint design (not something Tauri or GitHub Releases hands you for
// free): the PROD endpoint uses GitHub's own "/releases/latest/download/"
// alias, which only resolves non-prerelease tags -- exactly prod's tag
// convention (plain vX.Y.Z, never marked prerelease). Dev-channel tags
// (vX.Y.Z-dev.N) ARE marked prerelease (see tauri-release.yml), so
// GitHub's "/latest" alias never finds them -- there is no GitHub-native
// equivalent for "latest prerelease". The dev endpoint instead points at a
// `latest.json` kept current on a dedicated `dev-manifest` git branch
// (tauri-release.yml pushes to it on every dev-channel publish) served via
// raw.githubusercontent.com -- a plain file the CI workflow overwrites,
// not a moving GitHub Release/tag. The actual signed update bundle the
// manifest points at is still a normal, permanent GitHub Release asset;
// only the "which version is current" pointer needs to be overwritable.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// tauri-update-notification epic: how long a downloaded-and-verified
/// update sits waiting for either an explicit "Restart now" or this
/// timeout before it installs and restarts on its own -- preserves "the
/// ability to auto update" (nothing to click to GET the update) while
/// still giving a real window to notice before a restart happens
/// (owner-confirmed via design-discussion.md's AskUserQuestion gate).
const GRACE_PERIOD: Duration = Duration::from_secs(30 * 60);
/// How much extra time "Snooze 1h" buys, from the moment it's clicked.
const SNOOZE_EXTENSION: Duration = Duration::from_secs(60 * 60);
/// How often the grace-period watcher thread wakes to re-check the
/// deadline -- coarse on purpose (this is a "did 30 minutes pass" check,
/// not a countdown timer; the frontend's own 1s UI tick is separate and
/// unrelated to this).
const GRACE_PERIOD_POLL_INTERVAL: Duration = Duration::from_secs(15);

const APP_DIR_NAME: &str = "gigradar";
const CHANNEL_FILE_NAME: &str = "update-channel.json";

const PROD_ENDPOINT: &str = "https://github.com/mdostal/gigradar/releases/latest/download/latest.json";
const DEV_ENDPOINT: &str =
    "https://raw.githubusercontent.com/mdostal/gigradar/dev-manifest/latest.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Dev,
    Prod,
}

impl Channel {
    fn toggled(self) -> Self {
        match self {
            Channel::Dev => Channel::Prod,
            Channel::Prod => Channel::Dev,
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Channel::Dev => DEV_ENDPOINT,
            Channel::Prod => PROD_ENDPOINT,
        }
    }

    fn menu_label(self) -> String {
        format!("Update channel: {} (click to switch)", match self {
            Channel::Dev => "Dev",
            Channel::Prod => "Prod",
        })
    }
}

#[derive(Serialize, Deserialize)]
struct ChannelFile {
    channel: Channel,
}

/// Mirrors src/lib/store/path.ts's getDefaultDataDir() POSIX branch:
/// `$XDG_DATA_HOME/gigradar` if set, else `~/.local/share/gigradar`. The
/// channel file lives directly in that directory, a sibling of gigs.db.
fn data_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.trim().is_empty() {
            return PathBuf::from(xdg).join(APP_DIR_NAME);
        }
    }
    let home = std::env::var("HOME").expect("gigradar: $HOME is not set");
    PathBuf::from(home).join(".local").join("share").join(APP_DIR_NAME)
}

fn channel_file_path() -> PathBuf {
    data_dir().join(CHANNEL_FILE_NAME)
}

/// Missing/corrupt file => Prod -- the safer default (see this story's own
/// design_decisions: "the safer default for anyone who installs this who
/// isn't the owner actively testing").
pub fn read_channel() -> Channel {
    let path = channel_file_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return Channel::Prod;
    };
    serde_json::from_str::<ChannelFile>(&raw)
        .map(|f| f.channel)
        .unwrap_or(Channel::Prod)
}

fn write_channel(channel: Channel) -> std::io::Result<()> {
    let path = channel_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let contents = serde_json::to_string_pretty(&ChannelFile { channel }).expect("serialize ChannelFile");
    fs::write(path, contents)
}

/// tauri-update-notification epic: the update lifecycle surfaced to the
/// webview via a `gigradar://update-status` event (see `set_status()`
/// below), and readable on demand via the `get_update_status` command for
/// a listener that attaches AFTER a transition already happened (a late
/// page load/navigation must not miss an already-ready update). Internally
/// tagged (`tag = "status"`) so the JS side gets a plain
/// `{status: "Available", version: "..."}`-shaped object, no separate
/// discriminant field to cross-reference.
///
/// `deadline_ms` (ReadyToInstall only) is epoch milliseconds, not an ISO
/// string -- `new Date(deadline_ms)` on the JS side is simpler than adding
/// a date-formatting crate here for one field.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status")]
pub enum UpdateStatus {
    Checking,
    Available { version: String },
    Downloading,
    ReadyToInstall { version: String, deadline_ms: u64 },
    UpToDate,
    Error { message: String },
}

fn epoch_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A verified, downloaded-but-not-yet-installed update, plus the deadline
/// its grace period expires at. Holding the already-downloaded `bytes`
/// here (not re-fetched) is what makes `install_update`/the grace-period
/// timeout instant -- no second network round trip.
type PendingUpdate = (Update, Vec<u8>, SystemTime);

/// Managed Tauri state (`app.manage(UpdateState::default())`, see lib.rs).
/// `current` is the single source of truth `get_update_status` reads and
/// `set_status()` writes -- kept in lockstep with the last-emitted event
/// so a late listener and a fresh `invoke()` never disagree.
#[derive(Default)]
pub struct UpdateState {
    current: Mutex<UpdateStatus>,
    pending: Mutex<Option<PendingUpdate>>,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        UpdateStatus::Checking
    }
}

/// The one place `UpdateState.current` is written AND the event is
/// emitted -- so "what get_update_status returns" and "what the last
/// gigradar://update-status event said" can never drift apart (see
/// UpdateState's own doc comment).
fn set_status(app: &AppHandle, status: UpdateStatus) {
    *app.state::<UpdateState>().current.lock().expect("gigradar: update state mutex poisoned") = status.clone();
    if let Err(err) = app.emit("gigradar://update-status", status) {
        log::error!("gigradar: failed to emit update-status event: {err}");
    }
}

/// Checks the CURRENT channel's endpoint for an update. If one exists, it
/// is downloaded (verified) immediately -- "the ability to auto update"
/// needs nothing clicked to fetch the bytes -- but installing/restarting
/// now waits for either the `install_update` command or the grace-period
/// watcher's timeout, instead of happening inline here. A "no update
/// available" result is not an error -- emitted as UpToDate, same
/// "nothing went wrong" status as before this story, just now observable.
pub async fn check_for_updates(app: AppHandle) -> tauri_plugin_updater::Result<()> {
    let channel = read_channel();
    log::info!("gigradar: checking for updates on the {:?} channel", channel);
    set_status(&app, UpdateStatus::Checking);

    let updater = app.updater_builder().endpoints(vec![channel.endpoint().parse().expect("valid endpoint URL")])?.build()?;

    match updater.check().await? {
        Some(update) => {
            log::info!(
                "gigradar: update {} -> {} available, downloading",
                update.current_version,
                update.version
            );
            set_status(&app, UpdateStatus::Available { version: update.version.clone() });
            set_status(&app, UpdateStatus::Downloading);

            let bytes = match update
                .download(|_chunk_len, _content_len| {}, || log::info!("gigradar: update download finished"))
                .await
            {
                Ok(bytes) => bytes,
                Err(err) => {
                    log::error!("gigradar: update download failed: {err}");
                    set_status(&app, UpdateStatus::Error { message: err.to_string() });
                    return Err(err);
                }
            };

            let deadline = SystemTime::now() + GRACE_PERIOD;
            let version = update.version.clone();
            *app.state::<UpdateState>().pending.lock().expect("gigradar: update state mutex poisoned") =
                Some((update, bytes, deadline));
            set_status(&app, UpdateStatus::ReadyToInstall { version, deadline_ms: epoch_ms(deadline) });
            spawn_grace_period_watcher(app.clone());
        }
        None => {
            log::info!("gigradar: no update available on the {:?} channel", channel);
            set_status(&app, UpdateStatus::UpToDate);
        }
    }
    Ok(())
}

/// Polls (coarse, see GRACE_PERIOD_POLL_INTERVAL) whether the currently
/// pending update's deadline has passed, installing and restarting if so.
/// Reads the deadline FRESH from shared state on every wake -- a "Snooze
/// 1h" click extends it in place (see `snooze_update` below), which this
/// loop picks up on its next tick rather than installing on the original
/// schedule. Exits quietly (no restart) if `pending` is ever None on wake
/// -- either `install_update` already consumed it, or a later
/// check_for_updates() call replaced it with a fresh watcher of its own.
fn spawn_grace_period_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(GRACE_PERIOD_POLL_INTERVAL);

        let state = app.state::<UpdateState>();
        let due = {
            let guard = state.pending.lock().expect("gigradar: update state mutex poisoned");
            match &*guard {
                Some((_, _, deadline)) => SystemTime::now() >= *deadline,
                None => return,
            }
        };
        if !due {
            continue;
        }

        let pending = state.pending.lock().expect("gigradar: update state mutex poisoned").take();
        if let Some((update, bytes, _deadline)) = pending {
            log::info!("gigradar: update grace period elapsed, installing and restarting");
            if let Err(err) = update.install(bytes) {
                log::error!("gigradar: grace-period auto-install failed: {err}");
                set_status(&app, UpdateStatus::Error { message: err.to_string() });
                return;
            }
            app.restart();
        }
        return;
    });
}

/// Installs the already-downloaded pending update immediately and restarts
/// -- the "Restart now" button's command. Returns an error (surfaced to
/// the frontend, not silently swallowed) if there's nothing pending, e.g.
/// a stale toast the user clicked after a grace-period auto-install
/// already happened.
#[tauri::command]
pub fn install_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let pending = state.pending.lock().expect("gigradar: update state mutex poisoned").take();
    let Some((update, bytes, _deadline)) = pending else {
        return Err("gigradar: no update is ready to install".to_string());
    };
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

/// Extends the pending update's grace-period deadline by SNOOZE_EXTENSION
/// from now -- the "Snooze 1h" button's command. A no-op (not an error) if
/// there's nothing pending -- same "stale toast" case as install_update
/// above, but snoozing nothing is harmless, not worth surfacing as a
/// frontend-visible error.
#[tauri::command]
pub fn snooze_update(app: AppHandle, state: State<'_, UpdateState>) {
    let mut guard = state.pending.lock().expect("gigradar: update state mutex poisoned");
    let Some((update, bytes, _old_deadline)) = guard.take() else {
        return;
    };
    let new_deadline = SystemTime::now() + SNOOZE_EXTENSION;
    let version = update.version.clone();
    *guard = Some((update, bytes, new_deadline));
    drop(guard);
    log::info!("gigradar: update snoozed until {:?}", new_deadline);
    set_status(&app, UpdateStatus::ReadyToInstall { version, deadline_ms: epoch_ms(new_deadline) });
}

/// Reads the current lifecycle status without waiting for a future event
/// -- what a freshly-mounted `UpdateNotifier` calls once on mount so a
/// late listener recovers an already-ready update instead of missing it.
#[tauri::command]
pub fn get_update_status(state: State<'_, UpdateState>) -> UpdateStatus {
    state.current.lock().expect("gigradar: update state mutex poisoned").clone()
}

/// Reads the current update channel as a lowercase string ("dev"/"prod")
/// for the Config version/channel readout (config-version-channel-readout
/// story) -- a thin wrapper so that story doesn't need its own copy of
/// read_channel()'s file-read logic.
#[tauri::command]
pub fn get_update_channel() -> String {
    match read_channel() {
        Channel::Dev => "dev".to_string(),
        Channel::Prod => "prod".to_string(),
    }
}

/// Flips the stored channel, persists it, and updates the tray menu
/// item's label in place -- called from the "toggle-channel" menu-event
/// handler in lib.rs.
pub fn toggle_channel(toggle_item: &MenuItem<tauri::Wry>) {
    let next = read_channel().toggled();
    if let Err(err) = write_channel(next) {
        log::error!("gigradar: failed to persist update channel: {err}");
        return;
    }
    if let Err(err) = toggle_item.set_text(next.menu_label()) {
        log::error!("gigradar: failed to update channel menu label: {err}");
    }
    log::info!("gigradar: update channel switched to {:?}", next);
}

pub fn initial_menu_label() -> String {
    read_channel().menu_label()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact JSON shape UpdateNotifier (frontend-update-notifier
    /// story) matches against -- internally tagged on "status", unit
    /// variants serialize to just the tag, struct variants add their
    /// fields alongside it.
    #[test]
    fn update_status_serializes_to_the_shape_the_frontend_expects() {
        assert_eq!(
            serde_json::to_string(&UpdateStatus::Checking).unwrap(),
            r#"{"status":"Checking"}"#
        );
        assert_eq!(
            serde_json::to_string(&UpdateStatus::UpToDate).unwrap(),
            r#"{"status":"UpToDate"}"#
        );
        assert_eq!(
            serde_json::to_string(&UpdateStatus::Available { version: "0.28.0".to_string() }).unwrap(),
            r#"{"status":"Available","version":"0.28.0"}"#
        );
        assert_eq!(
            serde_json::to_string(&UpdateStatus::ReadyToInstall { version: "0.28.0".to_string(), deadline_ms: 1_700_000_000_000 })
                .unwrap(),
            r#"{"status":"ReadyToInstall","version":"0.28.0","deadline_ms":1700000000000}"#
        );
    }

    /// epoch_ms() is what deadline_ms above is built from -- a real
    /// (not mocked) SystemTime round-trip, since this is the one place a
    /// unit mismatch (seconds vs. millis) would silently produce a
    /// deadline 1000x too soon or too far out.
    #[test]
    fn epoch_ms_round_trips_a_known_duration_since_unix_epoch() {
        let one_hour_after_epoch = UNIX_EPOCH + Duration::from_secs(3600);
        assert_eq!(epoch_ms(one_hour_after_epoch), 3_600_000);
    }

    #[test]
    fn epoch_ms_of_now_is_a_plausible_recent_timestamp() {
        // Sanity bound, not a mock: any real `now` is well past 2024-01-01
        // (1704067200000ms) and well before 2100-01-01 -- catches a
        // seconds/millis unit bug without pinning an exact value.
        let ms = epoch_ms(SystemTime::now());
        assert!(ms > 1_704_067_200_000, "epoch_ms(now) looks too small: {ms}");
        assert!(ms < 4_102_444_800_000, "epoch_ms(now) looks too large: {ms}");
    }
}
