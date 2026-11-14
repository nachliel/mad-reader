//! Updates through GitHub Releases. No server of our own is needed.
//!
//! * `check`     asks the GitHub API for the latest release and returns it if
//!               it is newer than this build.
//! * `download`  fetches the release's `MadReader-<ver>-setup.exe` into
//!               %TEMP%, checking its size and SHA-256 (GitHub publishes a
//!               digest for every release asset).
//! * `run_installer` starts that setup silently. The setup closes Mad Reader,
//!               replaces the exe and starts it again with `--updated`.
//!
//! HTTP goes through WinHTTP, which is part of Windows: it uses the system
//! proxy settings and certificate store, and adds nothing to the exe size.
//!
//! For testing, `MADREADER_UPDATE_URL` replaces the GitHub API URL (plain
//! http:// works too, e.g. a local test server).

use std::path::PathBuf;

use serde_json::Value;

pub const REPO: &str = "nachliel/mad-reader";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_BYTES: usize = 200 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Release {
    pub version: String,
    /// Release notes (Markdown).
    pub notes: String,
    /// The release's web page.
    pub page: String,
    pub setup: Option<Asset>,
}

#[derive(Clone, Debug)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: Option<String>,
}

fn api_url() -> String {
    std::env::var("MADREADER_UPDATE_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| format!("https://api.github.com/repos/{REPO}/releases/latest"))
}

pub fn releases_page() -> String {
    format!("https://github.com/{REPO}/releases/latest")
}

/// "v1.10.2" → [1, 10, 2]. Pre-release / build suffixes are ignored.
pub fn parse_version(s: &str) -> Option<Vec<u64>> {
    let core = s.trim().trim_start_matches(['v', 'V']).split(['-', '+']).next()?;
    let parts: Option<Vec<u64>> = core.split('.').map(|p| p.parse().ok()).collect();
    parts.filter(|p| !p.is_empty())
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(mut a), Some(mut b)) => {
            let n = a.len().max(b.len());
            a.resize(n, 0);
            b.resize(n, 0);
            a > b
        }
        _ => false,
    }
}

/// The latest release if it is newer than this build; `None` if up to date
/// (or if the repository has no releases yet).
pub fn check() -> Result<Option<Release>, String> {
    let (status, body) = get(&api_url(), "application/vnd.github+json", &mut |_| {})?;
    if status == 404 {
        return Ok(None);
    }
    if status == 403 || status == 429 {
        return Err(tr("GitHub is limiting requests right now. Try again later.", "GitHub מגביל בקשות כרגע. נסו שוב מאוחר יותר."));
    }
    if status != 200 {
        return Err(tr(format!("GitHub answered with HTTP {status}."), format!("GitHub החזיר שגיאת HTTP ‏{status}.")));
    }
    let v: Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let r = parse_release(&v)?;
    Ok(is_newer(&r.version, VERSION).then_some(r))
}

pub fn parse_release(v: &Value) -> Result<Release, String> {
    let tag = v.get("tag_name").and_then(Value::as_str).ok_or("release has no tag")?;
    let version = tag.trim().trim_start_matches(['v', 'V']).to_string();
    if parse_version(&version).is_none() {
        return Err(format!("unexpected release tag {tag:?}"));
    }
    let setup = v
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find_map(|a| {
            let name = a.get("name")?.as_str()?;
            if !name.to_ascii_lowercase().ends_with("-setup.exe") || !safe_file_name(name) {
                return None;
            }
            Some(Asset {
                name: name.to_string(),
                url: a.get("browser_download_url")?.as_str()?.to_string(),
                size: a.get("size").and_then(Value::as_u64).unwrap_or(0),
                sha256: a
                    .get("digest")
                    .and_then(Value::as_str)
                    .and_then(|d| d.strip_prefix("sha256:"))
                    .map(|d| d.to_ascii_lowercase()),
            })
        });
    Ok(Release {
        version,
        notes: v.get("body").and_then(Value::as_str).unwrap_or("").to_string(),
        page: v.get("html_url").and_then(Value::as_str).map(String::from).unwrap_or_else(releases_page),
        setup,
    })
}

