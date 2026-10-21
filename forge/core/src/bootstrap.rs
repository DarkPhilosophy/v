//! Discord's bootstrap chain inside `resources/`:
//!
//! * `app.asar`        – the Vencord loader (requires the runtime ASAR)
//! * `_app.asar`       – the bootstrap Discord actually runs: original Discord or OpenAsar
//! * `app.asar.backup` – the original Discord bootstrap, present only while OpenAsar is active
//!
//! Port of `scripts/manage-openasar.py` with the same fail-closed transactions.

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::asar::{self, Asar};
use crate::fsutil;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BootstrapKind {
    Original,
    Openasar,
    VencordLoader,
}

impl BootstrapKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Openasar => "openasar",
            Self::VencordLoader => "vencord-loader",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OpenAsarFix {
    pub entry: String,
    pub from: String,
    pub to: String,
}

pub fn classify(path: &Path) -> Result<BootstrapKind> {
    let archive = Asar::open(path)?;
    let package = archive.package()?;
    let main = package.get("main").and_then(Value::as_str).unwrap_or_default();
    ensure!(package.get("name") == Some(&Value::from("discord")) && !main.is_empty(), "ASAR is not a Discord bootstrap: {}", path.display());
    let source = archive.read(main)?;
    let has = |needle: &[u8]| source.windows(needle.len()).any(|w| w == needle);
    Ok(if has(b"OpenAsar") && has(b"oaVersion") {
        BootstrapKind::Openasar
    } else if has(b"require(") && (has(b".asar/patcher.js") || has(b".asar\\patcher.js")) {
        BootstrapKind::VencordLoader
    } else {
        BootstrapKind::Original
    })
}

fn classify_active(path: &Path) -> Result<BootstrapKind> {
    let kind = classify(path)?;
    ensure!(kind != BootstrapKind::VencordLoader, "Vencord loader cannot be used as the Discord bootstrap: {}", path.display());
    Ok(kind)
}

fn count(haystack: &[u8], needle: &[u8]) -> usize {
    if needle.is_empty() || haystack.len() < needle.len() {
        return 0;
    }
    let mut n = 0;
    let mut i = 0;
    while i + needle.len() <= haystack.len() {
        if &haystack[i..i + needle.len()] == needle {
            n += 1;
            i += needle.len();
        } else {
            i += 1;
        }
    }
    n
}

fn replace_once(haystack: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    let at = haystack.windows(from.len()).position(|w| w == from).unwrap();
    [&haystack[..at], to, &haystack[at + from.len()..]].concat()
}

pub fn validate_openasar(candidate: &Path) -> Result<()> {
    ensure!(classify(candidate)? == BootstrapKind::Openasar, "candidate is not OpenAsar: {}", candidate.display());
    Ok(())
}

/// Apply the distribution's exact-signature fixes to a downloaded OpenAsar (idempotent).
pub fn prepare_openasar(candidate: &Path, fixes: &[OpenAsarFix]) -> Result<()> {
    validate_openasar(candidate)?;
    for fix in fixes {
        let archive = Asar::open(candidate)?;
        let source = archive.read(&fix.entry)?;
        let (from, to) = (fix.from.as_bytes(), fix.to.as_bytes());
        if count(&source, to) == 1 {
            ensure!(count(&source, from) == 0, "ambiguous OpenAsar {} in {}", fix.entry, candidate.display());
        } else if count(&source, from) == 1 {
            archive.rewrite_entry(&fix.entry, &replace_once(&source, from, to))?;
        } else {
            bail!("unsupported OpenAsar {} in {} (OpenAsar changed upstream)", fix.entry, candidate.display());
        }
    }
    validate_openasar(candidate)?;
    let patched = Asar::open(candidate)?;
    for fix in fixes {
        ensure!(count(&patched.read(&fix.entry)?, fix.to.as_bytes()) == 1, "OpenAsar fix verification failed: {}", fix.entry);
    }
    Ok(())
}

