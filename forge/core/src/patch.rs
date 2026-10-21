//! Apply `git diff` patches without git, with `git apply` semantics: every hunk's context must
//! match exactly; a hunk may be found at an offset from its stated line, never fuzzily.
//! Supports modified, new and deleted text files (all our overlay patches are text).

use anyhow::{Context, Result, bail, ensure};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone)]
struct Hunk {
    old_start: usize,
    old: Vec<String>,
    new: Vec<String>,
    old_no_newline: bool,
    new_no_newline: bool,
}

#[derive(Debug, Clone)]
pub struct FilePatch {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    hunks: Vec<Hunk>,
}

impl FilePatch {
    pub fn path(&self) -> &str {
        self.new_path.as_deref().or(self.old_path.as_deref()).unwrap_or("")
    }

    fn reversed(&self) -> Self {
        Self {
            old_path: self.new_path.clone(),
            new_path: self.old_path.clone(),
            hunks: self
                .hunks
                .iter()
                .map(|h| Hunk { old_start: h.old_start, old: h.new.clone(), new: h.old.clone(), old_no_newline: h.new_no_newline, new_no_newline: h.old_no_newline })
                .collect(),
        }
    }
}

fn strip_prefix(path: &str) -> Option<String> {
    if path == "/dev/null" {
        return None;
    }
    let path = path.split('\t').next().unwrap_or(path);
    Some(path.strip_prefix("a/").or_else(|| path.strip_prefix("b/")).unwrap_or(path).to_owned())
}

pub fn parse(text: &str) -> Result<Vec<FilePatch>> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if !lines[i].starts_with("--- ") {
            ensure!(!lines[i].starts_with("GIT binary patch") && !lines[i].starts_with("Binary files"), "binary patches are not supported");
            i += 1;
            continue;
        }
        let old_path = strip_prefix(&lines[i][4..]);
        ensure!(i + 1 < lines.len() && lines[i + 1].starts_with("+++ "), "malformed patch: missing +++ after ---");
        let new_path = strip_prefix(&lines[i + 1][4..]);
        i += 2;
        let mut hunks = Vec::new();
        while i < lines.len() && lines[i].starts_with("@@ ") {
            let header = lines[i];
            let ranges: Vec<&str> = header.split_whitespace().collect();
            ensure!(ranges.len() >= 3, "malformed hunk header: {header}");
            let parse_range = |r: &str| -> Result<(usize, usize)> {
                let r = &r[1..];
                let mut parts = r.split(',');
                let start = parts.next().unwrap().parse()?;
                let len = parts.next().map(str::parse).transpose()?.unwrap_or(1);
                Ok((start, len))
            };
            let (old_start, old_len) = parse_range(ranges[1]).with_context(|| format!("bad hunk {header}"))?;
            let (_, new_len) = parse_range(ranges[2]).with_context(|| format!("bad hunk {header}"))?;
            i += 1;
            let mut hunk = Hunk { old_start, old: vec![], new: vec![], old_no_newline: false, new_no_newline: false };
            let (mut seen_old, mut seen_new) = (0, 0);
            let mut last = ' ';
            while i < lines.len() && (seen_old < old_len || seen_new < new_len || lines[i].starts_with('\\')) {
                let line = lines[i];
                if let Some(rest) = line.strip_prefix('\\') {
                    let _ = rest;
                    match last {
                        '-' => hunk.old_no_newline = true,
                        '+' => hunk.new_no_newline = true,
                        _ => {
                            hunk.old_no_newline = true;
                            hunk.new_no_newline = true;
                        }
                    }
                    i += 1;
                    continue;
                }
                let (tag, body) = line.split_at(line.len().min(1));
                match tag {
                    " " | "" => {
                        hunk.old.push(body.to_owned());
                        hunk.new.push(body.to_owned());
                        seen_old += 1;
                        seen_new += 1;
                        last = ' ';
                    }
                    "-" => {
                        hunk.old.push(body.to_owned());
                        seen_old += 1;
                        last = '-';
                    }
                    "+" => {
                        hunk.new.push(body.to_owned());
                        seen_new += 1;
                        last = '+';
                    }
                    _ => bail!("malformed hunk line in {}: {line:?}", new_path.as_deref().unwrap_or("?")),
                }
                i += 1;
            }
            ensure!(seen_old == old_len && seen_new == new_len, "truncated hunk {header}");
            hunks.push(hunk);
        }
        files.push(FilePatch { old_path, new_path, hunks });
    }
    Ok(files)
}

