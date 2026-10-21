//! Vencord Forge: choose a Discord installation, plugins, patches and OpenAsar, then build and
//! install. All work runs on a background thread; the UI only renders state and events.

#![cfg_attr(windows, windows_subsystem = "windows")]

use eframe::egui::{self, Color32, CornerRadius, RichText, Stroke};
use forge_core::detect::{self, Install, Roots};
use forge_core::manifest::Choice;
use forge_core::pipeline::{self, Distribution, Event, OpenAsarAction, Source};
use forge_core::process::Cancel;
use forge_core::profile::Profile;
use forge_core::{bootstrap::BootstrapKind, paths};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender, channel};

const ACCENT: Color32 = Color32::from_rgb(0xeb, 0x6f, 0x92);
const BG: Color32 = Color32::from_rgb(0x0f, 0x10, 0x14);
const PANEL: Color32 = Color32::from_rgb(0x17, 0x18, 0x1e);
const CARD: Color32 = Color32::from_rgb(0x1e, 0x1f, 0x28);
const LINE: Color32 = Color32::from_rgb(0x2a, 0x2c, 0x38);
const MUTED: Color32 = Color32::from_rgb(0x9a, 0x9c, 0xad);
const OK: Color32 = Color32::from_rgb(0x2d, 0xd4, 0xa3);
const BAD: Color32 = Color32::from_rgb(0xff, 0x6b, 0x6b);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Page {
    Discord,
    Plugins,
    Patches,
    OpenAsar,
    Install,
}

impl Page {
    const ALL: [Page; 5] = [Page::Discord, Page::Plugins, Page::Patches, Page::OpenAsar, Page::Install];
    fn title(self) -> &'static str {
        match self {
            Page::Discord => "Discord",
            Page::Plugins => "Plugins",
            Page::Patches => "Patches",
            Page::OpenAsar => "OpenAsar",
            Page::Install => "Install",
        }
    }
    fn icon(self) -> &'static str {
        match self {
            Page::Discord => "1",
            Page::Plugins => "2",
            Page::Patches => "3",
            Page::OpenAsar => "4",
            Page::Install => "5",
        }
    }
}

enum Msg {
    Distribution(Result<Distribution, String>),
    Event(Event),
    Done(Result<String, String>),
}

#[derive(PartialEq, Eq)]
enum Job {
    Idle,
    Loading,
    Running,
}

struct App {
    page: Page,
    installs: Vec<Install>,
    target: Option<usize>,
    manual_path: String,
    source_text: String,
    dist: Option<Distribution>,
    dist_error: Option<String>,
    profile: Profile,
    openasar: OpenAsarAction,
    job: Job,
    cancel: Cancel,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    step: String,
    progress: f32,
    log: Vec<String>,
    result: Option<Result<String, String>>,
    show_log: bool,
    /// FORGE_SCREENSHOT_DIR: render every page, save PNGs, exit (visual checks without screen capture).
    shots: Option<(PathBuf, usize, u32)>,
}

