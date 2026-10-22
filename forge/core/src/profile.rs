//! `forge-profile.json`, stored next to the runtime ASAR. It records only exclusions, so plugins
//! and patches added to the distribution later are on by default. The shell installer (`i`) and
//! the in-app updater read the same file, so a selection survives every kind of update.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::fsutil;
use crate::manifest::Manifest;

pub const FILE: &str = "forge-profile.json";

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    #[serde(default = "one")]
    pub schema: u32,
    #[serde(default)]
    pub distribution: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub exclude_plugins: BTreeSet<String>,
    #[serde(default)]
    pub exclude_patches: BTreeSet<String>,
    /// Themes to install (opt-in, unlike plugins and patches).
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub themes: BTreeSet<String>,
}

fn one() -> u32 {
    1
}

impl Profile {
    pub fn path(runtime_dir: &Path) -> PathBuf {
        runtime_dir.join(FILE)
    }

    /// A missing or unreadable profile means "everything on".
    pub fn load(runtime_dir: &Path) -> Self {
        std::fs::read(Self::path(runtime_dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, runtime_dir: &Path) -> Result<()> {
        std::fs::create_dir_all(runtime_dir)?;
        let mut bytes = serde_json::to_vec_pretty(self)?;
        bytes.push(b'\n');
        fsutil::write_atomic(&Self::path(runtime_dir), &bytes, None)
    }

    /// Drop exclusions that the manifest does not allow (required patches, shared code).
    pub fn sanitize(&mut self, manifest: &Manifest) {
        self.exclude_patches.retain(|p| !manifest.patches.get(p).is_some_and(|i| i.required));
        self.exclude_plugins.retain(|p| !manifest.overlay.shared.contains(p) && !p.contains(['/', '\\']) && !p.starts_with('.'));
        self.themes.retain(|t| manifest.themes.contains_key(t));
    }

    pub fn patch_enabled(&self, name: &str) -> bool {
        !self.exclude_patches.contains(name)
    }

    pub fn plugin_enabled(&self, name: &str) -> bool {
        !self.exclude_plugins.contains(name)
    }

    /// Patches the selection turns off because a patch they require is off.
    pub fn unmet_requirements(&self, manifest: &Manifest) -> Vec<(String, String)> {
        let mut unmet = Vec::new();
        for (name, item) in &manifest.patches {
            if self.patch_enabled(name) {
                for dep in &item.requires {
                    if !self.patch_enabled(dep) {
                        unmet.push((name.clone(), dep.clone()));
                    }
                }
            }
        }
        unmet
    }
}
