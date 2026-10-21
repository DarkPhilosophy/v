//! Find Discord installations: all four channels (Stable, PTB, Canary, Development) on Linux
//! (native packages and Flatpak), Windows and macOS. Port of `scripts/detect-discord.py`, extended
//! to Windows and macOS.

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::asar;
use crate::bootstrap::{BootstrapKind, Resources};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum Channel {
    Stable,
    Ptb,
    Canary,
    Development,
}

impl Channel {
    pub const ALL: [Channel; 4] = [Channel::Stable, Channel::Ptb, Channel::Canary, Channel::Development];

    pub fn label(self) -> &'static str {
        match self {
            Self::Stable => "Discord",
            Self::Ptb => "Discord PTB",
            Self::Canary => "Discord Canary",
            Self::Development => "Discord Development",
        }
    }

    /// Directory names used by native packages and the Windows installer.
    fn dir_names(self) -> &'static [&'static str] {
        match self {
            Self::Stable => &["Discord", "discord"],
            Self::Ptb => &["DiscordPTB", "discordptb", "discord-ptb"],
            Self::Canary => &["DiscordCanary", "discordcanary", "discord-canary"],
            Self::Development => &["DiscordDevelopment", "discorddevelopment", "discord-development"],
        }
    }

    pub fn flatpak_id(self) -> &'static str {
        match self {
            Self::Stable => "com.discordapp.Discord",
            Self::Ptb => "com.discordapp.DiscordPTB",
            Self::Canary => "com.discordapp.DiscordCanary",
            Self::Development => "com.discordapp.DiscordDevelopment",
        }
    }

    fn mac_app(self) -> &'static str {
        match self {
            Self::Stable => "Discord.app",
            Self::Ptb => "Discord PTB.app",
            Self::Canary => "Discord Canary.app",
            Self::Development => "Discord Development.app",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum InstallKind {
    Native,
    Flatpak,
    Windows,
    MacOs,
}

#[derive(Clone, Debug, Serialize)]
pub struct Install {
    pub channel: Channel,
    pub kind: InstallKind,
    pub resources: PathBuf,
    pub version: Option<String>,
    pub flatpak_id: Option<String>,
    /// `None`: stock Discord. Otherwise the bootstrap that `_app.asar` holds.
    pub modded: Option<BootstrapKind>,
    pub writable: bool,
}

impl Install {
    pub fn title(&self) -> String {
        let kind = match self.kind {
            InstallKind::Flatpak => " (Flatpak)",
            _ => "",
        };
        format!("{}{kind}", self.channel.label())
    }
}

/// Roots that detection scans; overridable so tests can use a fake filesystem.
#[derive(Clone, Debug, Default)]
pub struct Roots {
    pub home: PathBuf,
    /// Filesystem root for system locations (`/` normally).
    pub root: PathBuf,
    pub config_home: Option<PathBuf>,
    pub data_home: Option<PathBuf>,
    /// `%LOCALAPPDATA%` on Windows.
    pub local_app_data: Option<PathBuf>,
}

impl Roots {
    pub fn from_env() -> Self {
        let home = crate::paths::home();
        Self {
            root: if cfg!(windows) { PathBuf::new() } else { PathBuf::from("/") },
            config_home: std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()).map(PathBuf::from),
            data_home: std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()).map(PathBuf::from),
            local_app_data: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
            home,
        }
    }
}

fn is_discord_resources(dir: &Path) -> bool {
    ["app.asar", "_app.asar"].iter().any(|n| asar::discord_package(&dir.join(n)).is_some())
}

fn version_key(name: &str) -> (Vec<u64>, String) {
    let numbers = name.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect();
    (numbers, name.to_owned())
}

/// `<base>/app-<version>/resources` (newest) or `<base>/resources`.
fn resources_in_base(base: &Path) -> Option<(PathBuf, Option<String>)> {
    let mut versioned: Vec<(PathBuf, String)> = fs::read_dir(base)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            (name.starts_with("app-") && e.path().join("resources").is_dir()).then(|| (e.path().join("resources"), name))
        })
        .filter(|(r, _)| is_discord_resources(r))
        .collect();
    versioned.sort_by_key(|(_, name)| version_key(name));
    if let Some((resources, name)) = versioned.pop() {
        return Some((resources, Some(name.trim_start_matches("app-").to_owned())));
    }
    let resources = base.join("resources");
    is_discord_resources(&resources).then_some((resources, None))
}

fn package_version(resources: &Path) -> Option<String> {
    ["_app.asar", "app.asar"]
        .iter()
        .find_map(|n| asar::discord_package(&resources.join(n)))
        .and_then(|p| p.get("version").and_then(|v| v.as_str()).map(str::to_owned))
}

