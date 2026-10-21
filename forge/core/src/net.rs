//! Network access without git or curl: resolve refs over git's smart HTTP protocol, download
//! files, and unpack GitHub tarballs and Node.js archives.

use anyhow::{Context, Result, bail, ensure};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(600)))
        .timeout_connect(Some(Duration::from_secs(20)))
        .user_agent(concat!("vencord-forge/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

pub fn get_bytes(url: &str) -> Result<Vec<u8>> {
    let mut response = agent().get(url).call().with_context(|| format!("GET {url}"))?;
    let mut body = Vec::new();
    response.body_mut().as_reader().read_to_end(&mut body).with_context(|| format!("reading {url}"))?;
    Ok(body)
}

pub fn get_text(url: &str) -> Result<String> {
    String::from_utf8(get_bytes(url)?).context("response is not UTF-8")
}

/// Download to `dest` through a temporary sibling, reporting `(done, total)` bytes.
pub fn download(url: &str, dest: &Path, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<()> {
    let mut response = agent().get(url).call().with_context(|| format!("GET {url}"))?;
    let total = response.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
    let temp = crate::fsutil::sibling_temp(dest);
    let result = (|| -> Result<()> {
        let mut reader = response.body_mut().with_config().limit(2 * 1024 * 1024 * 1024).reader();
        let mut file = File::create(&temp)?;
        let mut buffer = vec![0u8; 256 * 1024];
        let mut done = 0u64;
        loop {
            let n = reader.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            file.write_all(&buffer[..n])?;
            done += n as u64;
            progress(done, total);
        }
        file.sync_all()?;
        Ok(())
    })();
    match result {
        Ok(()) => crate::fsutil::rename(&temp, dest),
        Err(error) => {
            let _ = fs::remove_file(&temp);
            Err(error.context(format!("downloading {url}")))
        }
    }
}

/// `git ls-remote <repo> <ref>` over smart HTTP. `HEAD` resolves the default branch.
pub fn resolve_ref(repo: &str, reference: &str) -> Result<String> {
    let base = repo.trim_end_matches('/');
    let base = if base.ends_with(".git") { base.to_owned() } else { format!("{base}.git") };
    let body = get_bytes(&format!("{base}/info/refs?service=git-upload-pack"))?;
    let refs = parse_advertisement(&body)?;
    let wanted = [reference.to_owned(), format!("refs/heads/{reference}"), format!("refs/tags/{reference}")];
    for name in &wanted {
        if let Some((hash, _)) = refs.iter().find(|(_, n)| n == name) {
            return Ok(hash.clone());
        }
    }
    bail!("{reference} not found in {repo}")
}

/// Parse pkt-lines of a git-upload-pack ref advertisement into (hash, name).
fn parse_advertisement(body: &[u8]) -> Result<Vec<(String, String)>> {
    let mut refs = Vec::new();
    let mut i = 0;
    while i + 4 <= body.len() {
        let len = usize::from_str_radix(std::str::from_utf8(&body[i..i + 4])?, 16)?;
        if len == 0 {
            i += 4;
            continue;
        }
        ensure!(len >= 4 && i + len <= body.len(), "malformed git ref advertisement");
        let line = String::from_utf8_lossy(&body[i + 4..i + len]);
        let line = line.trim_end_matches('\n');
        let line = line.split('\0').next().unwrap_or("");
        if let Some((hash, name)) = line.split_once(' ')
            && hash.len() == 40
            && hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            refs.push((hash.to_owned(), name.to_owned()));
        }
        i += len;
    }
    ensure!(!refs.is_empty(), "no refs advertised");
    Ok(refs)
}

/// Extract a `.tar.gz` stripping its single top-level directory (GitHub archives).
pub fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<()> {
    let file = File::open(archive)?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    fs::create_dir_all(dest)?;
    for entry in tar.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let Some(relative) = strip_first(&path) else { continue };
        let kind = entry.header().entry_type();
        let target = dest.join(&relative);
        if kind.is_dir() {
            fs::create_dir_all(&target)?;
        } else if kind.is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            entry.unpack(&target).with_context(|| format!("extracting {}", relative.display()))?;
        } else if kind.is_symlink() && !cfg!(windows) {
            entry.unpack(&target)?;
        }
        // pax headers, hardlinks and (on Windows) symlinks are skipped: sources do not need them.
    }
    Ok(())
}

/// Extract a `.zip` stripping its single top-level directory (Node.js Windows builds).
pub fn extract_zip(archive: &Path, dest: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(File::open(archive)?)?;
    for index in 0..zip.len() {
        let mut file = zip.by_index(index)?;
        let Some(path) = file.enclosed_name() else { continue };
        let Some(relative) = strip_first(&path) else { continue };
        let target = dest.join(relative);
        if file.is_dir() {
            fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            std::io::copy(&mut file, &mut File::create(&target)?)?;
        }
    }
    Ok(())
}

fn strip_first(path: &Path) -> Option<PathBuf> {
    let mut components = path.components();
    components.next()?;
    let rest: PathBuf = components.collect();
    if rest.as_os_str().is_empty() || rest.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    Some(rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ref_advertisement() {
        let mut body = Vec::new();
        for line in ["# service=git-upload-pack\n", ""] {
            if line.is_empty() {
                body.extend_from_slice(b"0000");
            } else {
                body.extend_from_slice(format!("{:04x}{line}", line.len() + 4).as_bytes());
            }
        }
        let head = format!("{} HEAD\0multi_ack symref=HEAD:refs/heads/main\n", "a".repeat(40));
        let main = format!("{} refs/heads/main\n", "b".repeat(40));
        for line in [head, main] {
            body.extend_from_slice(format!("{:04x}{line}", line.len() + 4).as_bytes());
        }
        body.extend_from_slice(b"0000");
        let refs = parse_advertisement(&body).unwrap();
        assert_eq!(refs, vec![("a".repeat(40), "HEAD".into()), ("b".repeat(40), "refs/heads/main".into())]);
    }
}
