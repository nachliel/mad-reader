//! Interface language for the Rust-side strings (message boxes, toasts).
//! The web UI has its own dictionary in assets/ui/app.js; both follow the
//! same `ui.lang` setting: "auto" (Windows display language), "en" or "he".

use std::sync::atomic::{AtomicBool, Ordering};

static HEBREW: AtomicBool = AtomicBool::new(false);

/// Resolve a `ui.lang` setting value and make it current.
pub fn set_from_setting(lang: Option<&str>) {
    let he = match lang.unwrap_or("auto") {
        "he" => true,
        "en" => false,
        _ => system_is_hebrew(),
    };
    HEBREW.store(he, Ordering::Relaxed);
}

pub fn is_hebrew() -> bool {
    HEBREW.load(Ordering::Relaxed)
}

/// Pick the English or Hebrew variant of a message.
pub fn tr(en: impl Into<String>, he: impl Into<String>) -> String {
    if is_hebrew() { he.into() } else { en.into() }
}

/// "he" when Windows' display language is Hebrew, otherwise "en".
pub fn system_lang() -> &'static str {
    if system_is_hebrew() { "he" } else { "en" }
}

fn system_is_hebrew() -> bool {
    use windows_sys::Win32::Globalization::GetUserDefaultUILanguage;
    const LANG_HEBREW: u16 = 0x0D;
    let lang_id = unsafe { GetUserDefaultUILanguage() };
    lang_id & 0x3FF == LANG_HEBREW
}
