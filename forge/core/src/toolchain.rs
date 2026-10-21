//! Node.js and pnpm for building Vencord. A suitable system Node.js is used when present;
//! otherwise an official Node.js build is downloaded (checksum-verified) into Forge's cache.
//! pnpm is always the exact version Vencord pins (`packageManager`), fetched from the npm
//! registry and run as `node pnpm.cjs`, which avoids Windows `.cmd` shims entirely.

use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::{net, paths};

#[derive(Clone, Debug)]
pub struct Toolchain {
    pub node: PathBuf,
    pub node_version: String,
    pub pnpm_entry: PathBuf,
    pub managed_node: bool,
}

impl Toolchain {
    /// PATH with this Node.js first, so scripts that spawn `node` use the same one.
    pub fn path_env(&self) -> OsString {
        let mut dirs = vec![self.node.parent().unwrap().to_owned()];
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        std::env::join_paths(dirs).unwrap_or_default()
    }

    pub fn pnpm(&self, cwd: &Path) -> Command {
        let mut command = Command::new(&self.node);
        command.arg(&self.pnpm_entry).current_dir(cwd).env("PATH", self.path_env());
        crate::process::hide_window(&mut command);
        command
    }

    pub fn node_cmd(&self, cwd: &Path) -> Command {
        let mut command = Command::new(&self.node);
        command.current_dir(cwd).env("PATH", self.path_env());
        crate::process::hide_window(&mut command);
        command
    }
}

pub fn which(name: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or(".EXE;.CMD;.BAT".into()).split(';').map(|e| e.to_lowercase()).collect()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        exts.iter().map(|ext| dir.join(format!("{name}{ext}"))).find(|p| p.is_file())
    })
}

fn node_version(node: &Path) -> Option<String> {
    let mut command = Command::new(node);
    command.arg("--version");
    crate::process::hide_window(&mut command);
    let out = command.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().trim_start_matches('v').to_owned())
}

fn major(version: &str) -> u32 {
    version.split('.').next().and_then(|m| m.parse().ok()).unwrap_or(0)
}

/// Minimum Node.js major from `engines.node` such as `>=22` (defaults to 22).
pub fn required_node_major(package: &Value) -> u32 {
    package["engines"]["node"].as_str().and_then(|s| s.trim_start_matches(">=").trim().split('.').next()?.parse().ok()).unwrap_or(22)
}

/// pnpm version from `packageManager: "pnpm@11.9.0+sha..."`.
pub fn required_pnpm(package: &Value) -> Result<String> {
    let spec = package["packageManager"].as_str().context("package.json has no packageManager")?;
    let version = spec.strip_prefix("pnpm@").context("packageManager is not pnpm")?;
    Ok(version.split('+').next().unwrap().to_owned())
}

fn platform_asset(version: &str) -> Result<(String, bool)> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => bail!("no Node.js build for architecture {other}"),
    };
    Ok(match std::env::consts::OS {
        "windows" => (format!("node-v{version}-win-{arch}.zip"), true),
        "linux" => (format!("node-v{version}-linux-{arch}.tar.gz"), false),
        "macos" => (format!("node-v{version}-darwin-{arch}.tar.gz"), false),
        other => bail!("no Node.js build for {other}"),
    })
}

