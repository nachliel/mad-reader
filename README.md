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
- **Math, diagrams and graphs.** LaTeX math (`$…$`, `$$…$$`, ```` ```math ````) is typeset with KaTeX. ```` ```mermaid ```` blocks are drawn as diagrams and charts. ```` ```dot ```` blocks are laid out by Graphviz. All of them follow the light or dark theme, work offline and load only when a document uses them.
- **Automatic updates.** A quiet daily check against GitHub Releases. One click downloads the new version, verifies it, installs it and reopens your document. It can be turned off.
- **Hebrew interface.** Menus, buttons, dialogs and the user guide are available in Hebrew, with the whole interface mirrored right-to-left. The language follows Windows by default, or you can pick it in **Aa → Language**.
- **Live reload.** Edit the file in any editor and the view refreshes on save, keeping your place.
- **Comfortable reading.** Light, Sepia and Dark themes (or follow Windows), Sans or Serif, text size, line spacing, page width and justification. All of it is remembered.
- **Navigation.** A table-of-contents sidebar that tracks where you are, links between Markdown files, back and forward history, a recent-files list, drag and drop.
- **Export to PDF, Word (.docx) and HTML** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>). Hebrew stays right-to-left in Word, and equations become editable Word equations. **Copy as rich text** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>) to paste the formatted document into Gmail, Outlook, Word or Google Docs. **Print** with <kbd>Ctrl</kbd>+<kbd>P</kbd>.
- **Safe.** Markdown files can't run scripts. All HTML is sanitized.
- **Easy to install.** Use the setup program, or click **Install** inside the app. Neither needs admin rights.

## Install

Download one of these from the [latest release](https://github.com/nachliel/mad-reader/releases/latest) (or build it yourself, see below):

| File | What it is |
|---|---|
| `MadReader-1.2.0-setup.exe` | Installer (English / Hebrew). Per-user, no admin needed. Adds a Start-menu entry, registers `.md` files, and adds Mad Reader to *Installed apps*. |
| `MadReader-1.2.0-portable.zip` | Just the exe. Run it anywhere. Click **Install** on its home screen to install it in place. |

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
| Export (PDF, Word, HTML) | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> |
| Copy as rich text | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> |
| Print | <kbd>Ctrl</kbd>+<kbd>P</kbd> |
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

Set the environment variable `MADREADER_NO_UPDATE_CHECK=1` to turn off the background update check (useful for managed PCs).

## Updates and releases

No server is needed. Releases live on GitHub:

1. The app calls `https://api.github.com/repos/nachliel/mad-reader/releases/latest` about once a day. The request carries no personal data.
2. If the tag (`v1.2.0`) is newer than the running version, the app shows the release notes. On **Update** it downloads `MadReader-<ver>-setup.exe` with WinHTTP, checks its size and the SHA-256 digest that GitHub publishes for every asset, and runs it with `/SILENT /RELAUNCH=1`. The setup closes Mad Reader, installs over it and starts it again with `--updated`, which reopens the last document.
3. Portable copies open the release page instead.

**Publishing a release:** bump `version` in `Cargo.toml`, add a `## <version>` section to `CHANGELOG.md`, commit, then:

```powershell
git tag v1.2.0
git push origin main v1.2.0
```

`.github/workflows/release.yml` builds and tests on a Windows runner, then creates the GitHub release with the setup, the portable zip and the CHANGELOG section as notes. The repository must be public, or the app can't read the release without a token.

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
.\build.ps1             # unit tests + release exe + portable zip + installer → .\dist\
.\build.ps1 -E2E        # …plus the end-to-end UI tests
cargo run -- README.md  # run a debug build (devtools enabled: right-click → Inspect)
cargo test              # unit tests
```

- Regenerate the icons: `python tools/make_icons.py` (needs Pillow).
- Update the bundled KaTeX / Mermaid / Viz.js: `.\tools\update_vendor.ps1` (needs npm).

### Testing

`cargo test` covers the Markdown pipeline (Hebrew slugs, sanitizing, math, Mermaid and Graphviz detection, encodings, paths) and the updater (version comparison, release parsing, URLs, SHA-256).

`python tests\e2e.py` runs the end-to-end suite (84 checks) against the real exe. It starts Mad Reader with throw-away settings folders, attaches [Playwright](https://playwright.dev/python/) to WebView2's DevTools port (through `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`), and drives the app with the keyboard and mouse. It covers per-paragraph direction, math, Mermaid and Graphviz, images, niqqud-insensitive search, links and history, themes, the Hebrew interface, live reload, recent files, the guide, the update flow (against a local fake release server), export to PDF, Word and HTML (the files are opened and inspected), copy as rich text (the clipboard is read back), and saved settings. Pass `--out DIR` to keep the screenshots. It needs `pip install playwright` but no browser download, because it uses the WebView2 that ships with Windows.


### How it works

```
 file.md ──► Rust: decode (UTF-8/16/1255) ──► pulldown-cmark (GFM) ──► heading slugs
                                              ├─► syntect (code highlighting)
                                              └─► math / mermaid / dot blocks marked for the UI
                                                       │
                                               ammonia (sanitize)
                                                       │  JSON via evaluate_script
                                                       ▼
            WebView2 (wry/tao) ◄── embedded UI shell (assets/ui: HTML/CSS/JS)
              • per-block bidi detection, TOC, find, themes, shortcuts, EN/HE UI
              • KaTeX, Mermaid, Viz.js/Graphviz (embedded, loaded on demand from /vendor/)
              • local images served via http://madreader.localhost/doc/<path>
              • links/keys → IPC → Rust (open file, history, shell actions)
```

| Path | Purpose |
|---|---|
| `src/main.rs` | Window, WebView, IPC commands, custom protocol, file loading, live reload, history |
| `src/render.rs` | Markdown → sanitized HTML, slugs, syntax highlighting |
| `src/install.rs` | Per-user install / uninstall, file associations, Default Apps |
| `src/settings.rs` | JSON settings |
| `src/i18n.rs` | Interface language for Rust-side messages |
| `src/update.rs` | Update check and download (GitHub Releases, WinHTTP) |
| `assets/ui/` | The reader UI (embedded into the exe at compile time) |
| `docs/guide.md`, `docs/guide.he.md` | In-app user guide, English and Hebrew (embedded) |
| `assets/vendor/` | KaTeX, Mermaid and Viz.js (embedded; large files gzip-compressed by `build.rs`) |
| `.github/workflows/release.yml` | Builds and publishes a GitHub release for each `v*` tag |
| `tests/e2e.py`, `tests/fixtures/` | End-to-end UI tests |
| `installer/MadReader.iss` | Inno Setup script |
| `build.rs` | Embeds icons, manifest and version info |

## License

MIT. See [LICENSE](LICENSE).

Bundled third-party software: [KaTeX](https://katex.org) (MIT), [Mermaid](https://mermaid.js.org) (MIT) and [Viz.js](https://github.com/mdaines/viz-js) (MIT), which contains [Graphviz](https://graphviz.org) (EPL-1.0). Their licenses are in `assets/vendor/*/LICENSE`.