/// Running from a checkout (`forge/target/...`)? Then build from that checkout by default.
fn local_checkout() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().find(|dir| dir.join("forge.json").is_file() && dir.join("patches/series").is_file()).map(PathBuf::from)
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        style(&cc.egui_ctx);
        let (tx, rx) = channel();
        let installs = detect::discover(&Roots::from_env());
        let target = (!installs.is_empty()).then_some(0);
        let openasar = match installs.first().and_then(|i| i.modded) {
            Some(BootstrapKind::Openasar) => OpenAsarAction::Keep,
            _ => OpenAsarAction::Install,
        };
        let source_text = local_checkout().map(|p| p.display().to_string()).unwrap_or_else(|| forge_core::manifest::DEFAULT_SOURCE.to_owned());
        let mut app = Self {
            page: Page::Discord,
            installs,
            target,
            manual_path: String::new(),
            source_text,
            dist: None,
            dist_error: None,
            profile: Profile::load(&paths::runtime_dir()),
            openasar,
            job: Job::Idle,
            cancel: Cancel::default(),
            tx,
            rx,
            step: String::new(),
            progress: 0.0,
            log: Vec::new(),
            result: None,
            show_log: false,
            shots: std::env::var_os("FORGE_SCREENSHOT_DIR").map(|d| (PathBuf::from(d), 0, 0)),
        };
        app.load_distribution(&cc.egui_ctx);
        app
    }

    fn source(&self) -> Source {
        let text = self.source_text.trim();
        if text.starts_with("https://") { Source::Remote(text.to_owned()) } else { Source::Local(PathBuf::from(text)) }
    }

    fn load_distribution(&mut self, ctx: &egui::Context) {
        self.job = Job::Loading;
        self.dist_error = None;
        let (tx, source, ctx) = (self.tx.clone(), self.source(), ctx.clone());
        std::thread::spawn(move || {
            let result = pipeline::fetch_distribution(&source, &mut |_| {}).map_err(|e| format!("{e:#}"));
            let _ = tx.send(Msg::Distribution(result));
            ctx.request_repaint();
        });
    }

    fn refresh_installs(&mut self) {
        self.installs = detect::discover(&Roots::from_env());
        if self.target.is_some_and(|t| t >= self.installs.len()) {
            self.target = (!self.installs.is_empty()).then_some(0);
        }
    }

    fn start(&mut self, ctx: &egui::Context, uninstall: bool) {
        let Some(target) = self.target.and_then(|t| self.installs.get(t)).cloned() else { return };
        let Some(dist) = self.dist.clone() else { return };
        self.job = Job::Running;
        self.result = None;
        self.log.clear();
        self.progress = 0.0;
        self.cancel = Cancel::default();
        let (tx, cancel, profile, action, ctx) = (self.tx.clone(), self.cancel.clone(), self.profile.clone(), self.openasar, ctx.clone());
        std::thread::spawn(move || {
            let mut sink = |event: Event| {
                let _ = tx.send(Msg::Event(event));
                ctx.request_repaint();
            };
            let result = (|| -> anyhow::Result<String> {
                if uninstall {
                    pipeline::uninstall(&target, &mut sink)?;
                    return Ok(format!("{} is back to stock. Restart Discord.", target.title()));
                }
                let built = pipeline::build(&dist, &profile, &cancel, &mut sink)?;
                let kind = pipeline::install(&dist, &built, &target, action, &profile, &mut sink)?;
                Ok(format!("Installed into {} with {} bootstrap. Restart Discord.", target.title(), if kind == BootstrapKind::Openasar { "OpenAsar" } else { "the original" }))
            })()
            .map_err(|e| format!("{e:#}"));
            let _ = tx.send(Msg::Done(result));
            ctx.request_repaint();
        });
    }

    fn pump(&mut self) {
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                Msg::Distribution(result) => {
                    self.job = Job::Idle;
                    match result {
                        Ok(dist) => {
                            self.profile.sanitize(&dist.manifest);
                            self.dist = Some(dist);
                        }
                        Err(e) => self.dist_error = Some(e),
                    }
                }
                Msg::Event(Event::Step(s)) => {
                    self.log.push(format!("» {s}"));
                    self.step = s;
                }
                Msg::Event(Event::Log(s)) => {
                    self.log.push(s);
                    if self.log.len() > 4000 {
                        self.log.drain(..1000);
                    }
                }
                Msg::Event(Event::Progress(p)) => self.progress = p,
                Msg::Done(result) => {
                    self.job = Job::Idle;
                    if result.is_ok() {
                        self.progress = 1.0;
                    }
                    self.result = Some(result);
                    self.refresh_installs();
                }
            }
        }
    }
}