fn managed_node(min_major: u32, log: &mut dyn FnMut(String)) -> Result<(PathBuf, String)> {
    let root = paths::cache_dir().join("node");
    // Reuse a previous download when it is new enough.
    if let Ok(entries) = fs::read_dir(&root) {
        let mut versions: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|v| major(v) >= min_major).collect();
        versions.sort_by_key(|v| v.split('.').map(|p| p.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>());
        if let Some(version) = versions.pop() {
            let node = node_binary(&root.join(&version));
            if node.is_file() {
                return Ok((node, version));
            }
        }
    }
    let index: Value = serde_json::from_str(&net::get_text("https://nodejs.org/dist/index.json")?)?;
    let version = index
        .as_array()
        .context("bad Node.js index")?
        .iter()
        .filter(|r| r["lts"].is_string())
        .filter_map(|r| r["version"].as_str())
        .map(|v| v.trim_start_matches('v').to_owned())
        .find(|v| major(v) >= min_major)
        .context("no Node.js LTS release satisfies the requirement")?;
    let (asset, is_zip) = platform_asset(&version)?;
    let base = format!("https://nodejs.org/dist/v{version}");
    let sums = net::get_text(&format!("{base}/SHASUMS256.txt"))?;
    let expected = sums.lines().find_map(|l| l.strip_suffix(&format!("  {asset}"))).context("Node.js checksum not published")?.to_owned();
    fs::create_dir_all(&root)?;
    let archive = root.join(&asset);
    log(format!("Downloading Node.js {version}"));
    net::download(&format!("{base}/{asset}"), &archive, &mut |_, _| {})?;
    let actual = crate::asar::sha256_hex(&fs::read(&archive)?);
    ensure!(actual == expected, "Node.js download checksum mismatch");
    let staging = root.join(format!(".{version}.partial"));
    crate::fsutil::remove_dir(&staging)?;
    if is_zip { net::extract_zip(&archive, &staging)? } else { net::extract_tar_gz(&archive, &staging)? }
    let final_dir = root.join(&version);
    crate::fsutil::remove_dir(&final_dir)?;
    fs::rename(&staging, &final_dir)?;
    let _ = fs::remove_file(&archive);
    Ok((node_binary(&final_dir), version))
}

fn node_binary(dir: &Path) -> PathBuf {
    if cfg!(windows) { dir.join("node.exe") } else { dir.join("bin/node") }
}

fn pnpm_entry(version: &str, log: &mut dyn FnMut(String)) -> Result<PathBuf> {
    let dir = paths::cache_dir().join("pnpm").join(version);
    let manifest = dir.join("package.json");
    if !manifest.is_file() {
        log(format!("Downloading pnpm {version}"));
        let meta: Value = serde_json::from_str(&net::get_text(&format!("https://registry.npmjs.org/pnpm/{version}"))?)?;
        let url = meta["dist"]["tarball"].as_str().context("pnpm tarball missing")?;
        let integrity = meta["dist"]["integrity"].as_str().unwrap_or_default().to_owned();
        let archive = paths::cache_dir().join(format!("pnpm-{version}.tgz"));
        fs::create_dir_all(paths::cache_dir())?;
        net::download(url, &archive, &mut |_, _| {})?;
        if let Some(b64) = integrity.strip_prefix("sha512-") {
            use sha2::{Digest, Sha512};
            let digest = Sha512::digest(fs::read(&archive)?);
            ensure!(base64(&digest) == b64, "pnpm download integrity mismatch");
        }
        let staging = dir.with_extension("partial");
        crate::fsutil::remove_dir(&staging)?;
        net::extract_tar_gz(&archive, &staging)?;
        crate::fsutil::remove_dir(&dir)?;
        fs::rename(&staging, &dir)?;
        let _ = fs::remove_file(&archive);
    }
    let package: Value = serde_json::from_slice(&fs::read(&manifest)?)?;
    let bin = match &package["bin"] {
        Value::String(s) => s.clone(),
        Value::Object(map) => map.get("pnpm").and_then(Value::as_str).context("pnpm bin missing")?.to_owned(),
        _ => bail!("pnpm package has no bin"),
    };
    Ok(dir.join(bin))
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() { TABLE[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// Resolve Node.js and pnpm for an upstream `package.json`.
pub fn resolve(package: &Value, log: &mut dyn FnMut(String)) -> Result<Toolchain> {
    let min_major = required_node_major(package);
    let system = which("node").and_then(|n| node_version(&n).map(|v| (n, v))).filter(|(_, v)| major(v) >= min_major);
    let (node, node_version, managed_node) = match system {
        Some((node, version)) => (node, version, false),
        None => {
            let (node, version) = managed_node(min_major, log)?;
            (node, version, true)
        }
    };
    let pnpm_entry = pnpm_entry(&required_pnpm(package)?, log)?;
    Ok(Toolchain { node, node_version, pnpm_entry, managed_node })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn reads_requirements() {
        let package = serde_json::json!({"packageManager": "pnpm@11.9.0+sha512.abc", "engines": {"node": ">=22"}});
        assert_eq!(required_pnpm(&package).unwrap(), "11.9.0");
        assert_eq!(required_node_major(&package), 22);
    }
}
