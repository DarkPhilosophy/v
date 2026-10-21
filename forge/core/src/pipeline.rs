//! The whole flow: fetch a distribution, build it with the user's selection, install it into a
//! Discord installation, and undo all of it. Every step fails closed: the previous runtime and
//! bootstrap stay in place until the new chain verifies.

use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

use crate::bootstrap::{self, BootstrapKind, Resources};
use crate::detect::{Install, InstallKind};
use crate::manifest::{self, Choice, Manifest};
use crate::process::Cancel;
use crate::profile::Profile;
use crate::{fsutil, net, patch, paths, toolchain, userplugins};

#[derive(Clone, Debug)]
pub enum Event {
    Step(String),
    Log(String),
    Progress(f32),
}

pub type Sink<'a> = &'a mut dyn FnMut(Event);

/// Where the distribution comes from.
#[derive(Clone, Debug)]
pub enum Source {
    /// A git repository URL (GitHub), resolved to its current commit.
    Remote(String),
    /// A local checkout, used as is.
    Local(PathBuf),
}

impl Default for Source {
    fn default() -> Self {
        Self::Remote(manifest::DEFAULT_SOURCE.to_owned())
    }
}

/// A fetched distribution: its files, manifest and what it offers.
#[derive(Clone, Debug)]
pub struct Distribution {
    pub root: PathBuf,
    pub manifest: Manifest,
    pub revision: String,
    pub plugins: Vec<Choice>,
    pub patches: Vec<Choice>,
    pub series: Vec<String>,
}

fn github_tarball(repo: &str, rev: &str) -> Result<String> {
    let path = repo.trim_end_matches('/').trim_end_matches(".git");
    let path = path.strip_prefix("https://github.com/").context("only GitHub repositories can be fetched directly; use a local checkout")?;
    Ok(format!("https://codeload.github.com/{path}/tar.gz/{rev}"))
}

fn github_slug(repo: &str) -> String {
    repo.trim_end_matches('/').trim_end_matches(".git").trim_start_matches("https://github.com/").to_owned()
}

pub fn fetch_distribution(source: &Source, sink: Sink) -> Result<Distribution> {
    let (root, revision) = match source {
        Source::Local(path) => (path.clone(), "local".to_owned()),
        Source::Remote(repo) => {
            sink(Event::Step(format!("Checking {}", github_slug(repo))));
            let rev = net::resolve_ref(repo, "HEAD")?;
            let root = paths::cache_dir().join("distributions").join(&rev);
            if !root.join("forge.json").is_file() {
                let archive = paths::cache_dir().join(format!("dist-{rev}.tar.gz"));
                fs::create_dir_all(paths::cache_dir())?;
                net::download(&github_tarball(repo, &rev)?, &archive, &mut |_, _| {})?;
                let staging = root.with_extension("partial");
                fsutil::remove_dir(&staging)?;
                net::extract_tar_gz(&archive, &staging)?;
                let _ = fs::remove_file(&archive);
                fsutil::remove_dir(&root)?;
                fs::create_dir_all(root.parent().unwrap())?;
                fs::rename(&staging, &root)?;
            }
            (root, rev)
        }
    };
    let manifest = Manifest::load(&root.join("forge.json"))?;
    let series_text = fs::read_to_string(root.join(&manifest.overlay.series)).context("missing patch series")?;
    let series = manifest::parse_series(&series_text);
    let patches = manifest::patch_choices(&manifest, &series_text);
    let plugins = manifest::plugin_choices(&manifest, &root.join(&manifest.overlay.userplugins))?;
    Ok(Distribution { root, manifest, revision, plugins, patches, series })
}

/// Upstream commits to try, newest first: HEAD, the last that built here, the distribution's lock.
fn upstream_candidates(dist: &Distribution, sink: Sink) -> Result<Vec<String>> {
    let mut list = Vec::new();
    sink(Event::Step("Resolving upstream Vencord".into()));
    match net::resolve_ref(&dist.manifest.upstream.git, &dist.manifest.upstream.r#ref) {
        Ok(rev) => list.push(rev),
        Err(error) => sink(Event::Log(format!("upstream HEAD unavailable: {error:#}"))),
    }
    let good = paths::state_dir(&dist.manifest.id).join("upstream.good");
    let lock = dist.manifest.upstream.lock.as_ref().map(|l| dist.root.join(l));
    for file in [Some(good), lock].into_iter().flatten() {
        if let Ok(text) = fs::read_to_string(&file) {
            let rev = text.trim().to_owned();
            if rev.len() == 40 && !list.contains(&rev) {
                list.push(rev);
            }
        }
    }
    ensure!(!list.is_empty(), "no upstream Vencord revision available");
    Ok(list)
}