fn style(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = BG;
    visuals.window_fill = PANEL;
    visuals.extreme_bg_color = Color32::from_rgb(0x0b, 0x0c, 0x10);
    visuals.selection.bg_fill = ACCENT;
    visuals.selection.stroke = Stroke::new(1.0_f32, Color32::WHITE);
    visuals.hyperlink_color = ACCENT;
    for w in [&mut visuals.widgets.inactive, &mut visuals.widgets.hovered, &mut visuals.widgets.active, &mut visuals.widgets.noninteractive, &mut visuals.widgets.open] {
        w.corner_radius = CornerRadius::same(8);
    }
    visuals.widgets.inactive.weak_bg_fill = CARD;
    visuals.widgets.inactive.bg_fill = CARD;
    visuals.widgets.hovered.weak_bg_fill = Color32::from_rgb(0x2a, 0x2b, 0x36);
    visuals.widgets.active.weak_bg_fill = Color32::from_rgb(0x34, 0x22, 0x2b);
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, LINE);
    ctx.set_visuals(visuals);
    ctx.style_mut(|s| {
        s.spacing.item_spacing = egui::vec2(10.0, 10.0);
        s.spacing.button_padding = egui::vec2(14.0, 8.0);
        s.text_styles.insert(egui::TextStyle::Body, egui::FontId::proportional(15.0));
        s.text_styles.insert(egui::TextStyle::Button, egui::FontId::proportional(15.0));
        s.text_styles.insert(egui::TextStyle::Heading, egui::FontId::proportional(24.0));
        s.text_styles.insert(egui::TextStyle::Small, egui::FontId::proportional(12.5));
    });
}

fn card(ui: &mut egui::Ui, selected: bool, add: impl FnOnce(&mut egui::Ui)) -> egui::Response {
    let frame = egui::Frame::new()
        .fill(if selected { Color32::from_rgb(0x2a, 0x1d, 0x25) } else { CARD })
        .stroke(Stroke::new(if selected { 1.5_f32 } else { 1.0 }, if selected { ACCENT } else { LINE }))
        .corner_radius(CornerRadius::same(12))
        .inner_margin(egui::Margin::same(14));
    let response = frame
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            add(ui)
        })
        .response;
    response.interact(egui::Sense::click())
}

/// Radio dot drawn with shapes (font independent).
fn radio(ui: &mut egui::Ui, on: bool) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(20.0, 20.0), egui::Sense::hover());
    let c = rect.center();
    ui.painter().circle_stroke(c, 8.0, Stroke::new(2.0_f32, if on { ACCENT } else { MUTED }));
    if on {
        ui.painter().circle_filled(c, 4.5, ACCENT);
    }
}

fn wrapped(ui: &mut egui::Ui, text: impl Into<egui::WidgetText>) {
    ui.add(egui::Label::new(text).wrap());
}

fn heading(ui: &mut egui::Ui, title: &str, subtitle: &str) {
    ui.add_space(6.0);
    ui.heading(RichText::new(title).strong());
    ui.label(RichText::new(subtitle).color(MUTED));
    ui.add_space(8.0);
}

/// A toggle switch.
fn switch(ui: &mut egui::Ui, on: &mut bool, enabled: bool) -> egui::Response {
    let size = egui::vec2(40.0, 22.0);
    let (rect, mut response) = ui.allocate_exact_size(size, if enabled { egui::Sense::click() } else { egui::Sense::hover() });
    if response.clicked() {
        *on = !*on;
        response.mark_changed();
    }
    let t = ui.ctx().animate_bool_responsive(response.id, *on);
    let fill = if enabled { Color32::from_rgb(0x3a, 0x3c, 0x4a).lerp_to_gamma(ACCENT, t) } else { Color32::from_rgb(0x55, 0x40, 0x48) };
    ui.painter().rect_filled(rect, CornerRadius::same(11), fill);
    let x = egui::lerp((rect.left() + 11.0)..=(rect.right() - 11.0), t);
    ui.painter().circle_filled(egui::pos2(x, rect.center().y), 8.0, Color32::WHITE);
    response
}