pub fn validate_runtime(path: &Path) -> Result<()> {
    let archive = Asar::open(path)?;
    ensure!(archive.package()?.get("main") == Some(&Value::from("patcher.js")), "Vencord runtime has unexpected main entry: {}", path.display());
    archive.read_limited("patcher.js", u64::MAX)?;
    archive.entry("renderer.js")?;
    Ok(())
}

pub struct Resources {
    pub dir: PathBuf,
}

impl Resources {
    pub fn new(dir: &Path) -> Result<Self> {
        let meta = fs::symlink_metadata(dir).with_context(|| format!("missing resources directory {}", dir.display()))?;
        ensure!(meta.is_dir(), "resources path is not a real directory: {}", dir.display());
        Ok(Self { dir: dir.to_owned() })
    }
    pub fn loader(&self) -> PathBuf {
        self.dir.join("app.asar")
    }
    pub fn active(&self) -> PathBuf {
        self.dir.join("_app.asar")
    }
    pub fn backup(&self) -> PathBuf {
        self.dir.join("app.asar.backup")
    }

    fn check_backup(&self, current: BootstrapKind) -> Result<()> {
        if current == BootstrapKind::Openasar {
            ensure!(classify(&self.backup()).ok() == Some(BootstrapKind::Original), "OpenAsar is active without a valid original backup: {}", self.backup().display());
        } else {
            ensure!(!self.backup().exists(), "unexpected original backup while OpenAsar is inactive: {}", self.backup().display());
        }
        Ok(())
    }

    /// Current state, for display. `None` means Discord is unmodified.
    pub fn state(&self) -> Option<BootstrapKind> {
        if !self.active().exists() {
            return None;
        }
        classify_active(&self.active()).ok()
    }

    /// Move Discord's original bootstrap to `_app.asar` so `app.asar` can become the loader.
    pub fn prepare_loader(&self) -> Result<BootstrapKind> {
        if self.active().exists() {
            let current = classify_active(&self.active())?;
            self.check_backup(current)?;
            return Ok(current);
        }
        ensure!(!self.backup().exists(), "cannot prepare loader with orphaned backup: {}", self.backup().display());
        ensure!(classify(&self.loader())? == BootstrapKind::Original, "existing app.asar is not an original Discord bootstrap: {}", self.loader().display());
        fsutil::replace_from(&self.loader(), &self.active())?;
        ensure!(classify_active(&self.active())? == BootstrapKind::Original, "prepared Discord bootstrap validation failed");
        Ok(BootstrapKind::Original)
    }

    pub fn install_openasar(&self, candidate: &Path) -> Result<()> {
        validate_openasar(candidate)?;
        let current = classify_active(&self.active())?;
        if current == BootstrapKind::Openasar {
            self.check_backup(current)?;
            let rollback = fsutil::staged_copy(&self.active(), &self.active())?;
            let result = fsutil::replace_from(candidate, &self.active()).and_then(|()| {
                ensure!(classify(&self.active())? == BootstrapKind::Openasar, "installed OpenAsar validation failed");
                Ok(())
            });
            if result.is_err() {
                fsutil::rename(&rollback, &self.active())?;
            }
            let _ = fs::remove_file(&rollback);
            return result;
        }
        ensure!(!self.backup().exists(), "refusing to overwrite existing backup: {}", self.backup().display());
        let backup_stage = fsutil::staged_copy(&self.active(), &self.backup())?;
        let candidate_stage = fsutil::staged_copy(candidate, &self.active())?;
        let mut backup_created = false;
        let result = (|| -> Result<()> {
            ensure!(classify(&backup_stage)? == BootstrapKind::Original, "active Discord bootstrap is not a valid original");
            fsutil::rename(&backup_stage, &self.backup())?;
            backup_created = true;
            fsutil::rename(&candidate_stage, &self.active())?;
            ensure!(
                classify(&self.active())? == BootstrapKind::Openasar && classify(&self.backup())? == BootstrapKind::Original,
                "OpenAsar installation validation failed"
            );
            Ok(())
        })();
        if result.is_err() && backup_created && self.backup().exists() {
            fsutil::replace_from(&self.backup(), &self.active())?;
            let _ = fs::remove_file(self.backup());
        }
        let _ = fs::remove_file(&backup_stage);
        let _ = fs::remove_file(&candidate_stage);
        result
    }

