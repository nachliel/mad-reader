//! Mad Reader — a fast, good-looking Markdown reader for Windows with
//! first-class Hebrew / RTL support.
//!
//! Architecture: Rust parses and renders Markdown (pulldown-cmark + syntect),
//! sanitizes it (ammonia) and hands the HTML to a WebView2 view (wry/tao).
//! The UI shell (assets/ui/*) is embedded in the binary and served from a
//! private `madreader` protocol; local images next to the document are served
//! through the same protocol under `/doc/<absolute path>`.

#![windows_subsystem = "windows"]

mod install;
mod render;
mod settings;

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde_json::{Value, json};
use tao::dpi::{LogicalSize, PhysicalPosition};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::IconExtWindows;
use tao::window::{Fullscreen, Icon, Theme, Window, WindowBuilder};
use wry::http::{Request, Response, header};
use wry::{DragDropEvent, NewWindowResponse, ScrollBarStyle, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows};

use settings::Settings;

const ORIGIN: &str = "http://madreader.localhost";
const DOC_PREFIX: &str = "http://madreader.localhost/doc/";
const VERSION: &str = env!("CARGO_PKG_VERSION");

const INDEX_HTML: &str = include_str!("../assets/ui/index.html");
const APP_CSS: &str = include_str!("../assets/ui/app.css");
const APP_JS: &str = include_str!("../assets/ui/app.js");
const ICON_PNG: &[u8] = include_bytes!("../assets/app-256.png");
const GUIDE_MD: &str = include_str!("../docs/guide.md");

/// Characters escaped in each path segment of a `/doc/` URL.
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~').remove(b':');

#[derive(Debug)]
enum UserEvent {
    Ipc(String),
    OpenPaths(Vec<PathBuf>),
    OpenExternal(String),
    Dragging(bool),
    FileChanged,
    Show,
}

#[derive(Clone, PartialEq, Debug)]
enum Doc {
    File(PathBuf),
    Guide,
}

#[derive(Default)]
struct Watched {
    path: Option<PathBuf>,
    stamp: Option<(SystemTime, u64)>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let quiet = args.iter().any(|a| a == "--quiet" || a == "/S" || a == "/quiet");

    match args.first().map(String::as_str) {
        Some("--install") => {
            match install::install() {
                Ok(exe) => {
                    if !quiet {
                        let launch = ask(
                            "Mad Reader installed",
                            &format!(
                                "Mad Reader {VERSION} was installed to:\n{}\n\nIt is in your Start menu and in \"Open with\" for Markdown files.\n\nTo open .md files with it by double-click, choose Mad Reader in Settings → Default apps (will open now).\n\nLaunch Mad Reader now?",
                                exe.display()
                            ),
                        );
                        install::open_default_apps();
                        if launch {
                            let _ = std::process::Command::new(&exe).spawn();
                        }
                    }
                }
                Err(e) => error_box(&format!("Installation failed:\n{e}")),
            }
            return;
        }
        Some("--uninstall") => {
            if quiet || ask("Uninstall Mad Reader", "Remove Mad Reader, its file associations and its settings?") {
                match install::uninstall() {
                    Ok(()) if !quiet => info_box("Mad Reader", "Mad Reader was uninstalled."),
                    Ok(()) => {}
                    Err(e) => error_box(&format!("Uninstall failed:\n{e}")),
                }
            }
            return;
        }
        Some("--register") => {
            if let Err(e) = std::env::current_exe().and_then(|exe| install::register(&exe)) {
                if !quiet {
                    error_box(&format!("Registration failed:\n{e}"));
                }
            }
            return;
        }
        Some("--unregister") => {
            let _ = install::unregister();
            return;
        }
        Some("--default-apps") => {
            install::open_default_apps();
            return;
        }
        Some("--version") | Some("-V") => {
            info_box("Mad Reader", &format!("Mad Reader {VERSION}"));
            return;
        }
        Some("--help") | Some("-h") | Some("/?") => {
            info_box(
                "Mad Reader — command line",
                "MadReader.exe [file.md]          open a file\n\
                 MadReader.exe --install          install for the current user\n\
                 MadReader.exe --uninstall        uninstall (add --quiet for silent)\n\
                 MadReader.exe --register         register file associations for this exe\n\
                 MadReader.exe --unregister       remove file associations\n\
                 MadReader.exe --default-apps     open Settings → Default apps\n\
                 MadReader.exe --version",
            );
            return;
        }
        _ => {}
    }