impl App {
    fn page_discord(&mut self, ui: &mut egui::Ui) {
        heading(ui, "Discord installation", "Forge found these installations. Stable, PTB, Canary and Development are all supported.");
        if self.installs.is_empty() {
            ui.colored_label(BAD, "No Discord installation found. Start Discord once, or point Forge to its folder below.");
        }
        let mut pick = None;
        for (i, install) in self.installs.iter().enumerate() {
            let selected = self.target == Some(i);
            let response = card(ui, selected, |ui| {
                ui.horizontal_top(|ui| {
                    radio(ui, selected);
                    ui.vertical(|ui| {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(install.title()).strong().size(16.0));
                            if let Some(v) = &install.version {
                                ui.label(RichText::new(v).color(MUTED));
                            }
                        });
                        let state = match install.modded {
                            None => ("stock Discord", MUTED),
                            Some(BootstrapKind::Openasar) => ("Vencord + OpenAsar installed", OK),
                            Some(_) => ("Vencord installed", OK),
                        };
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(state.0).color(state.1).small());
                            if !install.writable {
                                ui.label(RichText::new("· asks for your password when installing").color(MUTED).small());
                            }
                        });
                        wrapped(ui, RichText::new(install.resources.display().to_string()).color(MUTED).small().monospace());
                    });
                });
            });
            if response.clicked() {
                pick = Some(i);
            }
        }
        if let Some(i) = pick {
            self.target = Some(i);
            if self.installs[i].modded == Some(BootstrapKind::Openasar) {
                self.openasar = OpenAsarAction::Keep;
            }
        }
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            if ui.button("⟳ Rescan").clicked() {
                self.refresh_installs();
            }
            ui.add(egui::TextEdit::singleline(&mut self.manual_path).hint_text("…or paste a Discord folder").desired_width(360.0));
            if ui.button("Add").clicked() {
                match detect::from_path(std::path::Path::new(self.manual_path.trim())) {
                    Ok(resources) => {
                        let resources = std::fs::canonicalize(&resources).unwrap_or(resources);
                        if let Some(i) = self.installs.iter().position(|x| x.resources == resources) {
                            self.target = Some(i);
                        } else {
                            self.installs.push(Install {
                                channel: detect::Channel::Stable,
                                kind: detect::InstallKind::Native,
                                writable: forge_core::fsutil::is_writable_dir(&resources),
                                modded: forge_core::bootstrap::Resources::new(&resources).ok().and_then(|r| r.state()),
                                resources,
                                version: None,
                                flatpak_id: None,
                            });
                            self.target = Some(self.installs.len() - 1);
                        }
                        self.manual_path.clear();
                    }
                    Err(e) => self.dist_error = Some(format!("{e:#}")),
                }
            }
        });
    }

    fn choice_list(ui: &mut egui::Ui, items: &[Choice], is_on: impl Fn(&str) -> bool, mut set: impl FnMut(&str, bool)) {
        for item in items {
            let mut on = item.required || is_on(&item.id);
            card(ui, false, |ui| {
                ui.horizontal(|ui| {
                    let text_width = (ui.available_width() - 60.0).max(120.0);
                    ui.allocate_ui_with_layout(egui::vec2(text_width, 0.0), egui::Layout::top_down(egui::Align::Min), |ui| {
                        ui.set_width(text_width);
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(&item.title).strong().size(16.0));
                            if item.required {
                                ui.label(RichText::new("required").color(MUTED).small());
                            }
                        });
                        if !item.description.is_empty() {
                            wrapped(ui, RichText::new(&item.description).color(MUTED));
                        }
                        if !item.recommends.is_empty() {
                            wrapped(ui, RichText::new(format!("works best with {}", item.recommends.join(", "))).color(MUTED).small());
                        }
                    });
                    ui.add_space(ui.available_width() - 44.0);
                    if switch(ui, &mut on, !item.required).changed() {
                        set(&item.id, on);
                    }
                });
            });
        }
    }

    fn page_plugins(&mut self, ui: &mut egui::Ui) {
        heading(ui, "Custom plugins", "Turned-off plugins are not built in, and stay off after updates.");
        let Some(dist) = &self.dist else { return };
        let plugins = dist.plugins.clone();
        let profile = &mut self.profile;
        let excluded = profile.exclude_plugins.clone();
        Self::choice_list(ui, &plugins, |id| !excluded.contains(id), |id, on| {
            if on { profile.exclude_plugins.remove(id); } else { profile.exclude_plugins.insert(id.to_owned()); }
        });
    }

    fn page_patches(&mut self, ui: &mut egui::Ui) {
        heading(ui, "Patches", "Changes to Vencord itself. Required ones keep updates and the plugin manager working.");
        let Some(dist) = &self.dist else { return };
        let patches = dist.patches.clone();
        let profile = &mut self.profile;
        let excluded = profile.exclude_patches.clone();
        Self::choice_list(ui, &patches, |id| !excluded.contains(id), |id, on| {
            if on { profile.exclude_patches.remove(id); } else { profile.exclude_patches.insert(id.to_owned()); }
        });
    }

    fn page_openasar(&mut self, ui: &mut egui::Ui) {
        heading(ui, "OpenAsar", "A faster, leaner replacement for Discord's own startup code. Your original is backed up.");
        let current = self.target.and_then(|t| self.installs.get(t)).and_then(|i| i.modded);
        let options = [
            (OpenAsarAction::Install, "Install / update OpenAsar", "Faster startup. Gets the latest build with the Linux GPU and Flatpak fixes."),
            (OpenAsarAction::Keep, "Keep as it is", if current == Some(BootstrapKind::Openasar) { "OpenAsar is installed now; leave that version." } else { "Keep Discord's original startup code." }),
            (OpenAsarAction::Remove, "Remove OpenAsar", "Restore Discord's original startup code from the backup."),
        ];
        for (action, title, text) in options {
            let selected = self.openasar == action;
            if card(ui, selected, |ui| {
                ui.horizontal_top(|ui| {
                    radio(ui, selected);
                    ui.vertical(|ui| {
                        ui.label(RichText::new(title).strong().size(16.0));
                        wrapped(ui, RichText::new(text).color(MUTED));
                    });
                });
            })
            .clicked()
            {
                self.openasar = action;
            }
        }
    }

    fn page_install(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        heading(ui, "Install", "Builds Vencord with your selection, then swaps it in only once everything verifies.");
        let target = self.target.and_then(|t| self.installs.get(t)).cloned();
        card(ui, false, |ui| {
            ui.style_mut().wrap_mode = Some(egui::TextWrapMode::Extend);
            egui::Grid::new("summary").num_columns(2).spacing([24.0, 8.0]).show(ui, |ui| {
                ui.label(RichText::new("Discord").color(MUTED));
                ui.label(target.as_ref().map(|t| t.title()).unwrap_or_else(|| "none selected".into()));
                ui.end_row();
                if let Some(dist) = &self.dist {
                    let on_plugins = dist.plugins.iter().filter(|p| self.profile.plugin_enabled(&p.id)).count();
                    let on_patches = dist.patches.iter().filter(|p| p.required || self.profile.patch_enabled(&p.id)).count();
                    ui.label(RichText::new("Plugins").color(MUTED));
                    ui.label(format!("{on_plugins} of {}", dist.plugins.len()));
                    ui.end_row();
                    ui.label(RichText::new("Patches").color(MUTED));
                    ui.label(format!("{on_patches} of {}", dist.patches.len()));
                    ui.end_row();
                }
                ui.label(RichText::new("OpenAsar").color(MUTED));
                ui.label(self.openasar.as_str());
                ui.end_row();
            });
        });
        ui.add_space(8.0);
        let busy = self.job != Job::Idle;
        let ready = target.is_some() && self.dist.is_some();
        ui.horizontal(|ui| {
            let install = egui::Button::new(RichText::new("  Install  ").strong().size(17.0).color(Color32::BLACK)).fill(ACCENT).min_size(egui::vec2(160.0, 42.0));
            if ui.add_enabled(ready && !busy, install).clicked() {
                self.start(ctx, false);
            }
            if busy && self.job == Job::Running && ui.button("Cancel").clicked() {
                self.cancel.cancel();
            }
            if !busy && target.as_ref().is_some_and(|t| t.modded.is_some()) && ui.button("Restore stock Discord").clicked() {
                self.start(ctx, true);
            }
        });
        if pipeline::discord_running() && !busy {
            ui.label(RichText::new("Discord is running. That's fine on Linux; restart it afterwards. On Windows close it first.").color(MUTED).small());
        }
        if self.job == Job::Running || self.progress > 0.0 {
            ui.add_space(6.0);
            ui.add(egui::ProgressBar::new(self.progress).text(self.step.clone()).animate(self.job == Job::Running).fill(ACCENT).corner_radius(CornerRadius::same(8)));
        }
        if let Some(result) = &self.result {
            match result {
                Ok(text) => wrapped(ui, RichText::new(format!("Done. {text}")).color(OK).size(16.0)),
                Err(text) => wrapped(ui, RichText::new(format!("Failed: {text}")).color(BAD)),
            };
        }
        ui.add_space(6.0);
        ui.checkbox(&mut self.show_log, "Show details");
        if self.show_log {
            egui::Frame::new().fill(Color32::from_rgb(0x0b, 0x0c, 0x10)).corner_radius(CornerRadius::same(10)).inner_margin(egui::Margin::same(10)).show(ui, |ui| {
                egui::ScrollArea::vertical().stick_to_bottom(true).max_height(260.0).auto_shrink([false, false]).show(ui, |ui| {
                    for line in &self.log {
                        ui.label(RichText::new(line).monospace().size(12.0).color(if line.starts_with('»') { ACCENT } else { MUTED }));
                    }
                });
            });
        }
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.pump();
        self.screenshots(ctx);
        egui::SidePanel::left("nav").exact_width(220.0).frame(egui::Frame::new().fill(PANEL).inner_margin(egui::Margin::same(16))).show(ctx, |ui| {
            ui.add_space(4.0);
            ui.label(RichText::new("Vencord Forge").size(20.0).strong());
            ui.label(RichText::new(self.dist.as_ref().map(|d| d.manifest.name.clone()).unwrap_or_else(|| "loading…".into())).color(MUTED).small());
            ui.add_space(16.0);
            for page in Page::ALL {
                let selected = self.page == page;
                let text = RichText::new(format!("{}   {}", page.icon(), page.title())).size(16.0).color(if selected { Color32::WHITE } else { MUTED });
                let button = egui::Button::new(text).fill(if selected { Color32::from_rgb(0x2a, 0x1d, 0x25) } else { Color32::TRANSPARENT }).stroke(Stroke::new(1.0_f32, if selected { ACCENT } else { Color32::TRANSPARENT })).min_size(egui::vec2(188.0, 38.0));
                if ui.add(button).clicked() {
                    self.page = page;
                }
            }
            ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| {
                ui.add_space(4.0);
                let edit = ui.add(egui::TextEdit::singleline(&mut self.source_text).desired_width(188.0).font(egui::TextStyle::Small));
                if edit.lost_focus() && self.job == Job::Idle {
                    self.load_distribution(ctx);
                }
                ui.label(RichText::new("Source (GitHub URL or folder)").color(MUTED).small());
            });
        });
        egui::CentralPanel::default().frame(egui::Frame::new().fill(BG).inner_margin(egui::Margin::symmetric(28, 18))).show(ctx, |ui| {
            if self.job == Job::Loading {
                ui.horizontal(|ui| {
                    ui.spinner();
                    ui.label("Loading the distribution…");
                });
            }
            if let Some(error) = self.dist_error.clone() {
                ui.colored_label(BAD, error);
                if ui.button("Retry").clicked() {
                    self.load_distribution(ctx);
                }
            }
            egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                ui.set_max_width(ui.available_width().min(820.0));
                ui.style_mut().wrap_mode = Some(egui::TextWrapMode::Wrap);
                match self.page {
                    Page::Discord => self.page_discord(ui),
                    Page::Plugins => self.page_plugins(ui),
                    Page::Patches => self.page_patches(ui),
                    Page::OpenAsar => self.page_openasar(ui),
                    Page::Install => self.page_install(ui, ctx),
                }
                ui.add_space(12.0);
                let index = Page::ALL.iter().position(|p| *p == self.page).unwrap();
                ui.horizontal(|ui| {
                    if index > 0 && ui.button("Back").clicked() {
                        self.page = Page::ALL[index - 1];
                    }
                    if index + 1 < Page::ALL.len() && ui.add(egui::Button::new(RichText::new("Next").strong())).clicked() {
                        self.page = Page::ALL[index + 1];
                    }
                });
            });
        });
    }
}

