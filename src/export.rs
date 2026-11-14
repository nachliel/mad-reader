//! Export the open document as PDF, Word (.docx) or a standalone HTML file.
//!
//! The UI does the layout-aware work (it has the rendered page: diagrams,
//! math, text direction per paragraph) and hands over finished parts; this
//! module writes them: a zip for .docx, the file itself for HTML, and
//! WebView2's PrintToPdf for PDF.

use std::io::Write;
use std::path::Path;

use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_7, ICoreWebView2Environment6};
use webview2_com::PrintToPdfCompletedHandler;
use windows::core::{HSTRING, Interface};
use wry::{WebView, WebViewExtWindows};

/// The formats the UI offers.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Format {
    Pdf,
    Docx,
    Html,
}

impl Format {
    pub fn parse(s: &str) -> Option<Format> {
        match s {
            "pdf" => Some(Format::Pdf),
            "docx" => Some(Format::Docx),
            "html" => Some(Format::Html),
            _ => None,
        }
    }

    pub fn ext(self) -> &'static str {
        match self {
            Format::Pdf => "pdf",
            Format::Docx => "docx",
            Format::Html => "html",
        }
    }
}

/// Paper size from the Windows region settings: Letter in the US and a few
/// other countries, A4 everywhere else.
pub fn paper_is_letter() -> bool {
    use windows_sys::Win32::Globalization::{GetLocaleInfoEx, LOCALE_IPAPERSIZE, LOCALE_RETURN_NUMBER};
    let mut buf = [0u16; 2];
    let n = unsafe { GetLocaleInfoEx(std::ptr::null(), LOCALE_IPAPERSIZE | LOCALE_RETURN_NUMBER, buf.as_mut_ptr(), 2) };
    // 1 = Letter, 5 = Legal, 9 = A4
    n > 0 && matches!(buf[0], 1 | 5)
}

/// Write a .docx: `parts` are (zip path, bytes) as the UI built them.
pub fn write_docx(path: &Path, parts: &[(String, Vec<u8>)]) -> Result<(), String> {
    let bytes = zip(parts).map_err(|e| e.to_string())?;
    write_atomic(path, &bytes)
}

/// Write via a temporary file next to the target, so a failed write never
/// leaves half a document behind (or destroys the previous one).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("{}.mrtmp", path.extension().and_then(|e| e.to_str()).unwrap_or("")));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Print the current page (its print stylesheet) to a PDF file. `done` runs
/// on the UI thread when WebView2 has finished writing.
pub fn print_to_pdf(webview: &WebView, path: &Path, letter: bool, done: Box<dyn FnOnce(Result<(), String>)>) -> Result<(), String> {
    let err = |e: windows::core::Error| e.message().to_string();
    unsafe {
        let wv: ICoreWebView2_7 = webview.webview().cast().map_err(err)?;
        let env: ICoreWebView2Environment6 = webview.environment().cast().map_err(err)?;
        let ps = env.CreatePrintSettings().map_err(err)?;
        let (w, h) = if letter { (8.5, 11.0) } else { (8.27, 11.69) };
        ps.SetPageWidth(w).map_err(err)?;
        ps.SetPageHeight(h).map_err(err)?;
        ps.SetMarginTop(0.7).map_err(err)?;
        ps.SetMarginBottom(0.7).map_err(err)?;
        ps.SetMarginLeft(0.75).map_err(err)?;
        ps.SetMarginRight(0.75).map_err(err)?;
        ps.SetShouldPrintBackgrounds(true).map_err(err)?;
        // Chromium's header/footer is the date, the page URL and the title;
        // the page numbers come from the print stylesheet instead.
        ps.SetShouldPrintHeaderAndFooter(false).map_err(err)?;
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
            done(match hr {
                Err(e) => Err(e.message().to_string()),
                Ok(()) if !ok => Err("WebView2 could not write the PDF".into()),
                Ok(()) => Ok(()),
            });
            Ok(())
        }));
        wv.PrintToPdf(&HSTRING::from(path.as_os_str()), &ps, &handler).map_err(err)?;
    }
    Ok(())
}

