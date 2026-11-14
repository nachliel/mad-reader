//! Persistent settings, stored as JSON in `%APPDATA%\MadReader\settings.json`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const MAX_RECENT: usize = 15;

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct WindowState {
    pub width: f64,
    pub height: f64,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub maximized: bool,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    /// Reader preferences owned by the UI (theme, font, size, direction…).
    /// Stored opaquely so the UI can evolve without Rust changes.
    pub ui: serde_json::Value,
    pub recent: Vec<String>,
    pub window: WindowState,
    /// Hide the "make Mad Reader your default app" hint.
    pub dismissed_default_hint: bool,
    pub updates: UpdateSettings,
    /// Document to reopen after an update restarts the app.
    pub resume: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct UpdateSettings {
    /// Turn off the daily background check (Check for updates still works).
    pub disabled: bool,
    /// Unix time of the last background check.
    pub last_check: u64,
    /// A version the user chose to skip.
    pub skipped: String,
}

pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("MadReader")
}

pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("MadReader")
}

fn file() -> PathBuf {
    config_dir().join("settings.json")
}

impl Settings {
    pub fn load() -> Self {
        std::fs::read_to_string(file())
            .ok()
            .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        let _ = std::fs::create_dir_all(config_dir());
        if let Ok(s) = serde_json::to_string_pretty(self) {
            // write-then-rename so a crash never leaves a truncated file
            let tmp = file().with_extension("json.tmp");
            if std::fs::write(&tmp, s).is_ok() {
                let _ = std::fs::rename(&tmp, file());
            }
        }
    }

    pub fn push_recent(&mut self, path: &Path) {
        let p = path.to_string_lossy().to_string();
        self.recent.retain(|r| !r.eq_ignore_ascii_case(&p));
        self.recent.insert(0, p);
        self.recent.truncate(MAX_RECENT);
    }

    pub fn ui_str(&self, key: &str) -> Option<&str> {
        self.ui.get(key).and_then(|v| v.as_str())
    }
}
