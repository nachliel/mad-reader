//! Per-user installation and file-type registration. No admin rights needed.
//!
//! * `register`   – registers Mad Reader as a handler for Markdown files
//!                  (ProgID, "Open with", Default Apps capabilities).
//! * `unregister` – removes all of the above.
//! * `install`    – copies the exe to `%LOCALAPPDATA%\Programs\MadReader`,
//!                  registers it, adds a Start-menu shortcut and an entry in
//!                  "Installed apps" (uninstall).
//! * `uninstall`  – reverses `install`.
//!
//! Since Windows 8 an app may not silently make itself the default handler;
//! the user confirms that once in Settings → Default apps. `open_default_apps`
//! jumps straight to Mad Reader's page there.

use std::io;
use std::path::{Path, PathBuf};

use winreg::RegKey;
use winreg::enums::*;

pub const APP_NAME: &str = "Mad Reader";
pub const PROG_ID: &str = "MadReader.Markdown";
pub const EXE_NAME: &str = "MadReader.exe";
const REG_APP: &str = "MadReader";
const CAPABILITIES: &str = r"Software\MadReader\Capabilities";
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\MadReader";

pub const EXTENSIONS: &[&str] = &[
    ".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdwn", ".mdtxt", ".mdtext", ".mdx",
];

pub fn install_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Programs").join("MadReader")
}

pub fn installed_exe() -> PathBuf {
    install_dir().join(EXE_NAME)
}

fn start_menu_shortcut() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join(r"Microsoft\Windows\Start Menu\Programs").join(format!("{APP_NAME}.lnk"))
}

/// True when this exe is the registered handler (installed by us or by the setup program).
pub fn is_registered() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(cmd) = hkcu.open_subkey(format!(r"Software\Classes\{PROG_ID}\shell\open\command")) else {
        return false;
    };
    let cmd: String = cmd.get_value("").unwrap_or_default();
    let me = std::env::current_exe().map(|p| p.to_string_lossy().to_lowercase()).unwrap_or_default();
    cmd.to_lowercase().contains(&me)
}

pub fn running_from_install_dir() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .map(|d| same_path(&d, &install_dir()))
        .unwrap_or(false)
}

fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().trim_end_matches('\\').to_lowercase();
    norm(a) == norm(b)
}

pub fn register(exe: &Path) -> io::Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let exe_s = exe.to_string_lossy().to_string();
    let open_cmd = format!("\"{exe_s}\" \"%1\"");
    let app_icon = format!("\"{exe_s}\",0");
    let doc_icon = format!("\"{exe_s}\",1");

    // ProgID
    let (prog, _) = hkcu.create_subkey(format!(r"Software\Classes\{PROG_ID}"))?;
    prog.set_value("", &"Markdown Document")?;
    prog.set_value("FriendlyTypeName", &"Markdown Document")?;
    prog.create_subkey("DefaultIcon")?.0.set_value("", &doc_icon)?;
    let (open, _) = prog.create_subkey(r"shell\open")?;
    open.set_value("FriendlyAppName", &APP_NAME)?;
    open.create_subkey("command")?.0.set_value("", &open_cmd)?;

    // Extensions: add to "Open with", and claim the default only if nobody has it.
    for ext in EXTENSIONS {
        let (k, _) = hkcu.create_subkey(format!(r"Software\Classes\{ext}"))?;
        let current: String = k.get_value("").unwrap_or_default();
        if current.is_empty() {
            k.set_value("", &PROG_ID)?;
        }
        let ct: Result<String, _> = k.get_value("Content Type");
        if ct.is_err() {
            k.set_value("Content Type", &"text/markdown")?;
        }
        let pt: Result<String, _> = k.get_value("PerceivedType");
        if pt.is_err() {
            k.set_value("PerceivedType", &"text")?;
        }
        k.create_subkey("OpenWithProgids")?.0.set_value(PROG_ID, &"")?;
    }

    // Applications\MadReader.exe — nice name + icon in the "Open with" list.
    let exe_file = exe.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or(EXE_NAME.into());
    let (app, _) = hkcu.create_subkey(format!(r"Software\Classes\Applications\{exe_file}"))?;
    app.set_value("FriendlyAppName", &APP_NAME)?;
    app.create_subkey("DefaultIcon")?.0.set_value("", &app_icon)?;
    app.create_subkey(r"shell\open\command")?.0.set_value("", &open_cmd)?;
    let (types, _) = app.create_subkey("SupportedTypes")?;
    for ext in EXTENSIONS {
        types.set_value(ext, &"")?;
    }

    // Default Apps capabilities
    let (caps, _) = hkcu.create_subkey(CAPABILITIES)?;
    caps.set_value("ApplicationName", &APP_NAME)?;
    caps.set_value("ApplicationDescription", &"A fast Markdown reader with first-class Hebrew (RTL) support.")?;
    caps.set_value("ApplicationIcon", &app_icon)?;
    let (fa, _) = caps.create_subkey("FileAssociations")?;
    for ext in EXTENSIONS {
        fa.set_value(ext, &PROG_ID)?;
    }
    hkcu.create_subkey(r"Software\RegisteredApplications")?
        .0
        .set_value(REG_APP, &CAPABILITIES)?;

    notify_shell();
    Ok(())
}