/// Decode standard base64 (the UI sends images that way).
pub fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in s.as_bytes() {
        if c == b'=' {
            break;
        }
        if c.is_ascii_whitespace() {
            continue;
        }
        let v = val(c).ok_or("invalid base64")?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// A small zip writer (deflate, UTF-8 names): all a .docx needs.

pub fn zip(files: &[(String, Vec<u8>)]) -> std::io::Result<Vec<u8>> {
    let (time, date) = dos_now();
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in files {
        let mut crc = flate2::Crc::new();
        crc.update(data);
        let crc = crc.sum();
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(data)?;
        let packed = enc.finish()?;
        let (method, body): (u16, &[u8]) = if packed.len() < data.len() { (8, &packed) } else { (0, data) };
        let offset = out.len() as u32;
        let header = |sig: u32, central: bool| {
            let mut h = Vec::with_capacity(46 + name.len());
            h.extend_from_slice(&sig.to_le_bytes());
            if central {
                h.extend_from_slice(&20u16.to_le_bytes()); // made by
            }
            h.extend_from_slice(&20u16.to_le_bytes()); // needed
            h.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
            h.extend_from_slice(&method.to_le_bytes());
            h.extend_from_slice(&time.to_le_bytes());
            h.extend_from_slice(&date.to_le_bytes());
            h.extend_from_slice(&crc.to_le_bytes());
            h.extend_from_slice(&(body.len() as u32).to_le_bytes());
            h.extend_from_slice(&(data.len() as u32).to_le_bytes());
            h.extend_from_slice(&(name.len() as u16).to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes()); // extra
            if central {
                h.extend_from_slice(&[0; 6]); // comment length, disk, internal attrs
                h.extend_from_slice(&0u32.to_le_bytes()); // external attrs
                h.extend_from_slice(&offset.to_le_bytes());
            }
            h.extend_from_slice(name.as_bytes());
            h
        };
        out.extend_from_slice(&header(0x04034b50, false));
        out.extend_from_slice(body);
        central.extend_from_slice(&header(0x02014b50, true));
    }
    let cd_offset = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]); // disk numbers
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    Ok(out)
}

/// Current UTC time as MS-DOS (time, date).
fn dos_now() -> (u16, u16) {
    let secs = crate::unix_now() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    let y = y.clamp(1980, 2107);
    let time = ((rem / 3600) << 11) | (((rem % 3600) / 60) << 5) | ((rem % 60) / 2);
    let date = ((y - 1980) << 9) | (m << 5) | d;
    (time as u16, date as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        assert_eq!(base64_decode("TWFkIFJlYWRlcg==").unwrap(), b"Mad Reader");
        assert_eq!(base64_decode("TWE=").unwrap(), b"Ma");
        assert_eq!(base64_decode("").unwrap(), b"");
        assert!(base64_decode("@@").is_err());
    }

    #[test]
    fn zip_structure() {
        let files = vec![
            ("[Content_Types].xml".to_string(), b"<Types/>".to_vec()),
            ("word/מסמך.xml".to_string(), "שלום ".repeat(200).into_bytes()),
        ];
        let z = zip(&files).unwrap();
        assert_eq!(&z[..4], &[0x50, 0x4b, 0x03, 0x04]);
        let eocd = &z[z.len() - 22..];
        assert_eq!(&eocd[..4], &[0x50, 0x4b, 0x05, 0x06]);
        assert_eq!(u16::from_le_bytes([eocd[10], eocd[11]]), 2);
        // the central directory is where the end record says, and lists both names
        let cd = u32::from_le_bytes(eocd[16..20].try_into().unwrap()) as usize;
        assert_eq!(&z[cd..cd + 4], &[0x50, 0x4b, 0x01, 0x02]);
        let name_len = u16::from_le_bytes([z[cd + 28], z[cd + 29]]) as usize;
        assert_eq!(&z[cd + 46..cd + 46 + name_len], b"[Content_Types].xml");
        let next = cd + 46 + name_len;
        assert_eq!(&z[next..next + 4], &[0x50, 0x4b, 0x01, 0x02]);
        // the repetitive entry was compressed, the tiny one stored
        assert!(z.len() < 2000 + 200);
        assert_eq!(u16::from_le_bytes([z[8], z[9]]), 0);
    }

    #[test]
    fn format_names() {
        assert_eq!(Format::parse("docx").map(Format::ext), Some("docx"));
        assert_eq!(Format::parse("exe"), None);
    }
}