    let file = args.iter().find(|a| !a.starts_with("--")).map(|a| absolute(Path::new(a)));
    if let Err(e) = run(file) {
        error_box(&format!(
            "Mad Reader could not start:\n{e}\n\nMad Reader needs the Microsoft Edge WebView2 Runtime, which ships with Windows 10/11. \
             If it is missing, install it from https://developer.microsoft.com/microsoft-edge/webview2/"
        ));
    }
}

fn run(initial: Option<PathBuf>) -> Result<(), Box<dyn std::error::Error>> {
    render::prewarm();

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let settings = Settings::load();

    let dark = match settings.ui_str("theme").unwrap_or("system") {
        "dark" => true,
        "light" | "sepia" => false,
        _ => system_prefers_dark(),
    };
    let bg = match settings.ui_str("theme") {
        Some("sepia") => (246, 239, 224, 255),
        _ if dark => (22, 23, 27, 255),
        _ => (255, 255, 255, 255),
    };

    let ws = &settings.window;
    let mut wb = WindowBuilder::new()
        .with_title("Mad Reader")
        .with_window_icon(Icon::from_resource(1, None).ok())
        .with_inner_size(LogicalSize::new(
            if ws.width >= 420.0 { ws.width } else { 1100.0 },
            if ws.height >= 320.0 { ws.height } else { 820.0 },
        ))
        .with_min_inner_size(LogicalSize::new(420.0, 320.0))
        .with_theme(Some(if dark { Theme::Dark } else { Theme::Light }))
        .with_maximized(ws.maximized)
        .with_visible(false);
    if let (Some(x), Some(y)) = (ws.x, ws.y) {
        let on_screen = event_loop.available_monitors().any(|m| {
            let (p, s) = (m.position(), m.size());
            x >= p.x - 50 && y >= p.y - 10 && x < p.x + s.width as i32 - 100 && y < p.y + s.height as i32 - 100
        });
        if on_screen {
            wb = wb.with_position(PhysicalPosition::new(x, y));
        }
    }
    let window = wb.build(&event_loop)?;

    let mut ctx = WebContext::new(Some(settings::data_dir().join("WebView2")));
    let p_ipc = proxy.clone();
    let p_drop = proxy.clone();
    let p_nav = proxy.clone();
    let p_new = proxy.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut ctx)
        .with_custom_protocol("madreader".into(), |_id, req| protocol(req))
        .with_url(format!("{ORIGIN}/"))
        .with_background_color(bg)
        .with_ipc_handler(move |req: Request<String>| {
            let _ = p_ipc.send_event(UserEvent::Ipc(req.into_body()));
        })
        .with_drag_drop_handler(move |e| {
            let _ = match e {
                DragDropEvent::Enter { .. } => p_drop.send_event(UserEvent::Dragging(true)),
                DragDropEvent::Leave => p_drop.send_event(UserEvent::Dragging(false)),
                DragDropEvent::Drop { paths, .. } => {
                    let _ = p_drop.send_event(UserEvent::Dragging(false));
                    p_drop.send_event(UserEvent::OpenPaths(paths))
                }
                _ => Ok(()),
            };
            true
        })
        .with_navigation_handler(move |url| {
            if url.starts_with(ORIGIN) && !url.starts_with(DOC_PREFIX) {
                return true;
            }
            // Anything else (a stray link the UI did not intercept) goes to the right place.
            let _ = p_nav.send_event(UserEvent::OpenExternal(url));
            false
        })
        .with_new_window_req_handler(move |url, _| {
            let _ = p_new.send_event(UserEvent::OpenExternal(url));
            NewWindowResponse::Deny
        })
        .with_hotkeys_zoom(false)
        .with_browser_accelerator_keys(false)
        .with_devtools(cfg!(debug_assertions))
        .with_scroll_bar_style(ScrollBarStyle::FluentOverlay)
        .build(&window)?;

    // Live reload: poll the open file's timestamp (cheap, robust with any editor).
    let watched = Arc::new(Mutex::new(Watched::default()));
    spawn_watcher(watched.clone(), proxy.clone());

    // Never leave an invisible window around if the UI is slow to start.
    {
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(2500));
            let _ = proxy.send_event(UserEvent::Show);
        });
    }

    let mut app = App {
        window,
        webview,
        settings,
        current: None,
        history: Vec::new(),
        hist_pos: 0,
        watched,
        pending: initial.map(Doc::File),
        ready: false,
        shown: false,
        proxy,
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        let _ = &ctx; // keep the WebView2 environment alive for the app's lifetime
        match event {
            Event::NewEvents(StartCause::Init) => {}
            Event::UserEvent(ev) => app.on_user_event(ev, control_flow),
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                app.save_window_state();
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

struct App {
    window: Window,
    webview: WebView,
    settings: Settings,
    current: Option<Doc>,
    history: Vec<Doc>,
    hist_pos: usize,
    watched: Arc<Mutex<Watched>>,
    pending: Option<Doc>,
    ready: bool,
    shown: bool,
    proxy: EventLoopProxy<UserEvent>,
}

impl App {
    fn on_user_event(&mut self, ev: UserEvent, control_flow: &mut ControlFlow) {
        match ev {
            UserEvent::Ipc(msg) => self.on_ipc(&msg, control_flow),
            UserEvent::OpenPaths(paths) => {
                let mut it = paths.into_iter();
                if let Some(first) = it.next() {
                    self.open(Doc::File(first), None, true, false);
                }
                // Extra dropped files open in their own windows.
                for p in it {
                    spawn_self(Some(&p));
                }
            }
            UserEvent::OpenExternal(url) => self.follow_link(&url),
            UserEvent::Dragging(on) => self.js(&format!("MR.dragging({on})")),
            UserEvent::FileChanged => {
                if let Some(doc) = self.current.clone() {
                    self.open(doc, None, false, true);
                }
            }
            UserEvent::Show => self.show(),
        }
    }

    fn on_ipc(&mut self, msg: &str, control_flow: &mut ControlFlow) {
        let Ok(v) = serde_json::from_str::<Value>(msg) else { return };
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match v.get("cmd").and_then(Value::as_str).unwrap_or("") {
            "ready" => {
                self.ready = true;
                let init = json!({
                    "version": VERSION,
                    "ui": self.settings.ui,
                    "recent": self.recent_existing(),
                    "registered": install::is_registered(),
                    "installed": install::running_from_install_dir(),
                    "isDefault": install::is_default(),
                    "dismissedDefaultHint": self.settings.dismissed_default_hint,
                });
                self.js(&format!("MR.init({init})"));
                if let Some(doc) = self.pending.take().or_else(|| self.current.clone()) {
                    self.open(doc, None, true, false);
                }
                self.show();
            }
            "open" => {
                let mut dlg = rfd::FileDialog::new()
                    .set_title("Open Markdown file")
                    .add_filter("Markdown", &["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdtxt", "mdtext", "mdx", "txt"])
                    .add_filter("All files", &["*"])
                    .set_parent(&self.window);
                if let Some(Doc::File(p)) = &self.current {
                    if let Some(d) = p.parent() {
                        dlg = dlg.set_directory(d);
                    }
                }
                if let Some(p) = dlg.pick_file() {
                    self.open(Doc::File(p), None, true, false);
                }
            }
            "openPath" => {
                let p = PathBuf::from(s("path"));
                if v.get("newWindow").and_then(Value::as_bool).unwrap_or(false) {
                    spawn_self(Some(&p));
                } else {
                    self.open(Doc::File(p), None, true, false);
                }
            }
            "guide" => self.open(Doc::Guide, None, true, false),
            "home" => {
                self.current = None;
                self.watch(None);
                self.window.set_title("Mad Reader");
                let recent = json!(self.recent_existing());
                self.js(&format!("MR.home({recent})"));
            }
            "link" => self.follow_link(&s("href")),
            "back" => self.go_history(-1),
            "forward" => self.go_history(1),
            "reload" => {
                if let Some(doc) = self.current.clone() {
                    self.open(doc, None, false, true);
                }
            }
            "ui" => {
                if let Some(ui) = v.get("ui") {
                    self.settings.ui = ui.clone();
                    let ui = ui.clone();
                    update_settings(|st| st.ui = ui);
                }
            }
            "theme" => {
                let dark = v.get("dark").and_then(Value::as_bool).unwrap_or(false);
                self.window.set_theme(Some(if dark { Theme::Dark } else { Theme::Light }));
            }
            "install" => match install::install() {
                Ok(_) => {
                    self.js("MR.installed(true)");
                    install::open_default_apps();
                }
                Err(e) => self.toast(&format!("Install failed: {e}")),
            },
            "register" => {
                let ok = std::env::current_exe().and_then(|exe| install::register(&exe)).is_ok();
                if ok {
                    install::open_default_apps();
                }
            }
            "defaultApps" => install::open_default_apps(),
            "dismissHint" => {
                self.settings.dismissed_default_hint = true;
                update_settings(|st| st.dismissed_default_hint = true);
            }
            "clearRecent" => {
                self.settings.recent.clear();
                update_settings(|st| st.recent.clear());
            }
            "removeRecent" => {
                let p = s("path");
                self.settings.recent.retain(|r| r != &p);
                update_settings(|st| st.recent.retain(|r| r != &p));
            }
            "reveal" => {
                if let Some(Doc::File(p)) = &self.current {
                    use std::os::windows::process::CommandExt;
                    let _ = std::process::Command::new("explorer.exe")
                        .raw_arg(format!("/select,\"{}\"", p.display()))
                        .spawn();
                }
            }
            "edit" => {
                if let Some(Doc::File(p)) = &self.current {
                    let target = p.to_string_lossy();
                    if !shell_exec("edit", &target) {
                        let _ = std::process::Command::new("notepad.exe").arg(p).spawn();
                    }
                }
            }
            "openWith" => {
                if let Some(Doc::File(p)) = &self.current {
                    let _ = std::process::Command::new("rundll32.exe")
                        .arg("shell32.dll,OpenAs_RunDLL")
                        .arg(p)
                        .spawn();
                }
            }
            "newWindow" => spawn_self(None),
            "fullscreen" => {
                let fs = if self.window.fullscreen().is_some() { None } else { Some(Fullscreen::Borderless(None)) };
                self.window.set_fullscreen(fs);
            }
            "close" => {
                self.save_window_state();
                *control_flow = ControlFlow::Exit;
            }
            "external" => {
                shell_open(&s("url"));
            }
            _ => {}
        }
    }

    fn open(&mut self, doc: Doc, fragment: Option<String>, push_history: bool, is_reload: bool) {
        if !self.ready {
            self.pending = Some(doc);
            return;
        }
        let (text, path) = match &doc {
            Doc::Guide => (GUIDE_MD.to_string(), None),
            Doc::File(p) => {
                let p = absolute(p);
                if p.is_dir() {
                    shell_open(&p.to_string_lossy());
                    return;
                }
                match read_text(&p) {
                    Ok(t) => (t, Some(p)),
                    Err(e) => {
                        if !is_reload {
                            self.toast(&format!("Can't open {}: {e}", p.display()));
                        }
                        return;
                    }
                }
            }
        };
        let doc = match path {
            Some(ref p) => Doc::File(p.clone()),
            None => Doc::Guide,
        };

        let started = std::time::Instant::now();
        let r = render::render(&text);
        let render_ms = started.elapsed().as_secs_f64() * 1000.0;

        let (name, dir, base, url) = match &path {
            Some(p) => {
                let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let dir = p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
                let base = p.parent().map(dir_url).unwrap_or_else(|| format!("{ORIGIN}/"));
                let url = file_url(p);
                (name, dir, base, url)
            }
            None => ("User guide".to_string(), String::new(), format!("{ORIGIN}/"), format!("{ORIGIN}/guide")),
        };

        let navigating = self.current.as_ref() != Some(&doc);
        if push_history && navigating {
            self.history.truncate(if self.history.is_empty() { 0 } else { self.hist_pos + 1 });
            self.history.push(doc.clone());
            self.hist_pos = self.history.len() - 1;
        }

        if let Some(p) = &path {
            if !is_reload {
                self.settings.push_recent(p);
                let p2 = p.clone();
                update_settings(move |st| st.push_recent(&p2));
            }
        }
        self.current = Some(doc);
        self.watch(path.clone());

        let title = r.title.clone().unwrap_or_else(|| name.clone());
        self.window.set_title(&if title == name { format!("{name} — Mad Reader") } else { format!("{title} — Mad Reader") });

        let payload = json!({
            "path": path.as_ref().map(|p| p.to_string_lossy().to_string()),
            "name": name,
            "dir": dir,
            "base": base,
            "url": url,
            "html": r.html,
            "title": r.title,
            "words": r.words,
            "bytes": text.len(),
            "renderMs": (render_ms * 10.0).round() / 10.0,
            "fragment": fragment,
            "reload": is_reload && !navigating,
            "canBack": self.hist_pos > 0,
            "canForward": self.hist_pos + 1 < self.history.len(),
            "isGuide": path.is_none(),
        });
        self.js(&format!("MR.load({payload})"));
    }

    fn go_history(&mut self, delta: i32) {
        let target = self.hist_pos as i32 + delta;
        if target < 0 || target as usize >= self.history.len() {
            return;
        }
        self.hist_pos = target as usize;
        let doc = self.history[self.hist_pos].clone();
        self.js("MR.rememberScroll()");
        self.open(doc, None, false, false);
    }

    fn follow_link(&mut self, href: &str) {
        let href = href.trim();
        if let Some(rest) = href.strip_prefix(DOC_PREFIX) {
            let (rest, fragment) = match rest.split_once('#') {
                Some((a, f)) => (a, Some(percent_decode_str(f).decode_utf8_lossy().to_string())),
                None => (rest, None),
            };
            let rest = rest.split('?').next().unwrap_or("");
            let path = PathBuf::from(percent_decode_str(rest).decode_utf8_lossy().replace('/', "\\"));
            self.open_local(path, fragment);
        } else if let Some(rest) = href.strip_prefix("file:///") {
            let path = PathBuf::from(percent_decode_str(rest).decode_utf8_lossy().replace('/', "\\"));
            self.open_local(path, None);
        } else if href == format!("{ORIGIN}/guide") || href.starts_with(&format!("{ORIGIN}/guide#")) {
            self.open(Doc::Guide, href.split_once('#').map(|(_, f)| f.to_string()), true, false);
        } else if ["http://", "https://", "mailto:", "ms-settings:"].iter().any(|p| href.to_ascii_lowercase().starts_with(p))
            && !href.starts_with(ORIGIN)
        {
            shell_open(href);
        }
    }

    fn open_local(&mut self, path: PathBuf, fragment: Option<String>) {
        if is_markdown(&path) && path.is_file() {
            self.js("MR.rememberScroll()");
            self.open(Doc::File(path), fragment, true, false);
        } else if path.exists() {
            shell_open(&path.to_string_lossy());
        } else {
            self.toast(&format!("Not found: {}", path.display()));
        }
    }

    fn watch(&self, path: Option<PathBuf>) {
        let stamp = path.as_deref().and_then(file_stamp);
        if let Ok(mut w) = self.watched.lock() {
            w.path = path;
            w.stamp = stamp;
        }
    }

    fn recent_existing(&self) -> Vec<Value> {
        self.settings
            .recent
            .iter()
            .map(|r| {
                let p = Path::new(r);
                json!({
                    "path": r,
                    "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| r.clone()),
                    "dir": p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
                    "exists": p.exists(),
                })
            })
            .collect()
    }

    fn show(&mut self) {
        if !self.shown {
            self.shown = true;
            self.window.set_visible(true);
            self.window.set_focus();
            let _ = self.webview.focus();
        }
    }

    fn toast(&self, msg: &str) {
        self.js(&format!("MR.toast({})", json!(msg)));
    }

    fn js(&self, code: &str) {
        let _ = self.webview.evaluate_script(&format!("window.MR && {code}"));
    }

    fn save_window_state(&self) {
        let maximized = self.window.is_maximized();
        let scale = self.window.scale_factor();
        let size = self.window.inner_size().to_logical::<f64>(scale);
        let pos = self.window.outer_position().ok();
        let fullscreen = self.window.fullscreen().is_some();
        update_settings(move |st| {
            st.window.maximized = maximized;
            if !maximized && !fullscreen {
                st.window.width = size.width;
                st.window.height = size.height;
                if let Some(p) = pos {
                    st.window.x = Some(p.x);
                    st.window.y = Some(p.y);
                }
            }
        });
        let _ = &self.proxy;
    }
}

/// Load-modify-save so several open windows don't clobber each other's changes.
fn update_settings(f: impl FnOnce(&mut Settings)) {
    let mut s = Settings::load();
    f(&mut s);
    s.save();
}

fn spawn_watcher(watched: Arc<Mutex<Watched>>, proxy: EventLoopProxy<UserEvent>) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(300));
            let path = match watched.lock() {
                Ok(w) => w.path.clone(),
                Err(_) => return,
            };
            let Some(path) = path else { continue };
            let Some(stamp) = file_stamp(&path) else { continue }; // mid-save or deleted
            let changed = {
                let mut w = watched.lock().unwrap();
                if w.path.as_ref() == Some(&path) && w.stamp != Some(stamp) {
                    w.stamp = Some(stamp);
                    true
                } else {
                    false
                }
            };
            if changed && proxy.send_event(UserEvent::FileChanged).is_err() {
                return;
            }
        }
    });
}

