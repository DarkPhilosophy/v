//! `vforge`: everything the GUI does, scriptable, plus the root-only helpers the GUI calls
//! through pkexec when Discord's files are system-owned.

use anyhow::{Context, Result, bail};
use forge_core::detect::{self, Install, Roots};
use forge_core::pipeline::{self, Event, OpenAsarAction, Source};
use forge_core::process::Cancel;
use forge_core::profile::Profile;
use forge_core::{asar, bootstrap, paths, patch, userplugins};
use std::path::{Path, PathBuf};

const USAGE: &str = "vforge — build and install a Vencord distribution into Discord

USAGE:
  vforge detect [--json]
  vforge list [--source <url|dir>] [--json]
  vforge install [--source <url|dir>] [--target <resources-dir|index>] [--openasar keep|install|remove]
                 [--disable-plugin <name>]... [--disable-patch <name>]... [--enable-all]
  vforge build [--source <url|dir>] --out <file.asar> [--disable-plugin <name>]... [--disable-patch <name>]...
  vforge uninstall [--target <resources-dir|index>]
  vforge status

The selection is remembered in forge-profile.json next to the runtime, and honored by the
shell installer and the in-app updater. Without --disable-*/--enable-all the saved one is used.

Low-level (also used for testing):
  vforge pack-runtime <dist-dir> <out.asar>
  vforge apply-patch <root> <file.patch>
  vforge seeds <userplugins-dir> <out.ts>
  vforge inventory <userplugins-dir>
  vforge prepare-openasar <candidate.asar> <forge.json>
  vforge verify-chain <resources> <runtime.asar>
  vforge privileged-bootstrap <resources> <loader.asar> <runtime.asar> <keep|install|remove> [candidate]
  vforge privileged-uninstall <resources>";

/// Entry point shared by the `vforge` binary and the app (which runs these commands when it is
/// started with arguments, e.g. by pkexec). Returns the process exit code.
pub fn main_with(args: Vec<String>) -> i32 {
    match run(args) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("vforge: {error:#}");
            1
        }
    }
}

fn sink() -> impl FnMut(Event) {
    |event| match event {
        Event::Step(s) => eprintln!("\x1b[1;36m[forge]\x1b[0m {s}"),
        Event::Log(s) => eprintln!("        {s}"),
        Event::Progress(_) => {}
    }
}

struct Args(Vec<String>);
impl Args {
    fn flag(&mut self, name: &str) -> bool {
        let before = self.0.len();
        self.0.retain(|a| a != name);
        before != self.0.len()
    }
    fn value(&mut self, name: &str) -> Result<Option<String>> {
        let Some(i) = self.0.iter().position(|a| a == name) else { return Ok(None) };
        let value = self.0.get(i + 1).cloned().with_context(|| format!("{name} needs a value"))?;
        self.0.drain(i..=i + 1);
        Ok(Some(value))
    }
    fn values(&mut self, name: &str) -> Result<Vec<String>> {
        let mut out = Vec::new();
        while let Some(v) = self.value(name)? {
            out.push(v);
        }
        Ok(out)
    }
    fn done(&self) -> Result<()> {
        if !self.0.is_empty() {
            bail!("unexpected arguments: {}\n\n{USAGE}", self.0.join(" "));
        }
        Ok(())
    }
}

fn source(args: &mut Args) -> Result<Source> {
    Ok(match args.value("--source")? {
        Some(s) if s.starts_with("https://") => Source::Remote(s),
        Some(s) => Source::Local(PathBuf::from(s)),
        None => Source::default(),
    })
}