pub struct Built {
    pub runtime: PathBuf,
    pub upstream: String,
    pub work: PathBuf,
}

impl Drop for Built {
    fn drop(&mut self) {
        let _ = fsutil::remove_dir(&self.work);
    }
}

/// Build the runtime ASAR for this selection. Falls back to older upstream commits when the
/// newest one breaks a patch or the type check (upstream drift).
pub fn build(dist: &Distribution, profile: &Profile, cancel: &Cancel, sink: Sink) -> Result<Built> {
    let candidates = upstream_candidates(dist, sink)?;
    let mut last_error = None;
    for (index, upstream) in candidates.iter().enumerate() {
        cancel.check()?;
        if index > 0 {
            sink(Event::Step(format!("Falling back to known-good upstream {}", &upstream[..12])));
        }
        match build_at(dist, profile, upstream, cancel, sink) {
            Ok(built) => return Ok(built),
            Err(error) if cancel.is_cancelled() => return Err(error),
            Err(error) if error.downcast_ref::<Drift>().is_some() => {
                sink(Event::Log(format!("{error:#}")));
                last_error = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap()).context("the distribution does not build on any known upstream revision")
}

/// Upstream changed under our patches: worth retrying an older upstream.
#[derive(Debug)]
struct Drift(String);
impl std::fmt::Display for Drift {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "upstream drift: {}", self.0)
    }
}
impl std::error::Error for Drift {}

fn build_at(dist: &Distribution, profile: &Profile, upstream: &str, cancel: &Cancel, sink: Sink) -> Result<Built> {
    let m = &dist.manifest;
    let work = paths::cache_dir().join("work").join(format!("{}-{}", &upstream[..12], std::process::id()));
    fsutil::remove_dir(&work)?;
    fs::create_dir_all(&work)?;
    let built = Built { runtime: work.join("app.asar"), upstream: upstream.to_owned(), work: work.clone() };
    let src = work.join("vencord");

    sink(Event::Step(format!("Downloading Vencord {}", &upstream[..12])));
    sink(Event::Progress(0.05));
    let archive = paths::cache_dir().join("upstream").join(format!("{upstream}.tar.gz"));
    if !archive.is_file() {
        fs::create_dir_all(archive.parent().unwrap())?;
        net::download(&m.tarball(&m.upstream.tarball, upstream), &archive, &mut |_, _| {})?;
    }
    net::extract_tar_gz(&archive, &src)?;
    cancel.check()?;

    sink(Event::Step("Applying the distribution".into()));
    sink(Event::Progress(0.12));
    fsutil::copy_dir(&dist.root.join(&m.overlay.source), &src.join("src"))?;
    let mut profile = profile.clone();
    profile.sanitize(m);
    userplugins::remove_excluded(&src.join("src/userplugins"), &profile.exclude_plugins)?;
    let inventory = if m.build.verify_userplugins { Some(userplugins::inventory(&src.join("src/userplugins"))?) } else { None };
    for name in &dist.series {
        if !profile.patch_enabled(name) {
            sink(Event::Log(format!("skipping {name} (turned off)")));
            continue;
        }
        let text = fs::read_to_string(dist.root.join(&m.overlay.patches).join(name))?;
        if patch::is_applied(&src, &text) {
            sink(Event::Log(format!("{name}: already upstream")));
            continue;
        }
        patch::apply(&src, &text).map_err(|e| Drift(format!("{name}: {e:#}")))?;
        sink(Event::Log(format!("applied {name}")));
    }

    let package: Value = serde_json::from_slice(&fs::read(src.join("package.json"))?)?;
    sink(Event::Step("Preparing Node.js and pnpm".into()));
    let tools = toolchain::resolve(&package, &mut |l| sink(Event::Log(l)))?;
    sink(Event::Log(format!("node {}{}", tools.node_version, if tools.managed_node { " (managed)" } else { "" })));
    cancel.check()?;

    sink(Event::Step("Installing build dependencies".into()));
    sink(Event::Progress(0.25));
    let mut install = tools.pnpm(&src);
    install.args(["install", "--frozen-lockfile"]).env("CI", "1");
    crate::process::run(install, "pnpm install", cancel, &mut |l| sink(Event::Log(l)))?;

    if let Some(seeds) = &m.build.embedded_seeds {
        userplugins::generate_seeds(&src.join("src/userplugins"), &src.join(seeds))?;
    }
    if m.build.typecheck {
        sink(Event::Step("Type-checking against upstream".into()));
        sink(Event::Progress(0.55));
        let mut tsc = tools.pnpm(&src);
        tsc.args(["run", "testTsc"]);
        crate::process::run(tsc, "type check", cancel, &mut |l| sink(Event::Log(l))).map_err(|e| Drift(format!("{e:#}")))?;
    }

    sink(Event::Step("Building Vencord".into()));
    sink(Event::Progress(0.7));
    let mut build = tools.node_cmd(&src);
    let hash = format!("{}.{}", &upstream[..12], &dist.revision[..dist.revision.len().min(12)]);
    build.args(["scripts/build/build.mjs"]).env("VENCORD_HASH", hash).env("VENCORD_REMOTE", github_slug(&m.overlay.git));
    crate::process::run(build, "build", cancel, &mut |l| sink(Event::Log(l)))?;

    if let Some(inventory) = &inventory {
        userplugins::verify_bundle(inventory, &src.join("dist/renderer.js"), &src.join("dist/renderer.js.map"))?;
        sink(Event::Log(format!("verified {} custom plugins in the bundle", inventory.len())));
    }
    crate::asar::pack_runtime_dir(&src.join("dist"), &built.runtime)?;
    bootstrap::validate_runtime(&built.runtime)?;
    sink(Event::Progress(0.85));
    Ok(built)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenAsarAction {
    Keep,
    Install,
    Remove,
}

impl OpenAsarAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Keep => "keep",
            Self::Install => "install",
            Self::Remove => "remove",
        }
    }
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "keep" => Self::Keep,
            "install" => Self::Install,
            "remove" => Self::Remove,
            other => bail!("unknown OpenAsar action {other}"),
        })
    }
}

