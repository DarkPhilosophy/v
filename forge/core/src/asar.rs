//! Electron ASAR archives: reading entries, rewriting one entry, and packing a directory.
//!
//! The packer and rewriter produce exactly the bytes of `scripts/package-vencord-asar.sh` and
//! `scripts/manage-openasar.py`, so the shell installer, the in-app updater and Forge agree.

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::fsutil;

pub const MAX_HEADER_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_TEXT_ENTRY_BYTES: u64 = 4 * 1024 * 1024;

pub struct Asar {
    pub path: PathBuf,
    pub header: Value,
    size: u64,
    data_offset: u64,
}

impl Asar {
    pub fn open(path: &Path) -> Result<Self> {
        let meta = fs::symlink_metadata(path).with_context(|| format!("ASAR is not a regular file: {}", path.display()))?;
        ensure!(meta.is_file(), "ASAR is not a regular file: {}", path.display());
        let size = meta.len();
        let mut file = File::open(path)?;
        let mut framing = [0u8; 16];
        file.read_exact(&mut framing).with_context(|| format!("invalid ASAR framing: {}", path.display()))?;
        let word = |i: usize| u32::from_le_bytes(framing[i * 4..i * 4 + 4].try_into().unwrap()) as u64;
        let (pickle, header_size, object_size, json_size) = (word(0), word(1), word(2), word(3));
        ensure!(pickle == 4 && header_size >= 8 && object_size >= 4, "invalid ASAR framing: {}", path.display());
        ensure!(
            json_size > 0 && json_size <= MAX_HEADER_BYTES && json_size <= size.saturating_sub(16),
            "invalid ASAR header size: {}",
            path.display()
        );
        let mut raw = vec![0u8; json_size as usize];
        file.read_exact(&mut raw)?;
        let header: Value = serde_json::from_slice(&raw).with_context(|| format!("cannot parse ASAR {}", path.display()))?;
        ensure!(header.get("files").is_some_and(Value::is_object), "invalid ASAR file tree: {}", path.display());
        let data_offset = 8 + header_size;
        ensure!(data_offset <= size, "ASAR data offset is outside file: {}", path.display());
        Ok(Self { path: path.to_owned(), header, size, data_offset })
    }