fn file_stamp(p: &Path) -> Option<(SystemTime, u64)> {
    let m = std::fs::metadata(p).ok()?;
    Some((m.modified().ok()?, m.len()))
}

// ---------------------------------------------------------------------------
// Custom protocol: UI assets + files next to the document.

fn protocol(req: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = req.uri().path();
    let (body, mime): (Cow<'static, [u8]>, &str) = match path {
        "/" | "/index.html" => (Cow::Borrowed(INDEX_HTML.as_bytes()), "text/html; charset=utf-8"),
        "/app.css" => (Cow::Borrowed(APP_CSS.as_bytes()), "text/css; charset=utf-8"),
        "/app.js" => (Cow::Borrowed(APP_JS.as_bytes()), "text/javascript; charset=utf-8"),
        "/highlight.css" => (Cow::Borrowed(render::highlight_css().as_bytes()), "text/css; charset=utf-8"),
        "/icon.png" => (Cow::Borrowed(ICON_PNG), "image/png"),
        p if p.starts_with("/doc/") => {
            let decoded = percent_decode_str(&p[5..]).decode_utf8_lossy().replace('/', "\\");
            let file = PathBuf::from(decoded);
            match std::fs::read(&file) {
                Ok(bytes) => {
                    return Response::builder()
                        .header(header::CONTENT_TYPE, mime_for(&file))
                        .header(header::CACHE_CONTROL, "no-cache")
                        .body(Cow::Owned(bytes))
                        .unwrap();
                }
                Err(_) => return not_found(),
            }
        }
        _ => return not_found(),
    };
    let mut b = Response::builder().header(header::CONTENT_TYPE, mime);
    if path == "/" || path == "/index.html" {
        b = b.header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
             img-src * data: blob:; media-src *; font-src 'self' data:; connect-src 'self'; \
             object-src 'none'; frame-src 'none'; base-uri 'self'",
        );
    }
    b.body(body).unwrap()
}