pub fn download_openasar(manifest: &Manifest, sink: Sink) -> Result<PathBuf> {
    let oa = manifest.openasar.as_ref().context("this distribution does not ship OpenAsar")?;
    sink(Event::Step("Downloading OpenAsar".into()));
    let path = paths::cache_dir().join("openasar.asar");
    fs::create_dir_all(paths::cache_dir())?;
    net::download(&oa.url, &path, &mut |_, _| {})?;
    bootstrap::prepare_openasar(&path, &oa.fixes)?;
    Ok(path)
}

/// Swap the bootstrap chain in `resources`. Runs unprivileged, or as root through the CLI's
/// `privileged-bootstrap` when Discord's files are system-owned.
pub fn apply_bootstrap(resources: &Path, loader: &Path, runtime: &Path, action: OpenAsarAction, candidate: Option<&Path>) -> Result<BootstrapKind> {
    let res = Resources::new(resources)?;
    res.prepare_loader()?;
    match action {
        OpenAsarAction::Install => res.install_openasar(candidate.context("OpenAsar candidate missing")?)?,
        OpenAsarAction::Keep => {
            res.keep_openasar()?;
        }
        OpenAsarAction::Remove => res.remove_openasar()?,
    }
    let stage = fsutil::staged_copy(loader, &res.loader())?;
    fsutil::rename(&stage, &res.loader()).inspect_err(|_| {
        let _ = fs::remove_file(&stage);
    })?;
    res.verify_chain(runtime, None)
}

