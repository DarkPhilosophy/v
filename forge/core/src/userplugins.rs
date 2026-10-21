//! Userplugin build steps, byte-compatible with `scripts/verify-userplugins-build.py`,
//! `scripts/stage-userplugin-seeds.sh` and the updater's `customBuild.ts`.

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Entry {
    pub destination: String,
    pub name: String,
    pub source: String,
}

fn sorted_names(dir: &Path) -> Result<Vec<String>> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .with_context(|| format!("cannot read {}", dir.display()))?
        .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect::<Result<_, _>>()?;
    names.sort();
    Ok(names)
}

fn literal_name(text: &str) -> Option<String> {
    // \bname\s*:\s*(['"])([^'"]+)\1
    let bytes = text.as_bytes();
    let mut i = 0;
    while let Some(at) = text[i..].find("name") {
        let start = i + at;
        i = start + 4;
        if start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'_') {
            continue;
        }
        let rest = text[i..].trim_start();
        let Some(rest) = rest.strip_prefix(':') else { continue };
        let rest = rest.trim_start();
        let Some(quote) = rest.chars().next().filter(|c| *c == '\'' || *c == '"') else { continue };
        let body = &rest[1..];
        let end = body.find(['\'', '"'])?;
        if body[end..].starts_with(quote) && end > 0 {
            return Some(body[..end].to_owned());
        }
    }
    None
}

pub fn inventory(root: &Path) -> Result<Vec<Entry>> {
    let mut out = Vec::new();
    for name in sorted_names(root)? {
        if name == "_shared" || name.starts_with('.') {
            continue;
        }
        let entry = root.join(&name);
        let meta = fs::symlink_metadata(&entry)?;
        ensure!(!meta.file_type().is_symlink(), "userplugin entry is a symlink: {}", entry.display());
        let (source, relative) = if meta.is_file() {
            ensure!(name.ends_with(".ts") || name.ends_with(".tsx"), "userplugin entry is not TypeScript: {}", entry.display());
            (entry.clone(), name.clone())
        } else if meta.is_dir() {
            let candidates: Vec<&str> = ["index.tsx", "index.ts"].into_iter().filter(|f| entry.join(f).is_file()).collect();
            ensure!(candidates.len() == 1, "userplugin directory must contain exactly one index.ts or index.tsx: {}", entry.display());
            (entry.join(candidates[0]), format!("{name}/{}", candidates[0]))
        } else {
            bail!("userplugin entry is not a regular file or directory: {}", entry.display());
        };
        let text = fs::read_to_string(&source).with_context(|| format!("not UTF-8: {}", source.display()))?;
        let plugin = literal_name(&text).with_context(|| format!("userplugin entry point has no literal name property: {}", source.display()))?;
        out.push(Entry { destination: name, name: plugin, source: relative });
    }
    // An empty selection is valid: the user may want only the patches and OpenAsar.
    Ok(out)
}

pub fn verify_bundle(inventory: &[Entry], bundle: &Path, source_map: &Path) -> Result<()> {
    let bundle = fs::read(bundle)?;
    let map: Value = serde_json::from_slice(&fs::read(source_map)?)?;
    let sources: Vec<String> = map["sources"].as_array().context("invalid source map")?.iter().filter_map(Value::as_str).map(|s| s.replace('\\', "/")).collect();
    let missing: Vec<String> = inventory
        .iter()
        .filter(|p| !bundle.windows(p.name.len()).any(|w| w == p.name.as_bytes()) || !sources.iter().any(|s| s.ends_with(&format!("src/userplugins/{}", p.source))))
        .map(|p| format!("{} ({})", p.name, p.destination))
        .collect();
    ensure!(missing.is_empty(), "custom userplugins missing from renderer bundle: {}", missing.join(", "));
    Ok(())
}

fn walk_files(root: &Path, dir: &Path, files: &mut BTreeMap<String, String>, order: &mut Vec<String>) -> Result<()> {
    let names = sorted_names(dir)?;
    let mut dirs = Vec::new();
    for name in &names {
        let path = dir.join(name);
        let meta = fs::symlink_metadata(&path)?;
        ensure!(!meta.file_type().is_symlink(), "userplugin source tree contains a symlink: {}", path.display());
        if meta.is_dir() {
            dirs.push(path);
        } else if meta.is_file() {
            let rel = path.strip_prefix(root)?.to_string_lossy().replace('\\', "/");
            files.insert(rel.clone(), fs::read_to_string(&path).with_context(|| format!("userplugin source is not UTF-8 text: {}", path.display()))?);
            order.push(rel);
        }
    }
    for sub in dirs {
        walk_files(root, &sub, files, order)?;
    }
    Ok(())
}

fn digest_path(root: &Path) -> Result<String> {
    let mut hash = Sha256::new();
    if root.is_file() {
        hash.update(b"file\0");
        hash.update(fs::read(root)?);
        return Ok(hex(&hash.finalize()));
    }
    let mut pending = vec![root.to_owned()];
    while let Some(current) = pending.pop() {
        for name in sorted_names(&current)? {
            let entry = current.join(&name);
            let rel = entry.strip_prefix(root)?.to_string_lossy().replace('\\', "/");
            let meta = fs::symlink_metadata(&entry)?;
            ensure!(!meta.file_type().is_symlink(), "userplugin source tree contains a symlink: {}", entry.display());
            if meta.is_dir() {
                hash.update(format!("directory\0{rel}\0").as_bytes());
                pending.push(entry);
            } else if meta.is_file() {
                hash.update(format!("file\0{rel}\0").as_bytes());
                hash.update(fs::read(&entry)?);
                hash.update(b"\0");
            } else {
                bail!("userplugin source is not a regular file or directory: {}", entry.display());
            }
        }
    }
    Ok(hex(&hash.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// JSON object in insertion order, compact (matches Python `json.dumps` of a dict built in walk order).
fn ordered_object(order: &[String], files: &BTreeMap<String, String>) -> String {
    let body: Vec<String> = order.iter().map(|k| format!("{}:{}", Value::from(k.as_str()), Value::from(files[k].as_str()))).collect();
    format!("{{{}}}", body.join(","))
}

pub fn generate_seeds(userplugins: &Path, output: &Path) -> Result<()> {
    let mut files = BTreeMap::new();
    let mut order = Vec::new();
    walk_files(userplugins, userplugins, &mut files, &mut order)?;
    let mut inventory = Vec::new();
    for name in sorted_names(userplugins)? {
        if name != "_shared" {
            inventory.push(format!("{{\"destination\":{},\"contentDigest\":\"{}\"}}", Value::from(name.as_str()), digest_path(&userplugins.join(&name))?));
        }
    }
    let module = format!(
        "/* Generated by scripts/stage-userplugin-seeds.sh. Do not edit. */\nexport const embeddedUserPluginFiles = {} as const;\nexport const embeddedUserPluginInventory = [{}] as const;\n",
        ordered_object(&order, &files),
        inventory.join(",")
    );
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    crate::fsutil::write_atomic(output, module.as_bytes(), None)
}

pub fn remove_excluded(userplugins: &Path, excluded: &std::collections::BTreeSet<String>) -> Result<()> {
    for name in excluded {
        let path = userplugins.join(name);
        if path.is_dir() {
            crate::fsutil::remove_dir(&path)?;
        } else if path.is_file() {
            fs::remove_file(&path)?;
        }
    }
    Ok(())
}
