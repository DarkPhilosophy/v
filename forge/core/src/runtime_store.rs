//! The Vencord runtime (`app.asar`) and the saved selection (`forge-profile.json`) live in the
//! host's Vencord directory (`~/.config/Vencord`). Natively Forge writes them itself. Inside its
//! Flatpak it has no access there: the same operations run through the host copy of Forge
//! (`vencord-forge runtime-place …`, see the CLI), so the sandbox needs no filesystem permission.
//!
//! Replacing the runtime keeps the previous one as a sibling until the install verifies, so a
//! failed install puts it back.

use anyhow::{Context, Result, ensure};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use crate::profile::Profile;
use crate::{bootstrap, fsutil, paths};

fn rollback_path(runtime: &Path) -> PathBuf {
    runtime.with_file_name(format!(".{}.forge-rollback", runtime.file_name().unwrap_or_default().to_string_lossy()))
}

/// Run a command of the host copy of Forge and return its standard output.
fn host(args: &[&OsStr]) -> Result<String> {
    let cli = crate::pipeline::cli_path()?;
    let output = crate::process::host_cli(&cli).args(args).output().context("cannot run Forge on the host")?;
    ensure!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr).trim().trim_start_matches("vencord-forge: "));
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Put `source` in place as the runtime, keeping the current one for [`rollback`].
pub fn place(source: &Path, runtime: &Path) -> Result<()> {
    if paths::uses_host_helper() {
        return host(&["runtime-place".as_ref(), source.as_os_str(), runtime.as_os_str()]).map(drop);
    }
    place_local(source, runtime)
}

pub fn place_local(source: &Path, runtime: &Path) -> Result<()> {
    fs::create_dir_all(runtime.parent().context("runtime path has no directory")?)?;
    let rollback = rollback_path(runtime);
    if runtime.is_file() {
        fsutil::replace_from(runtime, &rollback)?;
    } else {
        let _ = fs::remove_file(&rollback);
    }
    fsutil::replace_from(source, runtime)
}

/// The install failed: restore the previous runtime (or remove the new one if there was none).
pub fn rollback(runtime: &Path) -> Result<()> {
    if paths::uses_host_helper() {
        return host(&["runtime-rollback".as_ref(), runtime.as_os_str()]).map(drop);
    }
    rollback_local(runtime)
}

pub fn rollback_local(runtime: &Path) -> Result<()> {
    let rollback = rollback_path(runtime);
    if rollback.is_file() {
        fsutil::rename(&rollback, runtime)
    } else {
        let _ = fs::remove_file(runtime);
        Ok(())
    }
}

/// The install verified: drop the kept copy.
pub fn commit(runtime: &Path) -> Result<()> {
    if paths::uses_host_helper() {
        return host(&["runtime-commit".as_ref(), runtime.as_os_str()]).map(drop);
    }
    commit_local(runtime);
    Ok(())
}

pub fn commit_local(runtime: &Path) {
    let _ = fs::remove_file(rollback_path(runtime));
}

/// The loader requires the runtime by its canonical host path, which only the host can resolve.
pub fn build_loader(runtime: &Path, output: &Path) -> Result<()> {
    if paths::uses_host_helper() {
        return host(&["build-loader".as_ref(), runtime.as_os_str(), output.as_os_str()]).map(drop);
    }
    bootstrap::build_loader(runtime, output)
}

pub fn save_profile(runtime_dir: &Path, profile: &Profile, scratch: &Path) -> Result<()> {
    if !paths::uses_host_helper() {
        return profile.save(runtime_dir);
    }
    let file = scratch.join("forge-profile.json");
    fs::write(&file, serde_json::to_vec_pretty(profile)?)?;
    host(&["profile-write".as_ref(), runtime_dir.as_os_str(), file.as_os_str()]).map(drop)
}

/// The saved selection; everything on when there is none or it cannot be read.
pub fn load_profile(runtime_dir: &Path) -> Profile {
    if !paths::uses_host_helper() {
        return Profile::load(runtime_dir);
    }
    host(&["profile-read".as_ref(), runtime_dir.as_os_str()]).ok().and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollback_restores_the_previous_runtime_and_commit_drops_the_copy() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/test-scratch").join(format!("runtime-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let runtime = dir.join("Vencord/app.asar");
        let (old, new) = (dir.join("old.asar"), dir.join("new.asar"));
        fs::write(&old, "old").unwrap();
        fs::write(&new, "new").unwrap();

        place_local(&old, &runtime).unwrap();
        commit_local(&runtime);
        place_local(&new, &runtime).unwrap();
        assert_eq!(fs::read_to_string(&runtime).unwrap(), "new");
        rollback_local(&runtime).unwrap();
        assert_eq!(fs::read_to_string(&runtime).unwrap(), "old");

        place_local(&new, &runtime).unwrap();
        commit_local(&runtime);
        assert!(!rollback_path(&runtime).exists());
        assert_eq!(fs::read_to_string(&runtime).unwrap(), "new");

        let fresh = dir.join("Fresh/app.asar");
        place_local(&new, &fresh).unwrap();
        rollback_local(&fresh).unwrap();
        assert!(!fresh.exists(), "a failed first install leaves no runtime behind");
        let _ = fs::remove_dir_all(dir);
    }
}