fn pick_target(spec: Option<String>) -> Result<Install> {
    let installs = detect::discover_host();
    match spec {
        Some(s) if s.chars().all(|c| c.is_ascii_digit()) => installs.get(s.parse::<usize>()?).cloned().context("no installation with that index (see `vforge detect`)"),
        Some(s) => {
            let resources = detect::from_path(Path::new(&s))?;
            let canonical = std::fs::canonicalize(&resources)?;
            Ok(installs.into_iter().find(|i| i.resources == canonical).unwrap_or_else(|| Install {
                channel: detect::Channel::Stable,
                kind: detect::InstallKind::Native,
                writable: forge_core::fsutil::is_writable_dir(&canonical),
                modded: bootstrap::Resources::new(&canonical).ok().and_then(|r| r.state()),
                resources: canonical,
                version: None,
                flatpak_id: None,
            }))
        }
        None => match installs.len() {
            0 => match detect::bootstrap_only(&Roots::from_env()).first() {
                Some(base) => bail!("{} ({})", detect::BOOTSTRAP_HINT, base.display()),
                None => bail!("no Discord installation found; pass --target <path>"),
            },
            1 => Ok(installs.into_iter().next().unwrap()),
            _ => {
                let list: Vec<String> = installs.iter().enumerate().map(|(i, t)| format!("  {i}: {} — {}", t.title(), t.resources.display())).collect();
                bail!("several Discord installations found; pick one with --target <index>:\n{}", list.join("\n"))
            }
        },
    }
}

