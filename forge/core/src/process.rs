//! Child processes with streamed output and cancellation.

use anyhow::{Result, bail};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// No console window flashing up for every child on Windows.
pub fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = command;
}

/// A command that runs on the host: directly, or through `flatpak-spawn --host` inside Forge's
/// Flatpak (pkexec, `flatpak override`, process listing).
pub fn host_command(program: &str) -> Command {
    if crate::paths::in_flatpak() {
        let mut command = Command::new("flatpak-spawn");
        command.arg("--host").arg(program);
        command
    } else {
        Command::new(program)
    }
}

/// Arguments that run Forge's own executable on the host. Inside Flatpak the binary is built
/// against the runtime's glibc, which can be newer than the host's, so it is started with the
/// runtime's dynamic loader and libraries (the runtime's host path is in /.flatpak-info).
pub fn host_cli_args(cli: &std::path::Path) -> Vec<std::ffi::OsString> {
    let mut args = Vec::new();
    if crate::paths::in_flatpak()
        && let Some(runtime) = std::fs::read_to_string("/.flatpak-info").ok().and_then(|info| {
            info.lines().find_map(|l| l.strip_prefix("runtime-path=").map(|p| std::path::PathBuf::from(p.trim())))
        })
    {
        let (triple, loader) = if cfg!(target_arch = "aarch64") { ("aarch64-linux-gnu", "ld-linux-aarch64.so.1") } else { ("x86_64-linux-gnu", "ld-linux-x86-64.so.2") };
        let libs = runtime.join("lib").join(triple);
        args.push(libs.join(loader).into_os_string());
        args.push("--library-path".into());
        args.push(libs.into_os_string());
    }
    args.push(cli.as_os_str().to_owned());
    args
}

/// Forge's own executable on the host (directly, or via flatpak-spawn inside Flatpak).
pub fn host_cli(cli: &std::path::Path) -> Command {
    let args = host_cli_args(cli);
    let mut command = host_command(&args[0].to_string_lossy());
    command.args(&args[1..]);
    command
}

#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            bail!("cancelled");
        }
        Ok(())
    }
}

/// Run to completion, sending each output line to `log`; kill the child if cancelled.
pub fn run(mut command: Command, what: &str, cancel: &Cancel, log: &mut dyn FnMut(String)) -> Result<()> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    let mut child = command.spawn().map_err(|e| anyhow::anyhow!("{what}: cannot start: {e}"))?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let mut readers = Vec::new();
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>)].into_iter().flatten() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        }));
    }
    drop(tx);
    let mut tail: Vec<String> = Vec::new();
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                tail.push(line.clone());
                if tail.len() > 30 {
                    tail.remove(0);
                }
                log(line);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if cancel.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            bail!("cancelled");
        }
    }
    for reader in readers {
        let _ = reader.join();
    }
    let status = child.wait()?;
    if !status.success() {
        bail!("{what} failed ({status})\n{}", tail.join("\n"));
    }
    Ok(())
}