fn not_found() -> Response<Cow<'static, [u8]>> {
    Response::builder().status(404).body(Cow::Borrowed(&b""[..])).unwrap()
}

fn mime_for(p: &Path) -> &'static str {
    let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "css" => "text/css",
        "md" | "markdown" | "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn encode_path(p: &Path) -> String {
    p.to_string_lossy()
        .replace('\\', "/")
        .split('/')
        .map(|seg| utf8_percent_encode(seg, SEGMENT).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn dir_url(dir: &Path) -> String {
    let mut s = format!("{DOC_PREFIX}{}", encode_path(dir));
    if !s.ends_with('/') {
        s.push('/');
    }
    s
}

fn file_url(p: &Path) -> String {
    format!("{DOC_PREFIX}{}", encode_path(p))
}

// ---------------------------------------------------------------------------
// Files

fn is_markdown(p: &Path) -> bool {
    let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    install::EXTENSIONS.iter().any(|e| e[1..] == ext) || ext == "txt"
}

fn absolute(p: &Path) -> PathBuf {
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Read a text file: UTF-8 (with/without BOM), UTF-16 (BOM), or legacy
/// Windows-1255 Hebrew as a fallback for old files.
fn read_text(p: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(p)?;
    Ok(decode_text(&bytes))
}

fn decode_text(bytes: &[u8]) -> String {
    if let Some(b) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(b).into_owned();
    }
    if let Some(b) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let u: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u);
    }
    if let Some(b) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let u: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let hebrew = bytes.iter().filter(|&&b| (0xE0..=0xFA).contains(&b)).count();
            let high = bytes.iter().filter(|&&b| b >= 0x80).count();
            if high > 0 && hebrew * 2 >= high {
                decode_cp1255(bytes)
            } else {
                String::from_utf8_lossy(bytes).into_owned()
            }
        }
    }
}