fn run(argv: Vec<String>) -> Result<()> {
    let Some((command, rest)) = argv.split_first() else {
        println!("{USAGE}");
        return Ok(());
    };
    let mut args = Args(rest.to_vec());
    match command.as_str() {
        "detect" => {
            let json = args.flag("--json");
            let local = args.flag("--local");
            args.done()?;
            let installs = if local { detect::discover(&Roots::from_env()) } else { detect::discover_host() };
            if json {
                println!("{}", serde_json::to_string_pretty(&installs)?);
            } else if installs.is_empty() {
                println!("No Discord installation found.");
                for base in detect::bootstrap_only(&Roots::from_env()) {
                    println!("Found {} — {}", base.display(), detect::BOOTSTRAP_HINT);
                }
            } else {
                for (i, t) in installs.iter().enumerate() {
                    let state = t.modded.map(|k| k.label()).unwrap_or("stock");
                    println!("{i}: {} {} [{state}{}]\n   {}", t.title(), t.version.as_deref().unwrap_or(""), if t.writable { "" } else { ", needs admin" }, t.resources.display());
                }
            }
        }
        "list" => {
            let src = source(&mut args)?;
            let json = args.flag("--json");
            args.done()?;
            let dist = pipeline::fetch_distribution(&src, &mut sink())?;
            let profile = Profile::load(&paths::runtime_dir());
            if json {
                println!("{}", serde_json::to_string_pretty(&serde_json::json!({"plugins": dist.plugins, "patches": dist.patches}))?);
            } else {
                println!("{} @ {}\n\nPlugins:", dist.manifest.name, &dist.revision[..dist.revision.len().min(12)]);
                for p in &dist.plugins {
                    println!("  [{}] {:<20} {}", if profile.plugin_enabled(&p.id) { "x" } else { " " }, p.id, p.description);
                }
                println!("\nPatches:");
                for p in &dist.patches {
                    let mark = if p.required { "req" } else if profile.patch_enabled(&p.id) { " x " } else { "   " };
                    println!("  [{mark}] {:<28} {}", p.id, p.description);
                }
            }
        }
        "install" => {
            let src = source(&mut args)?;
            let target = args.value("--target")?;
            let action = OpenAsarAction::parse(&args.value("--openasar")?.unwrap_or("keep".into()))?;
            let disable_plugins = args.values("--disable-plugin")?;
            let disable_patches = args.values("--disable-patch")?;
            let enable_all = args.flag("--enable-all");
            args.done()?;
            let target = pick_target(target)?;
            let mut out = sink();
            let dist = pipeline::fetch_distribution(&src, &mut out)?;
            let mut profile = if enable_all { Profile::default() } else { Profile::load(&paths::runtime_dir()) };
            profile.exclude_plugins.extend(disable_plugins);
            profile.exclude_patches.extend(disable_patches);
            for (patch, dep) in profile.unmet_requirements(&dist.manifest) {
                bail!("{patch} requires {dep}, which is turned off");
            }
            if pipeline::discord_running() {
                eprintln!("note: Discord is running; restart it after installing (Windows: close it first)");
            }
            let built = pipeline::build(&dist, &profile, &Cancel::default(), &mut out)?;
            let kind = pipeline::install(&dist, &built, &target, action, &profile, &mut out)?;
            println!("Installed into {} (bootstrap: {}). Restart Discord.", target.title(), kind.label());
        }
        "build" => {
            let src = source(&mut args)?;
            let out = args.value("--out")?.context("--out <file.asar> is required")?;
            let disable_plugins = args.values("--disable-plugin")?;
            let disable_patches = args.values("--disable-patch")?;
            args.done()?;
            let mut sink = sink();
            let dist = pipeline::fetch_distribution(&src, &mut sink)?;
            let mut profile = Profile::default();
            profile.exclude_plugins.extend(disable_plugins);
            profile.exclude_patches.extend(disable_patches);
            let built = pipeline::build(&dist, &profile, &Cancel::default(), &mut sink)?;
            forge_core::fsutil::replace_from(&built.runtime, Path::new(&out))?;
            println!("built {out} on upstream {}", &built.upstream[..12]);
        }
        "uninstall" => {
            let target = pick_target(args.value("--target")?)?;
            args.done()?;
            pipeline::uninstall(&target, &mut sink())?;
            println!("{} restored to stock.", target.title());
        }
        "status" => {
            args.done()?;
            let runtime = paths::runtime_dir().join("app.asar");
            println!("runtime: {} ({})", runtime.display(), if runtime.is_file() { "present" } else { "absent" });
            let profile = Profile::load(&paths::runtime_dir());
            println!("disabled plugins: {:?}\ndisabled patches: {:?}", profile.exclude_plugins, profile.exclude_patches);
            for t in detect::discover_host() {
                let chain = pipeline::verify_chain_anywhere(&t.resources, &runtime);
                println!("{}: {}", t.title(), match chain {
                    Ok(kind) => format!("Vencord active ({})", kind.label()),
                    Err(_) if t.modded.is_none() => "stock".into(),
                    Err(e) => format!("inconsistent: {e:#}"),
                });
            }
        }
        "pack-runtime" => {
            let [dist, out] = two(&args.0)?;
            asar::pack_runtime_dir(Path::new(dist), Path::new(out))?;
        }
        "apply-patch" => {
            let [root, file] = two(&args.0)?;
            patch::apply(Path::new(root), &std::fs::read_to_string(file)?)?;
        }
        "seeds" => {
            let [dir, out] = two(&args.0)?;
            userplugins::generate_seeds(Path::new(dir), Path::new(out))?;
        }
        "inventory" => {
            let dir = args.0.first().context("missing directory")?;
            println!("{}", serde_json::to_string(&userplugins::inventory(Path::new(dir))?)?);
        }
        "prepare-openasar" => {
            let [candidate, manifest] = two(&args.0)?;
            let m = forge_core::manifest::Manifest::load(Path::new(manifest))?;
            bootstrap::prepare_openasar(Path::new(candidate), &m.openasar.context("no openasar section")?.fixes)?;
        }
        "build-loader" => {
            let [runtime, out] = two(&args.0)?;
            bootstrap::build_loader(Path::new(runtime), Path::new(out))?;
        }
        "verify-chain" => {
            let [resources, runtime] = two(&args.0)?;
            let kind = bootstrap::Resources::new(Path::new(resources))?.verify_chain(Path::new(runtime), None)?;
            println!("chain verified ({})", kind.label());
        }
        "privileged-bootstrap" => {
            let a = &args.0;
            if a.len() < 4 {
                bail!("{USAGE}");
            }
            let candidate = a.get(4).map(PathBuf::from);
            let kind = pipeline::apply_bootstrap(Path::new(&a[0]), Path::new(&a[1]), Path::new(&a[2]), OpenAsarAction::parse(&a[3])?, candidate.as_deref())?;
            println!("chain verified ({})", kind.label());
        }
        "privileged-uninstall" => {
            let dir = args.0.first().context("missing resources directory")?;
            bootstrap::Resources::new(Path::new(dir))?.uninstall()?;
        }
        "-h" | "--help" | "help" => println!("{USAGE}"),
        other => bail!("unknown command {other}\n\n{USAGE}"),
    }
    Ok(())
}

fn two(a: &[String]) -> Result<[&str; 2]> {
    match a {
        [x, y] => Ok([x, y]),
        _ => bail!("expected two arguments\n\n{USAGE}"),
    }
}