impl App {
    fn screenshots(&mut self, ctx: &egui::Context) {
        let Some((dir, page, frames)) = self.shots.as_mut() else { return };
        let saved = ctx.input(|i| i.raw.events.iter().find_map(|e| match e {
            egui::Event::Screenshot { image, .. } => Some(image.clone()),
            _ => None,
        }));
        if let Some(image) = saved {
            let path = dir.join(format!("{}-{}.png", *page, Page::ALL[*page].title().to_lowercase()));
            let file = std::fs::File::create(&path).expect("screenshot file");
            let mut encoder = png::Encoder::new(file, image.size[0] as u32, image.size[1] as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().unwrap().write_image_data(image.as_raw()).unwrap();
            *page += 1;
            *frames = 0;
            if *page >= Page::ALL.len() {
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                return;
            }
        }
        self.page = Page::ALL[(*page).min(Page::ALL.len() - 1)];
        if *page == Page::ALL.len() - 1 {
            self.show_log = true;
        }
        *frames += 1;
        // Let the distribution load and animations settle before capturing.
        if *frames == 15 && self.job == Job::Idle {
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(egui::UserData::default()));
        } else if *frames > 15 && self.job != Job::Idle {
            *frames = 0;
        }
        ctx.request_repaint();
    }
}

const ICON_PNG: &[u8] = include_bytes!("../assets/icon.png");
const ICON_SVG: &[u8] = include_bytes!("../assets/icon.svg");

