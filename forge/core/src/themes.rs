//! Discord themes for Vencord. A theme is either a CSS file shipped by the distribution (copied
//! into Vencord's `themes/` folder) or a URL (added to Vencord's theme links).
//!
//! Vencord keeps its settings and themes next to the Discord it runs in: `~/.config/Vencord` for
//! a native Discord, `~/.var/app/<id>/config/Vencord` for Flatpak Discord, `%APPDATA%\Vencord` on
//! Windows. Vencord rewrites `settings.json` while Discord runs, so themes are only switched on in
//! the settings when Discord is closed; otherwise the files are put in place and the user enables
//! them in Vencord's Themes tab.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::detect::{Install, InstallKind};
use crate::fsutil;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub homepage: String,
    /// CSS file in the distribution, relative to its root.
    pub file: Option<String>,
    /// Remote CSS, loaded by Vencord itself.
    pub url: Option<String>,
}

/// Vencord's data directory for a Discord installation, as the host sees it.
pub fn vencord_dir(target: &Install) -> PathBuf {
    if target.kind == InstallKind::Flatpak
        && let Some(id) = &target.flatpak_id
    {
        return crate::paths::home().join(".var/app").join(id).join("config/Vencord");
    }
    if cfg!(windows) {
        return std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| crate::paths::home().join("AppData/Roaming")).join("Vencord");
    }
    crate::paths::xdg("XDG_CONFIG_HOME").unwrap_or_else(|| crate::paths::home().join(".config")).join("Vencord")
}

/// What to put in place: one entry per selected theme.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Plan {
    /// (file name in Vencord's themes/ folder, CSS)
    pub files: Vec<(String, String)>,
    pub links: Vec<String>,
}

pub fn plan(root: &Path, themes: &[(String, Theme)]) -> Result<Plan> {
    let mut plan = Plan::default();
    for (id, theme) in themes {
        if let Some(file) = &theme.file {
            let css = fs::read_to_string(root.join(file)).with_context(|| format!("theme {id}: missing {file}"))?;
            let name = Path::new(file).file_name().context("theme file name")?.to_string_lossy().into_owned();
            plan.files.push((name, css));
        }
        if let Some(url) = &theme.url {
            anyhow::ensure!(url.starts_with("https://") && !url.contains(['\'', '"', ')', '\n']), "theme {id}: only plain https links are allowed");
            // A small local file that imports the online theme: it shows up in Vencord's Themes tab
            // like any other theme, so it can be switched on even when Discord was running.
            let css = format!(
                "/**\n * @name {}\n * @author {}\n * @description {}\n * @source {}\n */\n@import url('{url}');\n",
                theme.title, theme.author, theme.description, theme.homepage
            );
            plan.files.push((format!("{id}.theme.css"), css));
        }
    }
    Ok(plan)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    /// Files written and switched on in Vencord's settings.
    Enabled,
    /// Files written; Discord is running, so the user switches them on in Vencord.
    FilesOnly,
}

/// Write the theme files and, when `enable`, add them to Vencord's settings.
pub fn apply(vencord: &Path, plan: &Plan, enable: bool) -> Result<Applied> {
    let themes_dir = vencord.join("themes");
    fs::create_dir_all(&themes_dir)?;
    for (name, css) in &plan.files {
        anyhow::ensure!(!name.contains(['/', '\\']) && name.ends_with(".css"), "invalid theme file name {name}");
        fsutil::write_atomic(&themes_dir.join(name), css.as_bytes(), None)?;
    }
    if !enable {
        return Ok(Applied::FilesOnly);
    }
    let settings_path = vencord.join("settings/settings.json");
    let mut settings: Map<String, Value> = match fs::read(&settings_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("cannot read {}", settings_path.display()))?,
        Err(_) => Map::new(),
    };
    // Themes imported from QuickCSS are already loaded; listing them again would load them twice.
    // A theme counts as imported when QuickCSS mentions its file name or the URL it imports.
    let quick_css = fs::read_to_string(vencord.join("settings/quickCss.css")).unwrap_or_default();
    let imported_url = |css: &str| css.split("@import url('").nth(1).and_then(|rest| rest.split('\'').next()).map(str::to_owned);
    let fresh = |name: &str, css: &str| !quick_css.contains(name) && !imported_url(css).is_some_and(|url| quick_css.contains(&url));
    add_unique(&mut settings, "enabledThemes", plan.files.iter().filter(|(name, css)| fresh(name, css)).map(|(name, _)| name.clone()));
    add_unique(&mut settings, "themeLinks", plan.links.iter().filter(|l| !quick_css.contains(l.as_str())).cloned());
    fs::create_dir_all(settings_path.parent().unwrap())?;
    let mut bytes = serde_json::to_vec_pretty(&Value::Object(settings))?;
    bytes.push(b'\n');
    fsutil::write_atomic(&settings_path, &bytes, fsutil::mode_of(&settings_path))?;
    Ok(Applied::Enabled)
}

fn add_unique(settings: &mut Map<String, Value>, key: &str, items: impl Iterator<Item = String>) {
    let list = settings.entry(key).or_insert_with(|| Value::Array(Vec::new()));
    if !list.is_array() {
        *list = Value::Array(Vec::new());
    }
    let array = list.as_array_mut().unwrap();
    for item in items {
        if !array.iter().any(|v| v.as_str() == Some(item.as_str())) {
            array.push(Value::from(item));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enables_once_and_keeps_other_settings() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/test-scratch").join(format!("themes-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("settings")).unwrap();
        fs::write(dir.join("settings/settings.json"), r#"{"useQuickCss":true,"enabledThemes":["mine.css"]}"#).unwrap();
        let plan = Plan { files: vec![("a.css".into(), "body{}".into())], links: vec!["https://example.org/b.css".into()] };
        assert_eq!(apply(&dir, &plan, true).unwrap(), Applied::Enabled);
        assert_eq!(apply(&dir, &plan, true).unwrap(), Applied::Enabled);
        let settings: Value = serde_json::from_slice(&fs::read(dir.join("settings/settings.json")).unwrap()).unwrap();
        assert_eq!(settings["useQuickCss"], true);
        assert_eq!(settings["enabledThemes"], serde_json::json!(["mine.css", "a.css"]));
        assert_eq!(settings["themeLinks"], serde_json::json!(["https://example.org/b.css"]));
        assert_eq!(fs::read_to_string(dir.join("themes/a.css")).unwrap(), "body{}");
        let _ = fs::remove_dir_all(dir);
    }
}