fn safe_file_name(name: &str) -> bool {
    !name.is_empty() && name.len() < 100 && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) && !name.starts_with('.')
}

/// Download the setup program; `progress` gets the fraction done (0.0–1.0).
pub fn download(asset: &Asset, progress: &mut dyn FnMut(f64)) -> Result<PathBuf, String> {
    if !safe_file_name(&asset.name) {
        return Err("bad file name".into());
    }
    let total = asset.size.max(1) as f64;
    let (status, body) = get(&asset.url, "application/octet-stream", &mut |n| progress((n as f64 / total).min(1.0)))?;
    if status != 200 {
        return Err(tr(format!("Download failed (HTTP {status})."), format!("ההורדה נכשלה (HTTP ‏{status}).")));
    }
    if asset.size > 0 && body.len() as u64 != asset.size {
        return Err(tr("The download is incomplete.", "ההורדה לא הושלמה."));
    }
    if !body.starts_with(b"MZ") {
        return Err(tr("The download is not a Windows program.", "הקובץ שהורד אינו תוכנה ל-Windows."));
    }
    if let Some(want) = &asset.sha256 {
        if &sha256_hex(&body) != want {
            return Err(tr("The download is damaged (checksum mismatch).", "הקובץ שהורד פגום (סיכום הביקורת לא תואם)."));
        }
    }
    let dir = std::env::temp_dir().join("MadReader-update");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&asset.name);
    std::fs::write(&path, &body).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// Start the setup silently. It closes running copies of Mad Reader, installs
/// over the existing one and relaunches it (`/RELAUNCH=1`, see MadReader.iss).
pub fn run_installer(setup: &std::path::Path) -> std::io::Result<()> {
    let lang = if crate::i18n::is_hebrew() { "/LANG=he" } else { "/LANG=en" };
    std::process::Command::new(setup)
        .args(["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/RELAUNCH=1", lang])
        .spawn()
        .map(|_| ())
}

fn tr(en: impl Into<String>, he: impl Into<String>) -> String {
    crate::i18n::tr(en, he)
}

// ---------------------------------------------------------------------------
// Minimal WinHTTP GET (follows redirects, decompresses gzip).

struct Handle(*mut core::ffi::c_void);

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { windows_sys::Win32::Networking::WinHttp::WinHttpCloseHandle(self.0) };
        }
    }
}

fn split_url(url: &str) -> Result<(bool, String, u16, String), String> {
    let (secure, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("http://") {
        (false, r)
    } else {
        return Err(format!("unsupported URL {url}"));
    };
    let (hostport, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h, p.parse().map_err(|_| format!("bad port in {url}"))?),
        None => (hostport, if secure { 443 } else { 80 }),
    };
    if host.is_empty() {
        return Err(format!("bad URL {url}"));
    }
    Ok((secure, host.to_string(), port, path.to_string()))
}

fn net_error(what: &str) -> String {
    let code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
    match code {
        12007 | 12029 | 12005 => tr(
            "Could not connect. Check your internet connection.",
            "לא ניתן להתחבר. בדקו את החיבור לאינטרנט.",
        ),
        12002 => tr("The connection timed out.", "תם הזמן להתחברות."),
        12175 | 12045 | 12169 | 12038 | 12037 => tr(
            "The secure connection could not be verified.",
            "לא ניתן לאמת את החיבור המאובטח.",
        ),
        _ => format!("{what} failed (error {code})"),
    }
}

