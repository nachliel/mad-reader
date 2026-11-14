<p align="center"><img src="assets/app-256.png" width="112" alt="Mad Reader"></p>

<h1 align="center">Mad Reader</h1>

<p align="center">A fast, good-looking Markdown reader for Windows with first-class Hebrew / RTL support.<br>
<a href="README.he.md">קראו בעברית</a></p>

---

Mad Reader opens `.md` files fast (a single 4 MB exe that starts in well under a second) and renders them the way GitHub does, with a clean reading layout. It handles **Hebrew and other right-to-left text correctly, paragraph by paragraph**. You can make it the default app for Markdown files.

## Features

- **RTL done right.** Direction is detected per paragraph, list item, heading, table cell and quote. A Hebrew sentence that starts with an English word (`React היא ספרייה…`) is still right-to-left. Code always stays left-to-right. The table of contents moves to the right side for Hebrew documents. You can force Auto / RTL / LTR with <kbd>Ctrl</kbd>+<kbd>D</kbd>.
- **Hebrew-aware search.** <kbd>Ctrl</kbd>+<kbd>F</kbd> ignores niqqud, so `בראשית` finds `בְּרֵאשִׁית`.
- **Legacy encodings.** UTF-8, UTF-16, and old Windows-1255 Hebrew files all display correctly.
- **GitHub-flavoured Markdown.** Tables, task lists, footnotes, alerts (`> [!NOTE]`), definition lists, strikethrough, super/subscript, safe inline HTML (`<details>`, `<kbd>`, …). Front matter is hidden.
- **Syntax highlighting** for about 150 languages, with a copy button on every code block.
- **Live reload.** Edit the file in any editor and the view refreshes on save, keeping your place.
- **Comfortable reading.** Light, Sepia and Dark themes (or follow Windows), Sans or Serif, text size, line spacing, page width and justification. All of it is remembered.
- **Navigation.** A table-of-contents sidebar that tracks where you are, links between Markdown files, back and forward history, a recent-files list, drag and drop.
- **Print / PDF** without the app chrome (<kbd>Ctrl</kbd>+<kbd>P</kbd>).
- **Safe.** Markdown files can't run scripts. All HTML is sanitized.
- **Easy to install.** Use the setup program, or click **Install** inside the app. Neither needs admin rights.

## Install

Download one of these from `dist/` (or build it yourself, see below):

| File | What it is |
|---|---|
| `MadReader-1.0.0-setup.exe` | Installer (English / Hebrew). Per-user, no admin needed. Adds a Start-menu entry, registers `.md` files, and adds Mad Reader to *Installed apps*. |
| `MadReader-1.0.0-portable.zip` | Just the exe. Run it anywhere. Click **Install** on its home screen to install it in place. |

**Requirements:** Windows 10 or 11 (x64). The Microsoft Edge WebView2 Runtime is needed and already ships with Windows 11 and up-to-date Windows 10.

### Make it the default app for `.md`

Windows only allows *you* to choose default apps, so this takes one click in Settings:

1. Install Mad Reader, using the setup program or the in-app **Install** button.
2. Click **Set as default** on Mad Reader's home screen. You can also use *⋯ → Default app settings…*, or the checkbox at the end of setup.
3. In the Settings page that opens, choose **Mad Reader** for `.md` (and `.markdown` if you want).

Alternatively, right-click a `.md` file → **Open with → Choose another app → Mad Reader → Always**.

## Keyboard shortcuts