pub fn unregister() -> io::Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let _ = hkcu.delete_subkey_all(format!(r"Software\Classes\{PROG_ID}"));
    for ext in EXTENSIONS {
        if let Ok(k) = hkcu.open_subkey_with_flags(format!(r"Software\Classes\{ext}"), KEY_ALL_ACCESS) {
            let current: String = k.get_value("").unwrap_or_default();
            if current == PROG_ID {
                let _ = k.delete_value("");
            }
            if let Ok(owp) = k.open_subkey_with_flags("OpenWithProgids", KEY_ALL_ACCESS) {
                let _ = owp.delete_value(PROG_ID);
            }
        }
    }
    let _ = hkcu.delete_subkey_all(format!(r"Software\Classes\Applications\{EXE_NAME}"));
    let _ = hkcu.delete_subkey_all(format!(r"Software\Classes\Applications\mad-reader.exe"));
    let _ = hkcu.delete_subkey_all(r"Software\MadReader");
    if let Ok(k) = hkcu.open_subkey_with_flags(r"Software\RegisteredApplications", KEY_ALL_ACCESS) {
        let _ = k.delete_value(REG_APP);
    }
    notify_shell();
    Ok(())
}

/// Copy this exe into the per-user Programs folder and register it.
/// Returns the path of the installed exe.
pub fn install() -> io::Result<PathBuf> {
    let src = std::env::current_exe()?;
    let dir = install_dir();
    std::fs::create_dir_all(&dir)?;
    let dst = installed_exe();
    if !same_path(&src, &dst) {
        // If an older copy is running, rename it out of the way first.
        if dst.exists() && std::fs::copy(&src, &dst).is_err() {
            let old = dir.join("MadReader.old.exe");
            let _ = std::fs::remove_file(&old);
            std::fs::rename(&dst, &old)?;
            std::fs::copy(&src, &dst)?;
        } else if !dst.exists() {
            std::fs::copy(&src, &dst)?;
        }
    }
    // Docs next to the exe, if we were shipped with them.
    if let Some(src_dir) = src.parent() {
        for f in ["README.md", "README.he.md", "LICENSE"] {
            let p = src_dir.join(f);
            if p.exists() && !same_path(src_dir, &dir) {
                let _ = std::fs::copy(&p, dir.join(f));
            }
        }
    }

    register(&dst)?;

    // Start menu shortcut
    let lnk = start_menu_shortcut();
    if let Some(parent) = lnk.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut sl) = mslnk::ShellLink::new(&dst) {
        sl.set_working_dir(Some(dir.to_string_lossy().to_string()));
        sl.set_icon_location(Some(dst.to_string_lossy().to_string()));
        sl.set_name(Some("Markdown reader with Hebrew / RTL support".into()));
        let _ = sl.create_lnk(&lnk);
    }

    // "Installed apps" entry
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (u, _) = hkcu.create_subkey(UNINSTALL_KEY)?;
    let dst_s = dst.to_string_lossy().to_string();
    u.set_value("DisplayName", &APP_NAME)?;
    u.set_value("DisplayVersion", &env!("CARGO_PKG_VERSION"))?;
    u.set_value("Publisher", &APP_NAME)?;
    u.set_value("DisplayIcon", &format!("\"{dst_s}\",0"))?;
    u.set_value("InstallLocation", &dir.to_string_lossy().to_string())?;
    u.set_value("UninstallString", &format!("\"{dst_s}\" --uninstall"))?;
    u.set_value("QuietUninstallString", &format!("\"{dst_s}\" --uninstall --quiet"))?;
    u.set_value("NoModify", &1u32)?;
    u.set_value("NoRepair", &1u32)?;
    let size_kb = std::fs::metadata(&dst).map(|m| (m.len() / 1024) as u32).unwrap_or(0);
    u.set_value("EstimatedSize", &size_kb)?;

    Ok(dst)
}

pub fn uninstall() -> io::Result<()> {
    unregister()?;
    let _ = std::fs::remove_file(start_menu_shortcut());
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let _ = hkcu.delete_subkey_all(UNINSTALL_KEY);

    // Remove files after this process exits (a running exe can't delete itself).
    let mut targets = vec![crate::settings::data_dir()];
    targets.push(crate::settings::config_dir());
    if running_from_install_dir() || installed_exe().exists() {
        targets.push(install_dir());
    }
    let mut script = String::from("ping 127.0.0.1 -n 3 > nul");
    for t in targets {
        script.push_str(&format!(" & rmdir /s /q \"{}\"", t.to_string_lossy()));
    }
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("cmd")
        .raw_arg(format!("/c {script}"))
        .current_dir(std::env::temp_dir())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    Ok(())
}

fn notify_shell() {
    use windows_sys::Win32::UI::Shell::{SHCNE_ASSOCCHANGED, SHCNF_IDLIST, SHChangeNotify};
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED as i32, SHCNF_IDLIST, std::ptr::null(), std::ptr::null()) };
}

/// Open Settings → Default apps → Mad Reader (falls back to the Default apps page).
pub fn open_default_apps() {
    let uri = format!("ms-settings:defaultapps?registeredAppUser={REG_APP}");
    if !crate::shell_open(&uri) {
        crate::shell_open("ms-settings:defaultapps");
    }
}

/// Is Mad Reader the handler Windows actually uses for `.md` right now?
pub fn is_default() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(k) = hkcu.open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice") {
        let prog: String = k.get_value("ProgId").unwrap_or_default();
        return prog == PROG_ID || prog.to_ascii_lowercase().contains("madreader");
    }
    hkcu.open_subkey(r"Software\Classes\.md")
        .and_then(|k| k.get_value::<String, _>(""))
        .map(|v| v == PROG_ID)
        .unwrap_or(false)
}