fn icon() -> Option<egui::IconData> {
    let mut reader = png::Decoder::new(std::io::Cursor::new(ICON_PNG)).read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    buf.truncate(info.buffer_size());
    (info.color_type == png::ColorType::Rgba).then_some(egui::IconData { rgba: buf, width: info.width, height: info.height })
}

/// Linux: register a launcher (app menu entry + icon) pointing at this executable, so Forge opens
/// like any other app instead of from a terminal. Rewritten when the executable moves.
fn register_launcher() {
    if !cfg!(target_os = "linux") {
        return;
    }
    let (Ok(exe), Some(home)) = (std::env::current_exe(), std::env::var_os("HOME").map(PathBuf::from)) else { return };
    let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share"));
    let icon_dir = data.join("icons/hicolor/scalable/apps");
    let entry = format!(
        "[Desktop Entry]\nType=Application\nName=Vencord Forge\nComment=Build and install Vencord with your plugins into Discord\nExec=\"{}\"\nIcon=vencord-forge\nTerminal=false\nCategories=Utility;Network;\nStartupWMClass=vencord-forge\n",
        exe.display()
    );
    let path = data.join("applications/vencord-forge.desktop");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(entry.as_str()) {
        let _ = std::fs::create_dir_all(&icon_dir);
        let _ = std::fs::write(icon_dir.join("vencord-forge.svg"), ICON_SVG);
        let _ = std::fs::create_dir_all(path.parent().unwrap());
        let _ = std::fs::write(&path, entry);
    }
}

fn main() -> eframe::Result<()> {
    register_launcher();
    let mut viewport = egui::ViewportBuilder::default().with_title("Vencord Forge").with_app_id("vencord-forge");
    if let Some(icon) = icon() {
        viewport = viewport.with_icon(icon);
    }
    let options = eframe::NativeOptions {
        viewport: viewport
            .with_inner_size([1000.0, 680.0])
            .with_min_inner_size([760.0, 520.0]),
        ..Default::default()
    };
    eframe::run_native("Vencord Forge", options, Box::new(|cc| Ok(Box::new(App::new(cc)))))
}