/// Install a built runtime into one Discord installation.
pub fn install(dist: &Distribution, built: &Built, target: &Install, action: OpenAsarAction, profile: &Profile, sink: Sink) -> Result<BootstrapKind> {
    sink(Event::Step(format!("Installing into {}", target.title())));
    sink(Event::Progress(0.9));
    let runtime_dir = paths::runtime_dir();
    fs::create_dir_all(&runtime_dir)?;
    let runtime = runtime_dir.join("app.asar");
    let candidate = if action == OpenAsarAction::Install { Some(download_openasar(&dist.manifest, sink)?) } else { None };

    // The runtime is replaced first (keeping a rollback copy); the loader only after that.
    let rollback = runtime.is_file().then(|| fsutil::staged_copy(&runtime, &runtime)).transpose()?;
    fsutil::replace_from(&built.runtime, &runtime)?;
    let loader = built.work.join("loader.asar");
    bootstrap::build_loader(&runtime, &loader)?;

    // Rebuilds reuse the same runtime path, so the loader in Discord's folder is usually already
    // right: then only the runtime changes and system-owned installs need no password.
    let loader_current = fs::read(target.resources.join("app.asar")).ok() == fs::read(&loader).ok();
    let result = if loader_current && action == OpenAsarAction::Keep {
        Resources::new(&target.resources).and_then(|r| r.verify_chain(&runtime, None))
    } else if target.writable {
        apply_bootstrap(&target.resources, &loader, &runtime, action, candidate.as_deref())
    } else {
        privileged_bootstrap(&target.resources, &loader, &runtime, action, candidate.as_deref(), sink)
    };
    match (&result, rollback) {
        (Err(_), Some(rollback)) => fsutil::rename(&rollback, &runtime)?,
        (Err(_), None) => {
            let _ = fs::remove_file(&runtime);
        }
        (Ok(_), Some(rollback)) => {
            let _ = fs::remove_file(rollback);
        }
        (Ok(_), None) => {}
    }
    let kind = result?;

    let mut profile = profile.clone();
    profile.distribution = dist.manifest.id.clone();
    profile.sanitize(&dist.manifest);
    profile.save(&runtime_dir)?;
    let state = paths::state_dir(&dist.manifest.id);
    fs::create_dir_all(&state)?;
    fsutil::write_atomic(&state.join("upstream.good"), format!("{}\n", built.upstream).as_bytes(), None)?;

    if target.kind == InstallKind::Flatpak
        && let Some(id) = &target.flatpak_id
    {
        // Flatpak Discord must be allowed to read the runtime outside its sandbox.
        let mut command = std::process::Command::new("flatpak");
        command.args(["override", "--user", &format!("--filesystem={}", runtime_dir.display()), id]);
        let _ = command.status();
    }
    sink(Event::Progress(1.0));
    Ok(kind)
}

fn privileged_bootstrap(resources: &Path, loader: &Path, runtime: &Path, action: OpenAsarAction, candidate: Option<&Path>, sink: Sink) -> Result<BootstrapKind> {
    if !cfg!(target_os = "linux") {
        bail!("Discord's files at {} are not writable; run Forge as administrator", resources.display());
    }
    sink(Event::Log("Discord's files are system-owned; asking for permission".into()));
    let cli = cli_path()?;
    let mut command = std::process::Command::new("pkexec");
    command.arg(&cli).arg("privileged-bootstrap").arg(resources).arg(loader).arg(runtime).arg(action.as_str());
    if let Some(candidate) = candidate {
        command.arg(candidate);
    }
    let status = command.status().context("pkexec is required to modify a system-wide Discord")?;
    ensure!(status.success(), "privileged bootstrap update failed or was refused");
    Resources::new(resources)?.verify_chain(runtime, None)
}

/// The `vforge` CLI next to the running executable (the GUI ships with it).
pub fn cli_path() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().unwrap();
    let name = if cfg!(windows) { "vforge.exe" } else { "vforge" };
    let cli = dir.join(name);
    ensure!(cli.is_file(), "the vforge command-line helper is missing next to {}", exe.display());
    Ok(cli)
}

/// Restore stock Discord in one installation (the runtime stays for other installations).
pub fn uninstall(target: &Install, sink: Sink) -> Result<()> {
    sink(Event::Step(format!("Restoring stock {}", target.title())));
    if target.writable {
        return Resources::new(&target.resources)?.uninstall();
    }
    ensure!(cfg!(target_os = "linux"), "run Forge as administrator to modify {}", target.resources.display());
    let status = std::process::Command::new("pkexec").arg(cli_path()?).arg("privileged-uninstall").arg(&target.resources).status()?;
    ensure!(status.success(), "privileged uninstall failed or was refused");
    Ok(())
}

/// Best-effort: is any Discord process running? Installing over a running Windows Discord fails.
pub fn discord_running() -> bool {
    if cfg!(windows) {
        let out = std::process::Command::new("tasklist").args(["/FO", "CSV", "/NH"]).output();
        return out.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("\"discord"));
    }
    fs::read_dir("/proc").into_iter().flatten().flatten().any(|e| {
        fs::read_to_string(e.path().join("comm")).is_ok_and(|c| {
            let c = c.trim().to_lowercase();
            c == "discord" || c == "discordptb" || c == "discordcanary" || c == "discorddevelopment"
        })
    })
}