    pub fn keep_openasar(&self) -> Result<BootstrapKind> {
        let current = classify_active(&self.active())?;
        self.check_backup(current)?;
        Ok(current)
    }

    pub fn remove_openasar(&self) -> Result<()> {
        let current = classify_active(&self.active())?;
        if current == BootstrapKind::Original {
            return self.check_backup(current);
        }
        ensure!(classify(&self.backup()).ok() == Some(BootstrapKind::Original), "cannot remove OpenAsar without a valid original backup");
        let rollback = fsutil::staged_copy(&self.active(), &self.active())?;
        let result = fsutil::replace_from(&self.backup(), &self.active()).and_then(|()| {
            ensure!(classify(&self.active())? == BootstrapKind::Original, "restored Discord bootstrap validation failed");
            fs::remove_file(self.backup())?;
            Ok(())
        });
        if result.is_err() {
            fsutil::rename(&rollback, &self.active())?;
        }
        let _ = fs::remove_file(&rollback);
        result
    }

    /// Restore stock Discord: OpenAsar removed, original bootstrap back at `app.asar`.
    pub fn uninstall(&self) -> Result<()> {
        if !self.active().exists() {
            return Ok(());
        }
        self.remove_openasar()?;
        fsutil::replace_from(&self.active(), &self.loader())?;
        ensure!(classify(&self.loader())? == BootstrapKind::Original, "restored app.asar is not the original Discord bootstrap");
        fs::remove_file(self.active())?;
        Ok(())
    }

    pub fn verify_chain(&self, runtime: &Path, expected: Option<BootstrapKind>) -> Result<BootstrapKind> {
        let actual = classify_active(&self.active())?;
        if let Some(expected) = expected {
            ensure!(actual == expected, "expected {} bootstrap, found {}", expected.label(), actual.label());
        }
        self.check_backup(actual)?;
        validate_runtime(runtime)?;
        let loader = Asar::open(&self.loader())?;
        ensure!(loader.package()?.get("main") == Some(&Value::from("patcher.js")), "Vencord loader has unexpected main entry");
        let source = loader.read("patcher.js")?;
        let target = loader_target(runtime);
        let raw = target.to_string_lossy();
        let escaped = Value::from(raw.as_ref()).to_string();
        let escaped = &escaped[1..escaped.len() - 1];
        let found = [raw.as_bytes(), escaped.as_bytes()].iter().any(|needle| count(&source, needle) > 0);
        ensure!(found, "Vencord loader does not target runtime {}", runtime.display());
        Ok(actual)
    }
}

/// Canonical runtime path: its directory resolved (so a symlinked ~/.config still matches).
pub fn loader_target(runtime: &Path) -> PathBuf {
    let parent = runtime.parent().unwrap_or(Path::new("."));
    let parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_owned());
    parent.join(runtime.file_name().unwrap_or_default())
}

/// The Vencord loader ASAR: `require("<runtime>/patcher.js")`, byte-identical to `./i`'s.
pub fn build_loader(runtime: &Path, output: &Path) -> Result<()> {
    let target = loader_target(runtime).join("patcher.js");
    let mut files = BTreeMap::new();
    files.insert("patcher.js".to_owned(), format!("require({});\n", Value::from(target.to_string_lossy().as_ref())).into_bytes());
    files.insert("package.json".to_owned(), format!("{}\n", asar::sorted_json(&serde_json::json!({"name": "discord", "version": "0.0.0", "main": "patcher.js"}))).into_bytes());
    asar::pack_files(&files, output)
}