fn get(url: &str, accept: &str, progress: &mut dyn FnMut(u64)) -> Result<(u32, Vec<u8>), String> {
    use windows_sys::Win32::Networking::WinHttp::*;
    let w = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let (secure, host, port, path) = split_url(url)?;
    let agent = w(&format!("MadReader/{VERSION} (+https://github.com/{REPO})"));
    let host_w = w(&host);
    let path_w = w(&path);
    let verb = w("GET");
    let headers = w(&format!("Accept: {accept}\r\n"));
    unsafe {
        let session = Handle(WinHttpOpen(agent.as_ptr(), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, std::ptr::null(), std::ptr::null(), 0));
        if session.0.is_null() {
            return Err(net_error("WinHttpOpen"));
        }
        WinHttpSetTimeouts(session.0, 15_000, 15_000, 20_000, 30_000);
        let decompress: u32 = 3; // WINHTTP_DECOMPRESSION_FLAG_GZIP | _DEFLATE
        WinHttpSetOption(session.0, WINHTTP_OPTION_DECOMPRESSION, &decompress as *const u32 as _, 4);

        let conn = Handle(WinHttpConnect(session.0, host_w.as_ptr(), port, 0));
        if conn.0.is_null() {
            return Err(net_error("WinHttpConnect"));
        }
        let req = Handle(WinHttpOpenRequest(
            conn.0,
            verb.as_ptr(),
            path_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            if secure { WINHTTP_FLAG_SECURE } else { 0 },
        ));
        if req.0.is_null() {
            return Err(net_error("WinHttpOpenRequest"));
        }
        if WinHttpSendRequest(req.0, headers.as_ptr(), u32::MAX, std::ptr::null(), 0, 0, 0) == 0 {
            return Err(net_error("WinHttpSendRequest"));
        }
        if WinHttpReceiveResponse(req.0, std::ptr::null_mut()) == 0 {
            return Err(net_error("WinHttpReceiveResponse"));
        }
        let mut status: u32 = 0;
        let mut len: u32 = 4;
        WinHttpQueryHeaders(
            req.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            std::ptr::null(),
            &mut status as *mut u32 as _,
            &mut len,
            std::ptr::null_mut(),
        );

        let mut body = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let mut n: u32 = 0;
            if WinHttpReadData(req.0, buf.as_mut_ptr() as _, buf.len() as u32, &mut n) == 0 {
                return Err(net_error("WinHttpReadData"));
            }
            if n == 0 {
                break;
            }
            body.extend_from_slice(&buf[..n as usize]);
            if body.len() > MAX_BYTES {
                return Err("response too large".into());
            }
            progress(body.len() as u64);
        }
        Ok((status, body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn versions() {
        assert!(is_newer("1.2.0", "1.1.0"));
        assert!(is_newer("v1.10.0", "1.9.9"));
        assert!(is_newer("2.0", "1.99.99"));
        assert!(!is_newer("1.1.0", "1.1.0"));
        assert!(!is_newer("v1.1", "1.1.0"));
        assert!(!is_newer("1.0.9", "1.1.0"));
        assert!(!is_newer("garbage", "1.0.0"));
        assert_eq!(parse_version("v1.2.3-beta.1"), Some(vec![1, 2, 3]));
    }

    #[test]
    fn release_json() {
        let v = json!({
            "tag_name": "v1.3.0",
            "html_url": "https://github.com/nachliel/mad-reader/releases/tag/v1.3.0",
            "body": "## What's new\n- things",
            "assets": [
                { "name": "MadReader-1.3.0-portable.zip", "browser_download_url": "https://x/zip", "size": 10 },
                { "name": "MadReader-1.3.0-setup.exe", "browser_download_url": "https://x/setup", "size": 1234,
                  "digest": "sha256:ABCDEF" }
            ]
        });
        let r = parse_release(&v).unwrap();
        assert_eq!(r.version, "1.3.0");
        let s = r.setup.unwrap();
        assert_eq!(s.url, "https://x/setup");
        assert_eq!(s.size, 1234);
        assert_eq!(s.sha256.as_deref(), Some("abcdef"));
    }

    #[test]
    fn rejects_unsafe_asset_names() {
        let v = json!({ "tag_name": "v9.0.0", "assets": [
            { "name": "..\\..\\evil-setup.exe", "browser_download_url": "https://x", "size": 1 } ] });
        assert!(parse_release(&v).unwrap().setup.is_none());
    }

    #[test]
    fn urls() {
        assert_eq!(
            split_url("https://api.github.com/repos/a/b").unwrap(),
            (true, "api.github.com".into(), 443, "/repos/a/b".into())
        );
        assert_eq!(split_url("http://127.0.0.1:8123/x.json").unwrap(), (false, "127.0.0.1".into(), 8123, "/x.json".into()));
        assert!(split_url("ftp://x").is_err());
    }

    #[test]
    fn sha256() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
