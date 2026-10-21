//! Where Forge keeps things. Everything lives under the user's home: never /tmp.

use std::path::PathBuf;

pub fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Directory of the runtime ASAR. Linux/macOS: `$XDG_CONFIG_HOME/Vencord` (as the shell
/// installer); Windows: `%APPDATA%\Vencord\runtime`, beside Vencord's own settings directory.
/// The in-app updater follows wherever the runtime is, so this only matters at install time.
pub fn runtime_dir() -> PathBuf {
    if cfg!(windows) {
        return env_dir("APPDATA").unwrap_or_else(|| home().join("AppData/Roaming")).join("Vencord").join("runtime");
    }
    env_dir("XDG_CONFIG_HOME").unwrap_or_else(|| home().join(".config")).join("Vencord")
}

/// Persistent state such as the last upstream commit that built successfully.
pub fn state_dir(distribution: &str) -> PathBuf {
    if cfg!(windows) {
        return env_dir("LOCALAPPDATA").unwrap_or_else(|| home().join("AppData/Local")).join("VencordForge").join(distribution);
    }
    env_dir("XDG_DATA_HOME").unwrap_or_else(|| home().join(".local/share")).join(distribution)
}

/// Build workspaces, downloads and the managed Node.js toolchain.
pub fn cache_dir() -> PathBuf {
    if cfg!(windows) {
        return env_dir("LOCALAPPDATA").unwrap_or_else(|| home().join("AppData/Local")).join("VencordForge").join("cache");
    }
    env_dir("XDG_CACHE_HOME").unwrap_or_else(|| home().join(".cache")).join("vencord-forge")
}