    pub fn entry(&self, name: &str) -> Result<&Map<String, Value>> {
        let parts: Vec<&str> = name.split('/').collect();
        ensure!(!parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".."), "invalid ASAR entry path: {name}");
        let mut files = self.header["files"].as_object();
        let mut node = None;
        for (index, part) in parts.iter().enumerate() {
            let current = files.and_then(|f| f.get(*part)).and_then(Value::as_object);
            let Some(current) = current else { bail!("missing ASAR entry {name} in {}", self.path.display()) };
            node = Some(current);
            if index + 1 < parts.len() {
                files = current.get("files").and_then(Value::as_object);
            }
        }
        match node {
            Some(node) if node.contains_key("size") => Ok(node),
            _ => bail!("ASAR entry is not a file: {name} in {}", self.path.display()),
        }
    }

    pub fn has(&self, name: &str) -> bool {
        self.entry(name).is_ok()
    }

    pub fn read(&self, name: &str) -> Result<Vec<u8>> {
        self.read_limited(name, MAX_TEXT_ENTRY_BYTES)
    }

    pub fn read_limited(&self, name: &str, limit: u64) -> Result<Vec<u8>> {
        let node = self.entry(name)?;
        let (size, offset) = entry_span(node).with_context(|| format!("invalid ASAR entry metadata: {name}"))?;
        ensure!(size <= limit, "unsafe ASAR entry size: {name} in {}", self.path.display());
        let start = self.data_offset + offset;
        ensure!(start <= self.size && size <= self.size - start, "ASAR entry is outside file: {name}");
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(start))?;
        let mut data = vec![0u8; size as usize];
        file.read_exact(&mut data).with_context(|| format!("short ASAR entry read: {name}"))?;
        Ok(data)
    }

    pub fn package(&self) -> Result<Map<String, Value>> {
        match serde_json::from_slice(&self.read("package.json")?) {
            Ok(Value::Object(map)) => Ok(map),
            _ => bail!("package.json is not an object in {}", self.path.display()),
        }
    }

    /// Replace one file in place (atomically), regenerating offsets and SHA256 integrity blocks.
    pub fn rewrite_entry(&self, target: &str, replacement: &[u8]) -> Result<()> {
        let mut header = self.header.clone();
        let mut entries: Vec<(String, u64, Vec<u8>)> = Vec::new();
        self.collect(header["files"].as_object().unwrap(), "", &mut entries)?;
        ensure!(entries.iter().filter(|e| e.0 == target).count() == 1, "expected one ASAR entry {target}");
        entries.sort_by_key(|e| e.1);
        let mut offset = 0u64;
        let mut data_parts = Vec::with_capacity(entries.len());
        for (name, _, data) in entries {
            let data = if name == target { replacement.to_vec() } else { data };
            let node = node_mut(&mut header, &name);
            node.insert("size".into(), Value::from(data.len() as u64));
            node.insert("offset".into(), Value::from(offset.to_string()));
            if let Some(integrity) = node.get_mut("integrity") {
                let integrity = integrity.as_object_mut().context("invalid integrity metadata")?;
                ensure!(integrity.get("algorithm") == Some(&Value::from("SHA256")), "unsupported ASAR integrity for {name}");
                let block = integrity.get("blockSize").and_then(Value::as_u64).filter(|b| *b > 0).context("invalid integrity block size")?;
                integrity.insert("hash".into(), Value::from(sha256_hex(&data)));
                let blocks: Vec<Value> = data.chunks(block as usize).map(|c| Value::from(sha256_hex(c))).collect();
                integrity.insert("blocks".into(), Value::Array(blocks));
            }
            offset += data.len() as u64;
            data_parts.push(data);
        }
        let json = serde_json::to_vec(&header)?;
        ensure!((json.len() as u64) <= MAX_HEADER_BYTES, "rewritten ASAR header is too large");
        let mut bytes = framing(json.len());
        bytes.extend_from_slice(&json);
        for data in &data_parts {
            bytes.extend_from_slice(data);
        }
        fsutil::write_atomic(&self.path, &bytes, fsutil::mode_of(&self.path))
    }

    fn collect(&self, files: &Map<String, Value>, prefix: &str, out: &mut Vec<(String, u64, Vec<u8>)>) -> Result<()> {
        for (name, value) in files {
            let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let node = value.as_object().with_context(|| format!("invalid ASAR node {path}"))?;
            if let Some(children) = node.get("files") {
                self.collect(children.as_object().with_context(|| format!("invalid ASAR directory {path}"))?, &path, out)?;
            } else if node.contains_key("size") {
                ensure!(!node.get("unpacked").is_some_and(|u| u.as_bool() == Some(true)) && !node.contains_key("link"), "unsupported ASAR entry {path}");
                let (_, offset) = entry_span(node).context("invalid entry")?;
                out.push((path.clone(), offset, self.read_limited(&path, self.size)?));
            } else {
                bail!("invalid ASAR node {path}");
            }
        }
        Ok(())
    }
}

fn entry_span(node: &Map<String, Value>) -> Option<(u64, u64)> {
    let size = node.get("size")?.as_u64()?;
    let offset = match node.get("offset") {
        None => 0,
        Some(Value::String(s)) => s.parse().ok()?,
        Some(v) => v.as_u64()?,
    };
    Some((size, offset))
}

fn node_mut<'a>(header: &'a mut Value, path: &str) -> &'a mut Map<String, Value> {
    let mut node = header;
    for part in path.split('/') {
        node = &mut node["files"][part];
    }
    node.as_object_mut().unwrap()
}

