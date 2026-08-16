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
use tauri::menu::MenuItem;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

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

/// Checks the CURRENT channel's endpoint for an update and, if one exists,
/// downloads and installs it, then restarts the app. A "no update
/// available" result is not an error -- logged at info level and returned
/// as Ok(()), same as a real update successfully applied.
pub async fn check_for_updates(app: AppHandle) -> tauri_plugin_updater::Result<()> {
    let channel = read_channel();
    log::info!("gigradar: checking for updates on the {:?} channel", channel);

    let updater = app.updater_builder().endpoints(vec![channel.endpoint().parse().expect("valid endpoint URL")])?.build()?;

    match updater.check().await? {
        Some(update) => {
            log::info!(
                "gigradar: update {} -> {} available, downloading",
                update.current_version,
                update.version
            );
            update
                .download_and_install(
                    |_chunk_len, _content_len| {},
                    || log::info!("gigradar: update download finished"),
                )
                .await?;
            log::info!("gigradar: update installed, restarting");
            app.restart();
        }
        None => {
            log::info!("gigradar: no update available on the {:?} channel", channel);
        }
    }
    Ok(())
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