pub fn discover(roots: &Roots) -> Vec<Install> {
    let mut found: BTreeMap<PathBuf, Install> = BTreeMap::new();
    let mut add = |channel: Channel, kind: InstallKind, base: &Path, flatpak_id: Option<&str>| {
        let Some((resources, version)) = resources_in_base(base) else { return };
        // system-electron packages (app.asar.unpacked next to a loose app.asar) are not supported.
        let canonical = fs::canonicalize(&resources).unwrap_or(resources);
        let state = Resources::new(&canonical).ok().and_then(|r| r.state());
        found.entry(canonical.clone()).or_insert_with(|| Install {
            channel,
            kind,
            version: version.or_else(|| package_version(&canonical)),
            flatpak_id: flatpak_id.map(str::to_owned),
            modded: state,
            writable: crate::fsutil::is_writable_dir(&canonical),
            resources: canonical,
        });
    };

    let home = &roots.home;
    for channel in Channel::ALL {
        if let Some(local) = &roots.local_app_data {
            for name in channel.dir_names() {
                add(channel, InstallKind::Windows, &local.join(name), None);
            }
        }
        if cfg!(target_os = "macos") || roots.local_app_data.is_none() {
            for apps in [roots.root.join("Applications"), home.join("Applications")] {
                add(channel, InstallKind::MacOs, &apps.join(channel.mac_app()).join("Contents"), None);
            }
        }
        if cfg!(windows) {
            continue;
        }
        let config_home = roots.config_home.clone().unwrap_or_else(|| home.join(".config"));
        let data_home = roots.data_home.clone().unwrap_or_else(|| home.join(".local/share"));
        let native_roots = [
            roots.root.join("usr/share"),
            roots.root.join("usr/lib"),
            roots.root.join("usr/lib64"),
            roots.root.join("opt"),
            data_home.clone(),
            home.join(".dvm"),
            config_home,
        ];
        for dir in &native_roots {
            for name in channel.dir_names() {
                add(channel, InstallKind::Native, &dir.join(name), None);
            }
        }
        let id = channel.flatpak_id();
        for base in [
            roots.root.join("var/lib/flatpak/app").join(id).join("current/active/files/discord"),
            data_home.join("flatpak/app").join(id).join("current/active/files/discord"),
        ] {
            add(channel, InstallKind::Flatpak, &base, Some(id));
        }
        let suffix = id.trim_start_matches("com.discordapp.").to_lowercase();
        add(channel, InstallKind::Flatpak, &home.join(".var/app").join(id).join("config").join(suffix), Some(id));
    }
    let mut list: Vec<Install> = found.into_values().collect();
    // Like scripts/detect-discord.py: a Flatpak app's packaged `files/discord/resources` is what
    // runs; a copy under its config dir (`app-*`) is a leftover of Discord's own updater.
    let packaged: Vec<String> = list.iter().filter(|i| i.kind == InstallKind::Flatpak && i.resources.ends_with("files/discord/resources")).filter_map(|i| i.flatpak_id.clone()).collect();
    list.retain(|i| i.kind != InstallKind::Flatpak || i.resources.ends_with("files/discord/resources") || !i.flatpak_id.as_ref().is_some_and(|id| packaged.contains(id)));
    list.sort_by(|a, b| (a.channel, a.resources.clone()).cmp(&(b.channel, b.resources.clone())));
    list
}

/// Accept a Discord install dir, its `resources/` dir, or its `app.asar`.
pub fn from_path(path: &Path) -> anyhow::Result<PathBuf> {
    let path = if path.file_name().is_some_and(|n| n == "app.asar") && path.is_file() { path.parent().unwrap() } else { path };
    for candidate in [path.join("resources"), path.to_owned()] {
        if is_discord_resources(&candidate) {
            return Ok(candidate);
        }
    }
    if let Some((resources, _)) = resources_in_base(path) {
        return Ok(resources);
    }
    anyhow::bail!("not a Discord installation or resources directory: {}", path.display())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn discord_asar(resources: &Path) {
        fs::create_dir_all(resources).unwrap();
        let mut files = BTreeMap::new();
        files.insert("package.json".to_owned(), br#"{"name":"discord","main":"index.js","version":"1.0.0"}"#.to_vec());
        files.insert("index.js".to_owned(), b"module.exports = 1;".to_vec());
        crate::asar::pack_files(&files, &resources.join("app.asar")).unwrap();
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/test-scratch").join(format!("detect-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_all_four_native_channels_and_newest_app_dir() {
        let root = scratch("native");
        let home = root.join("home");
        for name in ["discord", "discordptb", "discordcanary", "discorddevelopment"] {
            discord_asar(&home.join(".config").join(name).join("app-1.0.9/resources"));
            discord_asar(&home.join(".config").join(name).join("app-1.0.10/resources"));
        }
        let found = discover(&Roots { home, root: root.join("sys"), ..Default::default() });
        assert_eq!(found.iter().map(|i| i.channel).collect::<Vec<_>>(), Channel::ALL.to_vec());
        assert!(found.iter().all(|i| i.resources.parent().unwrap().ends_with("app-1.0.10")), "{found:#?}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn flatpak_prefers_packaged_resources_over_updater_copy() {
        let root = scratch("flatpak");
        let home = root.join("home");
        let sys = root.join("sys");
        discord_asar(&sys.join("var/lib/flatpak/app/com.discordapp.Discord/current/active/files/discord/resources"));
        discord_asar(&home.join(".var/app/com.discordapp.Discord/config/discord/app-1.0.139/resources"));
        let found = discover(&Roots { home, root: sys, ..Default::default() });
        assert_eq!(found.len(), 1, "{found:#?}");
        assert!(found[0].resources.ends_with("files/discord/resources"));
        assert_eq!(found[0].flatpak_id.as_deref(), Some("com.discordapp.Discord"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn windows_local_app_data_layout() {
        let root = scratch("windows");
        let local = root.join("Local");
        discord_asar(&local.join("Discord/app-1.0.9200/resources"));
        discord_asar(&local.join("DiscordCanary/app-1.0.700/resources"));
        discord_asar(&local.join("DiscordCanary/app-1.0.701/resources"));
        let found = discover(&Roots { home: root.join("home"), root: root.join("sys"), local_app_data: Some(local), ..Default::default() });
        let windows: Vec<_> = found.iter().filter(|i| i.kind == InstallKind::Windows).collect();
        assert_eq!(windows.len(), 2, "{found:#?}");
        assert_eq!(windows[1].channel, Channel::Canary);
        assert_eq!(windows[1].version.as_deref(), Some("1.0.701"));
        let _ = fs::remove_dir_all(root);
    }
}