fn framing(json_len: usize) -> Vec<u8> {
    let len = json_len as u32;
    [4u32, 8 + len, 4 + len, len].iter().flat_map(|w| w.to_le_bytes()).collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// JSON with object keys sorted by codepoint at every level, compact separators (Python's
/// `json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":"))`).
pub fn sorted_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys.iter().map(|k| format!("{}:{}", Value::from(k.as_str()), sorted_json(&map[*k]))).collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(items) => format!("[{}]", items.iter().map(sorted_json).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

/// Pack a directory as a standalone runtime ASAR whose entry point is `patcher.js`.
pub fn pack_runtime_dir(source: &Path, output: &Path) -> Result<()> {
    let mut contents = BTreeMap::new();
    walk(source, "", &mut contents)?;
    let mut package = match contents.get("package.json") {
        Some(bytes) => match serde_json::from_slice(bytes) {
            Ok(Value::Object(map)) => map,
            _ => bail!("package.json: root value must be an object"),
        },
        None => {
            let mut map = Map::new();
            map.insert("name".into(), "vencord".into());
            map.insert("version".into(), "0.0.0".into());
            map
        }
    };
    package.insert("main".into(), "patcher.js".into());
    contents.insert("package.json".into(), format!("{}\n", sorted_json(&Value::Object(package))).into_bytes());
    ensure!(contents.contains_key("patcher.js"), "patcher.js: required runtime entry point is missing");
    pack_files(&contents, output)
}

/// Pack in-memory files (relative POSIX paths) into an ASAR, written atomically.
pub fn pack_files(contents: &BTreeMap<String, Vec<u8>>, output: &Path) -> Result<()> {
    let mut tree = Value::Object(Map::new());
    let mut offset = 0u64;
    for (path, data) in contents {
        let parts: Vec<&str> = path.split('/').collect();
        let mut node = &mut tree;
        for part in &parts[..parts.len() - 1] {
            let files = node.as_object_mut().unwrap().entry("files").or_insert_with(|| Value::Object(Map::new()));
            node = files.as_object_mut().unwrap().entry(*part).or_insert_with(|| Value::Object(Map::new()));
            ensure!(!node.as_object().unwrap().contains_key("size"), "{path}: file/directory name collision");
        }
        let files = node.as_object_mut().unwrap().entry("files").or_insert_with(|| Value::Object(Map::new()));
        let leaf = parts[parts.len() - 1];
        ensure!(!files.as_object().unwrap().contains_key(leaf), "{path}: file/directory name collision");
        let mut entry = Map::new();
        entry.insert("size".into(), Value::from(data.len() as u64));
        entry.insert("offset".into(), Value::from(offset.to_string()));
        files.as_object_mut().unwrap().insert(leaf.into(), Value::Object(entry));
        offset += data.len() as u64;
    }
    let json = sorted_json(&tree).into_bytes();
    let mut bytes = framing(json.len());
    bytes.extend_from_slice(&json);
    for data in contents.values() {
        bytes.extend_from_slice(data);
    }
    fsutil::write_atomic(output, &bytes, None)
}

fn walk(dir: &Path, rel: &str, out: &mut BTreeMap<String, Vec<u8>>) -> Result<()> {
    let mut names: Vec<_> = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    names.sort_by_key(|e| e.file_name());
    for entry in names {
        let name = entry.file_name().into_string().map_err(|_| anyhow::anyhow!("non UTF-8 file name in {}", dir.display()))?;
        let rel_path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            bail!("{rel_path}: symlinks are not allowed");
        } else if kind.is_dir() {
            walk(&entry.path(), &rel_path, out)?;
        } else if kind.is_file() {
            out.insert(rel_path, fs::read(entry.path())?);
        } else {
            bail!("{rel_path}: only regular files and directories are allowed");
        }
    }
    Ok(())
}

/// Read `package.json` of an ASAR if it is a Discord bootstrap, without failing loudly.
pub fn discord_package(path: &Path) -> Option<Map<String, Value>> {
    let archive = Asar::open(path).ok()?;
    let package = archive.package().ok()?;
    (package.get("name") == Some(&Value::from("discord")) && package.get("main").is_some_and(Value::is_string)).then_some(package)
}