fn decode_cp1255(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0x00..=0x7F => b as char,
            0xE0..=0xFA => char::from_u32(0x05D0 + (b - 0xE0) as u32).unwrap(),
            0xC0..=0xC9 => char::from_u32(0x05B0 + (b - 0xC0) as u32).unwrap(),
            0xCB..=0xD3 => char::from_u32(0x05BB + (b - 0xCB) as u32).unwrap(),
            0xD4..=0xD8 => char::from_u32(0x05F0 + (b - 0xD4) as u32).unwrap(),
            0xFD => '\u{200E}',
            0xFE => '\u{200F}',
            0xA4 => '\u{20AA}',
            0x96 => '–',
            0x97 => '—',
            0x91 => '‘',
            0x92 => '’',
            0x93 => '“',
            0x94 => '”',
            0x85 => '…',
            _ => char::from_u32(b as u32).unwrap_or('\u{FFFD}'),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Win32 helpers

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn shell_exec(verb: &str, target: &str) -> bool {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let (v, t) = (wide(verb), wide(target));
    let r = unsafe { ShellExecuteW(std::ptr::null_mut(), v.as_ptr(), t.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
    r as isize > 32
}

pub fn shell_open(target: &str) -> bool {
    shell_exec("open", target)
}

fn spawn_self(file: Option<&Path>) {
    if let Ok(exe) = std::env::current_exe() {
        let mut c = std::process::Command::new(exe);
        if let Some(f) = file {
            c.arg(f);
        }
        let _ = c.spawn();
    }
}

fn message_box(title: &str, text: &str, flags: u32) -> i32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW;
    let (t, m) = (wide(title), wide(text));
    unsafe { MessageBoxW(std::ptr::null_mut(), m.as_ptr(), t.as_ptr(), flags) }
}

fn info_box(title: &str, text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONINFORMATION;
    message_box(title, text, MB_ICONINFORMATION);
}

fn error_box(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONERROR;
    message_box("Mad Reader", text, MB_ICONERROR);
}

fn ask(title: &str, text: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IDYES, MB_ICONQUESTION, MB_YESNO};
    message_box(title, text, MB_YESNO | MB_ICONQUESTION) == IDYES
}

fn system_prefers_dark() -> bool {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|k| k.get_value::<u32, _>("AppsUseLightTheme"))
        .map(|v| v == 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cp1255_hebrew() {
        // "שלום" in Windows-1255
        assert_eq!(decode_text(&[0xF9, 0xEC, 0xE5, 0xED]), "שלום");
    }

    #[test]
    fn utf16_bom() {
        assert_eq!(decode_text(&[0xFF, 0xFE, b'h', 0, b'i', 0]), "hi");
    }

    #[test]
    fn url_roundtrip_hebrew_path() {
        let p = Path::new(r"C:\מסמכים\my file.md");
        let url = file_url(p);
        let rest = url.strip_prefix(DOC_PREFIX).unwrap();
        let back = percent_decode_str(rest).decode_utf8_lossy().replace('/', "\\");
        assert_eq!(back, p.to_string_lossy());
    }
}
