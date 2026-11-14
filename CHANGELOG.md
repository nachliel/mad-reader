# Changelog

## 1.3.0 — 2026-11-14

- **Export** (⋯ → Export…, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>):
  - **PDF** through WebView2, with page numbers and A4 or Letter paper from the Windows region.
  - **Word (.docx)**, editable. Word heading styles, right-to-left Hebrew paragraphs, lists and tables, real Word equations (converted from the MathML), embedded diagrams and pictures, coloured code, working links and footnotes.
  - **Web page (.html)**, a single file: pictures embedded, SVG diagrams, MathML equations.
  - Exports always use the light theme. When an export finishes, a message offers **Open** and **Show in folder**.
- **Print** (<kbd>Ctrl</kbd>+<kbd>P</kbd>) also lays the page out in the light theme and adds page numbers.
- Fix: in a Hebrew document, English paragraphs and lists were right-aligned. They are now left-aligned.

## 1.2.0 — 2026-11-14

- **Graphviz:** ```` ```dot ```` / ```` ```graphviz ```` blocks are laid out by Graphviz (Viz.js, WebAssembly) and work offline. All layout engines are available (`dot`, `neato`, `circo`, `fdp`, `twopi`, …). Graphs follow the theme unless they set their own colours, text on filled nodes stays readable, and Hebrew labels work.
- **Updates:** a quiet daily check against GitHub Releases, with a card that shows the new version and its release notes. **Update** downloads the setup, verifies its size and SHA-256, installs silently and reopens the document you had open. You can skip a version, check by hand (⋯ → Check for updates…) or turn the check off (About).
- Release workflow (`.github/workflows/release.yml`): pushing a `v*` tag builds, tests and publishes the setup and the portable zip.
- The setup removes the duplicate *Installed apps* entry left by an earlier in-app install.

## 1.1.0 — 2026-11-14

- **Math:** LaTeX via KaTeX: `$inline$`, `$$display$$` and ```` ```math ```` blocks. Prices like "$5 and $10" are left alone.
- **Diagrams:** ```` ```mermaid ```` blocks are drawn with Mermaid and redrawn when the theme changes. Hebrew labels work.
- **Hebrew interface:** a full Hebrew UI with a mirrored right-to-left layout, Hebrew message boxes and toasts, and a Hebrew user guide. Language: Auto (Windows) / English / עברית.
- KaTeX and Mermaid are embedded (offline) and load only when a document needs them. Mermaid is gzip-compressed inside the exe.
- End-to-end test suite (`tests/e2e.py`) that drives the real app through WebView2 DevTools.
- Fix: the toolbar icon style no longer shrinks SVGs inside documents.
- Serif font falls back to Times New Roman for Hebrew (larger and more readable than David).

## 1.0.0 — 2026-11-14

First release.

- Markdown reader built with Rust + WebView2 (single 4 MB exe)
- GitHub-flavoured Markdown: tables, task lists, footnotes, alerts, definition lists, front matter
- Per-paragraph Hebrew / RTL direction detection with Auto / RTL / LTR override
- Niqqud-insensitive search; Windows-1255 and UTF-16 file support
- Syntax highlighting with copy buttons
- Live reload, history, recent files, drag and drop, table of contents
- Light / Sepia / Dark themes, font, size, spacing, width, justification
- Print / PDF
- Per-user installer (Inno Setup, English + Hebrew) and built-in self-installer
- File associations and Default Apps registration