| Action | Keys |
|---|---|
| Open file / new window / close | <kbd>Ctrl</kbd>+<kbd>O</kbd> / <kbd>Ctrl</kbd>+<kbd>N</kbd> / <kbd>Ctrl</kbd>+<kbd>W</kbd> |
| Find, next / previous match | <kbd>Ctrl</kbd>+<kbd>F</kbd>, <kbd>Enter</kbd> / <kbd>Shift</kbd>+<kbd>Enter</kbd> (or <kbd>F3</kbd>) |
| Table of contents | <kbd>Ctrl</kbd>+<kbd>B</kbd> |
| Direction: Auto → RTL → LTR | <kbd>Ctrl</kbd>+<kbd>D</kbd> |
| Theme: Auto → Light → Sepia → Dark | <kbd>Ctrl</kbd>+<kbd>T</kbd> |
| Text size | <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>Ctrl</kbd>+<kbd>−</kbd> / <kbd>Ctrl</kbd>+<kbd>0</kbd> / <kbd>Ctrl</kbd>+wheel |
| Back / forward | <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>Alt</kbd>+<kbd>→</kbd>, mouse side buttons |
| Reload | <kbd>F5</kbd> |
| Print / PDF | <kbd>Ctrl</kbd>+<kbd>P</kbd> |
| Open in editor / show in folder | <kbd>Ctrl</kbd>+<kbd>E</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> |
| Full screen | <kbd>F11</kbd> |
| Home (recent files) | <kbd>Ctrl</kbd>+<kbd>H</kbd> |
| All shortcuts | <kbd>F1</kbd> |

## Command line

```text
MadReader.exe [file.md]          open a file
MadReader.exe --install          install for the current user (no admin)
MadReader.exe --uninstall        uninstall (add --quiet for silent)
MadReader.exe --register         register file associations for this exe
MadReader.exe --unregister       remove file associations
MadReader.exe --default-apps     open Settings → Default apps
MadReader.exe --version
```

## Files and registry

| What | Where |
|---|---|
| Program | `%LOCALAPPDATA%\Programs\MadReader\MadReader.exe` |
| Settings, recent files, window position | `%APPDATA%\MadReader\settings.json` |
| WebView2 cache | `%LOCALAPPDATA%\MadReader\WebView2` |
| File type registration (per user) | `HKCU\Software\Classes\MadReader.Markdown`, `.md\OpenWithProgids`, `Applications\MadReader.exe`, `HKCU\Software\MadReader\Capabilities`, `HKCU\Software\RegisteredApplications` |

Uninstalling (from *Settings → Apps → Installed apps*) removes all of the above.

## Building from source

Prerequisites: [Rust](https://rustup.rs) (MSVC toolchain), the Windows SDK (comes with the Visual Studio Build Tools), and optionally [Inno Setup 6](https://jrsoftware.org/isinfo.php) for the installer (`winget install JRSoftware.InnoSetup`).

```powershell
.\build.ps1          # tests + release exe + portable zip + installer → .\dist\
cargo run -- README.md   # run a debug build (devtools enabled: right-click → Inspect)
cargo test
```

To regenerate the icons: `python tools/make_icons.py` (needs Pillow).

### How it works

```
 file.md ──► Rust: decode (UTF-8/16/1255) ──► pulldown-cmark (GFM) ──► heading slugs
                                              └─► syntect (code highlighting)
                                                       │
                                               ammonia (sanitize)
                                                       │  JSON via evaluate_script
                                                       ▼
            WebView2 (wry/tao) ◄── embedded UI shell (assets/ui: HTML/CSS/JS)
              • per-block bidi detection, TOC, find, themes, shortcuts
              • local images served via http://madreader.localhost/doc/<path>
              • links/keys → IPC → Rust (open file, history, shell actions)
```

| Path | Purpose |
|---|---|
| `src/main.rs` | Window, WebView, IPC commands, custom protocol, file loading, live reload, history |
| `src/render.rs` | Markdown → sanitized HTML, slugs, syntax highlighting |
| `src/install.rs` | Per-user install / uninstall, file associations, Default Apps |
| `src/settings.rs` | JSON settings |
| `assets/ui/` | The reader UI (embedded into the exe at compile time) |
| `docs/guide.md` | In-app user guide (embedded) |
| `installer/MadReader.iss` | Inno Setup script |
| `build.rs` | Embeds icons, manifest and version info |

## License

MIT. See [LICENSE](LICENSE).
