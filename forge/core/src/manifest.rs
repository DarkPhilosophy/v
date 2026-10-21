//! `forge.json`: what a Vencord distribution is made of. Forge itself knows nothing about any
//! particular distribution; everything specific (repos, patches, plugins, OpenAsar fixes) is here.

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

use crate::bootstrap::OpenAsarFix;

pub const DEFAULT_SOURCE: &str = "https://github.com/DarkPhilosophy/v";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub homepage: String,
    pub upstream: Repo,
    pub overlay: Overlay,
    #[serde(default)]
    pub build: BuildSteps,
    #[serde(default)]
    pub plugins: BTreeMap<String, Item>,
    #[serde(default)]
    pub patches: BTreeMap<String, Item>,
    pub openasar: Option<OpenAsar>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub git: String,
    /// Archive URL with `{rev}` replaced by a full commit hash.
    pub tarball: String,
    #[serde(default = "head")]
    pub r#ref: String,
    /// File in the overlay holding a known-good upstream commit, used when HEAD drifted.
    pub lock: Option<String>,
}

fn head() -> String {
    "HEAD".into()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    pub git: String,
    pub tarball: String,
    #[serde(default = "head")]
    pub r#ref: String,
    /// Copied over upstream `src/`.
    pub source: String,
    pub patches: String,
    pub series: String,
    pub userplugins: String,
    #[serde(default)]
    pub shared: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSteps {
    /// Generate the User Plugin Manager's embedded seed module at this path (relative to upstream).
    pub embedded_seeds: Option<String>,
    #[serde(default)]
    pub typecheck: bool,
    #[serde(default)]
    pub verify_userplugins: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub requires: Vec<String>,
    #[serde(default)]
    pub recommends: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OpenAsar {
    pub url: String,
    #[serde(default)]
    pub fixes: Vec<OpenAsarFix>,
}

impl Manifest {
    pub fn parse(text: &str) -> Result<Self> {
        let manifest: Self = serde_json::from_str(text).context("invalid forge.json")?;
        ensure!(manifest.schema == 1, "unsupported forge.json schema {}", manifest.schema);
        for (name, item) in &manifest.patches {
            for dep in &item.requires {
                ensure!(manifest.patches.contains_key(dep), "patch {name} requires unknown patch {dep}");
            }
        }
        Ok(manifest)
    }

    pub fn load(path: &Path) -> Result<Self> {
        Self::parse(&std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?)
    }

    pub fn tarball(&self, repo_tarball: &str, rev: &str) -> String {
        repo_tarball.replace("{rev}", rev)
    }
}

/// One plugin or patch as the UI lists it: manifest metadata merged with what the overlay holds.
#[derive(Clone, Debug, Serialize)]
pub struct Choice {
    pub id: String,
    pub title: String,
    pub description: String,
    pub required: bool,
    pub requires: Vec<String>,
    pub recommends: Vec<String>,
}

impl Choice {
    fn new(id: &str, item: Option<&Item>) -> Self {
        let item = item.cloned().unwrap_or_default();
        Self {
            id: id.to_owned(),
            title: if item.title.is_empty() { id.to_owned() } else { item.title },
            description: item.description,
            required: item.required,
            requires: item.requires,
            recommends: item.recommends,
        }
    }
}

/// Patches in series order (from the overlay), annotated from the manifest.
pub fn patch_choices(manifest: &Manifest, series: &str) -> Vec<Choice> {
    parse_series(series).iter().map(|name| Choice::new(name, manifest.patches.get(name))).collect()
}

/// Plugins present in the overlay's userplugins directory, annotated from the manifest.
pub fn plugin_choices(manifest: &Manifest, userplugins: &Path) -> Result<Vec<Choice>> {
    let mut names: Vec<String> = std::fs::read_dir(userplugins)
        .with_context(|| format!("missing userplugins in overlay: {}", userplugins.display()))?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.') && !manifest.overlay.shared.contains(n))
        .collect();
    names.sort();
    // The id is the overlay entry name: that is what the profile excludes and installers delete.
    Ok(names.iter().map(|n| Choice::new(n, manifest.plugins.get(n))).collect())
}

pub fn parse_series(text: &str) -> Vec<String> {
    text.lines().map(|l| l.split('#').next().unwrap_or("").trim()).filter(|l| !l.is_empty()).map(str::to_owned).collect()
}
