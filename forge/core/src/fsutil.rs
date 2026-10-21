//! Atomic file replacement and directory helpers.

use anyhow::{Context, Result};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// A unique hidden sibling of `path`, so the final rename never crosses filesystems.
pub fn sibling_temp(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let unique = format!(".{name}.{}.{}.tmp", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    path.with_file_name(unique)
}

#[cfg(unix)]
pub fn mode_of(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).ok().map(|m| m.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
pub fn mode_of(_path: &Path) -> Option<u32> {
    None
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: Option<u32>) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode.unwrap_or(0o644)))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: Option<u32>) -> Result<()> {
    Ok(())
}

/// Write a durable temporary sibling and return it; the caller renames or removes it.
pub fn stage_bytes(destination: &Path, bytes: &[u8], mode: Option<u32>) -> Result<PathBuf> {
    let temp = sibling_temp(destination);
    let result = (|| -> Result<()> {
        let mut file = File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        set_mode(&temp, mode)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(error.context(format!("cannot write {}", destination.display())));
    }
    Ok(temp)
}

pub fn write_atomic(destination: &Path, bytes: &[u8], mode: Option<u32>) -> Result<()> {
    let temp = stage_bytes(destination, bytes, mode)?;
    rename(&temp, destination).inspect_err(|_| {
        let _ = fs::remove_file(&temp);
    })
}

/// Copy `source` into a temporary sibling of `destination` (keeping the destination's mode).
pub fn staged_copy(source: &Path, destination: &Path) -> Result<PathBuf> {
    let meta = fs::symlink_metadata(source).with_context(|| format!("missing {}", source.display()))?;
    anyhow::ensure!(meta.is_file(), "source is not a regular file: {}", source.display());
    let mode = mode_of(destination).or_else(|| mode_of(source));
    stage_bytes(destination, &fs::read(source)?, mode)
}

pub fn replace_from(source: &Path, destination: &Path) -> Result<()> {
    let temp = staged_copy(source, destination)?;
    rename(&temp, destination).inspect_err(|_| {
        let _ = fs::remove_file(&temp);
    })
}

/// `rename` that replaces the destination. On Windows a running Discord keeps its files open,
/// which surfaces here as a sharing violation; retry briefly before giving up.
pub fn rename(from: &Path, to: &Path) -> Result<()> {
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if cfg!(windows) && attempt < 10 && error.raw_os_error() == Some(32) => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(error) => {
                return Err(error).with_context(|| format!("cannot replace {} (is Discord still running?)", to.display()));
            }
        }
    }
}

pub fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target).with_context(|| format!("cannot copy {}", entry.path().display()))?;
        } else {
            anyhow::bail!("refusing to copy non-regular file {}", entry.path().display());
        }
    }
    Ok(())
}

/// Remove a directory tree, retrying on Windows where virus scanners briefly hold files.
pub fn remove_dir(path: &Path) -> Result<()> {
    for attempt in 0..5 {
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) if attempt == 4 => return Err(error).with_context(|| format!("cannot remove {}", path.display())),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(150)),
        }
    }
    Ok(())
}

pub fn is_writable_dir(path: &Path) -> bool {
    let probe = sibling_temp(&path.join("probe"));
    match File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}