struct Text {
    lines: Vec<String>,
    trailing_newline: bool,
}

impl Text {
    fn parse(s: &str) -> Self {
        if s.is_empty() {
            return Self { lines: vec![], trailing_newline: true };
        }
        let trailing_newline = s.ends_with('\n');
        let body = if trailing_newline { &s[..s.len() - 1] } else { s };
        Self { lines: body.split('\n').map(str::to_owned).collect(), trailing_newline }
    }
    fn render(&self) -> String {
        let mut s = self.lines.join("\n");
        if self.trailing_newline && !self.lines.is_empty() {
            s.push('\n');
        }
        s
    }
}

fn apply_hunks(source: &str, file: &FilePatch) -> Result<String> {
    let mut text = Text::parse(source);
    let mut shift: isize = 0;
    for hunk in &file.hunks {
        let expected = (hunk.old_start.max(1) as isize - 1 + shift).max(0) as usize;
        let n = hunk.old.len();
        let fits = |at: usize| at + n <= text.lines.len() && text.lines[at..at + n] == hunk.old[..];
        let max = text.lines.len().max(expected) + 1;
        let position = (0..=max)
            .flat_map(|d| [expected.checked_add(d), expected.checked_sub(d)])
            .flatten()
            .find(|&at| fits(at))
            .with_context(|| format!("{}: hunk @@ -{} does not apply", file.path(), hunk.old_start))?;
        // A hunk touching the last line decides whether the file ends with a newline.
        if position + n == text.lines.len() && (hunk.old_no_newline || hunk.new_no_newline) {
            ensure!(text.trailing_newline != hunk.old_no_newline, "{}: newline at end of file differs", file.path());
            text.trailing_newline = !hunk.new_no_newline;
        }
        text.lines.splice(position..position + n, hunk.new.iter().cloned());
        // Later hunks are stated in original-file lines: carry this hunk's offset plus its size change.
        shift = position as isize - (hunk.old_start.max(1) as isize - 1) + hunk.new.len() as isize - n as isize;
    }
    Ok(text.render())
}

/// Compute the result of applying `files` under `root` without touching disk.
fn plan(root: &Path, files: &[FilePatch]) -> Result<Vec<(std::path::PathBuf, Option<String>)>> {
    let mut out = Vec::new();
    for file in files {
        let target = root.join(file.path());
        match (&file.old_path, &file.new_path) {
            (None, Some(_)) => {
                ensure!(!target.exists(), "{}: already exists", file.path());
                out.push((target, Some(apply_hunks("", file)?)));
            }
            (Some(_), None) => {
                let current = fs::read_to_string(&target).with_context(|| format!("{}: missing", file.path()))?;
                ensure!(apply_hunks(&current, file)?.is_empty(), "{}: deleted file content differs", file.path());
                out.push((target, None));
            }
            (Some(old), Some(new)) => {
                ensure!(old == new, "renames are not supported: {old} -> {new}");
                let current = fs::read_to_string(&target).with_context(|| format!("{}: missing", file.path()))?;
                out.push((target, Some(apply_hunks(&current, file)?)));
            }
            (None, None) => bail!("patch without file names"),
        }
    }
    Ok(out)
}

/// Check that a patch applies cleanly to `root`.
pub fn check(root: &Path, patch: &str) -> Result<()> {
    plan(root, &parse(patch)?).map(|_| ())
}

/// True when the patch is already applied (its reverse applies), like `git apply --reverse --check`.
pub fn is_applied(root: &Path, patch: &str) -> bool {
    parse(patch).ok().is_some_and(|files| plan(root, &files.iter().map(FilePatch::reversed).collect::<Vec<_>>()).is_ok())
}

/// Apply all-or-nothing: nothing is written unless every file applies.
pub fn apply(root: &Path, patch: &str) -> Result<()> {
    for (path, content) in plan(root, &parse(patch)?)? {
        match content {
            Some(text) => {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::write(&path, text)?;
            }
            None => fs::remove_file(&path)?,
        }
    }
    Ok(())
}
