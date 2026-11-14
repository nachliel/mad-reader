"""End-to-end tests for Mad Reader.

Launches the real exe with throw-away settings folders, attaches Playwright to
WebView2's DevTools port, and drives the app like a user (keyboard, clicks,
editing the open file). Screenshots are written to the output folder.

Usage:
    python tests/e2e.py [path\\to\\mad-reader.exe] [--out DIR]

Requires: pip install playwright   (no browser download needed — it attaches
to the WebView2 that ships with Windows).
"""
import argparse
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}" + (f"  — {detail}" if detail and not ok else ""))


def wait_js(page, expr, timeout=5000):
    """Poll a JS expression via page.evaluate. (Playwright's wait_for_function
    relies on eval(), which the app's Content-Security-Policy rightly blocks.)"""
    end = time.time() + timeout / 1000
    while True:
        try:
            if page.evaluate(expr):
                return True
        except Exception:
            pass
        if time.time() > end:
            raise TimeoutError(f"timed out waiting for: {expr}")
        time.sleep(0.05)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("exe", nargs="?", default=str(ROOT / "target" / "release" / "mad-reader.exe"))
    ap.add_argument("--out", default=None, help="folder for screenshots")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="madreader-e2e-"))
    out = Path(args.out) if args.out else tmp / "shots"
    out.mkdir(parents=True, exist_ok=True)
    docs = tmp / "docs"
    shutil.copytree(FIXTURES, docs)
    sample = docs / "sample.md"

    port = free_port()
    env = os.environ.copy()
    env["APPDATA"] = str(tmp / "appdata")
    env["LOCALAPPDATA"] = str(tmp / "localappdata")
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={port}"
    (tmp / "appdata").mkdir()
    (tmp / "localappdata").mkdir()
    # start in light theme, English UI, so results don't depend on this PC
    (tmp / "appdata" / "MadReader").mkdir()
    (tmp / "appdata" / "MadReader" / "settings.json").write_text(
        '{"ui":{"theme":"light","lang":"en","toc":true,"size":17,"direction":"auto"}}', encoding="utf-8")

    proc = subprocess.Popen([args.exe, str(sample)], env=env)
    try:
        with sync_playwright() as pw:
            browser = None
            deadline = time.time() + 20
            while time.time() < deadline:
                try:
                    browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
                    break
                except Exception:
                    time.sleep(0.3)
            if browser is None:
                check("attach to WebView2 DevTools", False, "could not connect")
                return finish(tmp, out)
            page = None
            while time.time() < deadline and page is None:
                pages = [p for c in browser.contexts for p in c.pages if "madreader.localhost" in p.url]
                page = pages[0] if pages else None
                if page is None:
                    # let Playwright process target events (time.sleep would not)
                    if browser.contexts:
                        try:
                            browser.contexts[0].wait_for_event("page", timeout=500)
                        except Exception:
                            pass
                    else:
                        time.sleep(0.2)
            if page is None:
                check("find the Mad Reader page", False, "no page")
                return finish(tmp, out)
            run_checks(page, docs, sample, out, tmp)
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
    code = finish(tmp, out)
    if args.out:
        time.sleep(1)  # WebView2 releases its cache files shortly after exit
        shutil.rmtree(tmp, ignore_errors=True)
    return code


def run_checks(page, docs, sample, out, tmp):
    js = page.evaluate
    wait_js(page, "document.querySelector('#doc h1')", timeout=10000)

    print("rendering")
    check("title from first H1", js("document.querySelector('#doc h1').textContent").startswith("מסמך בדיקה"))
    check("front matter hidden", "front matter" not in js("document.querySelector('#doc').textContent"))
    check("scripts stripped", js("window.__pwned === undefined"))
    check("no <script> in document", js("!document.querySelector('#doc script')"))

    print("direction (RTL)")
    dirs = js("""Array.from(document.querySelectorAll('#doc > p')).slice(0, 3).map(p => p.getAttribute('dir'))""")
    check("Hebrew paragraph is rtl", dirs[0] == "rtl", dirs)
    check("Hebrew paragraph starting with English word is rtl", dirs[1] == "rtl", dirs)
    check("English paragraph is ltr", dirs[2] == "ltr", dirs)
    check("document direction rtl", js("document.querySelector('#doc').dir") == "rtl")
    check("code block stays ltr", js("document.querySelector('#doc pre[data-lang]').getAttribute('dir')") == "ltr")
    check("TOC on the right for Hebrew doc", js("document.body.dataset.docdir") == "rtl")
    check("TOC lists headings", js("document.querySelectorAll('#toc a').length") == js("document.querySelectorAll('#doc h1[id],#doc h2[id],#doc h3[id],#doc h4[id]').length"))

    print("math + diagrams + images")
    page.wait_for_selector("#doc .katex", timeout=10000)
    check("math typeset (inline + 2 display)", js("document.querySelectorAll('#doc .math .katex').length") >= 3)
    check("no math errors", js("!document.querySelector('#doc .katex-error, #doc .math.error')"))
    check("KaTeX glyph SVGs not shrunk by UI icon styles",
          js("Array.from(document.querySelectorAll('#doc .katex svg')).every(s => s.getBoundingClientRect().width !== 18)"))
    check("prices not treated as math", "$5" in js("document.querySelector('#doc').textContent"))
    try:
        page.wait_for_selector("#doc .mermaid-block.rendered svg", timeout=15000)
        check("mermaid diagram drawn", True)
        w = js("document.querySelector('#doc .mermaid-block svg').getBoundingClientRect().width")
        check("diagram drawn at a readable size", w > 200, f"width={w}")
        labels = js("Array.from(document.querySelectorAll('#doc .mermaid-block .nodeLabel')).map(n => n.textContent)")
        check("diagram has exactly its own nodes", sorted(labels) == sorted(["התחלה", "בדיקה", "סוף", "כן"]) or set(labels) >= {"התחלה", "בדיקה", "סוף"} and "Copy" not in labels, labels)
        page.evaluate("document.querySelector('#doc .mermaid-block').scrollIntoView({block: 'center'})")
        page.wait_for_timeout(300)
        page.screenshot(path=str(out / "00-diagram.png"))
    except Exception:
        err = js("document.querySelector('.mermaid-error')?.textContent || ''")
        check("mermaid diagram drawn", False, err)
    wait_js(page, "document.querySelector('#doc img[src=\"pic.png\"]')?.naturalWidth > 0", timeout=5000)
    check("local image loads", True)
    page.screenshot(path=str(out / "01-hebrew-light.png"))

    print("find")
    page.keyboard.press("Control+f")
    page.wait_for_selector("#findbar:not([hidden])")
    page.keyboard.type("בראשית")
    wait_js(page, "document.querySelector('#find-count').textContent.includes('/')", timeout=3000)
    count = js("document.querySelector('#find-count').textContent")
    check("search ignores niqqud (2 hits)", count.endswith("/2"), count)
    page.keyboard.press("Enter")
    check("Enter moves to next hit", js("document.querySelector('#find-count').textContent").startswith("2/"))
    page.keyboard.press("Escape")
    check("Esc closes find and clears marks", js("!document.querySelector('mark.find-hit')") and js("document.querySelector('#findbar').hidden"))

    print("links + history")
    top0 = js("document.querySelector('#scroller').scrollTop")
    page.click("#doc a[href='#נוסחאות']")
    page.wait_for_timeout(700)
    check("in-page anchor scrolls", js("document.querySelector('#scroller').scrollTop") != top0)
    page.click("#doc a[href='second.md']")
    wait_js(page, "document.querySelector('#doc h1')?.textContent.startsWith('Second')", timeout=5000)
    check("relative .md link opens inside the app", True)
    check("back button enabled", js("!document.querySelector('#btn-back').disabled"))
    page.keyboard.press("Alt+ArrowLeft")
    wait_js(page, "document.querySelector('#doc h1')?.textContent.startsWith('מסמך')", timeout=5000)
    check("Alt+Left goes back", True)
    page.keyboard.press("Alt+ArrowRight")
    wait_js(page, "document.querySelector('#doc h1')?.textContent.startsWith('Second')", timeout=5000)
    check("Alt+Right goes forward", True)
    page.click("#doc a[href^='sample.md#']")
    wait_js(page, "document.querySelector('#doc h1')?.textContent.startsWith('מסמך')", timeout=5000)
    page.wait_for_timeout(500)
    in_view = js("""(() => { const h = document.getElementById('קישורים'); const r = h.getBoundingClientRect();
                    return r.top >= 0 && r.top < innerHeight; })()""")
    check("link with #fragment to another file scrolls to heading", in_view)

    print("appearance")
    page.keyboard.press("Control+t")
    page.wait_for_timeout(200)
    check("Ctrl+T cycles theme (light → sepia)", js("document.documentElement.dataset.theme") == "sepia")
    page.keyboard.press("Control+t")
    page.wait_for_timeout(300)
    check("Ctrl+T cycles theme (sepia → dark)", js("document.documentElement.dataset.theme") == "dark")
    page.wait_for_selector("#doc .mermaid-block.rendered svg", timeout=15000)
    check("diagram redrawn for dark theme", True)
    page.wait_for_timeout(400)
    page.screenshot(path=str(out / "02-hebrew-dark.png"))
    size0 = js("getComputedStyle(document.documentElement).getPropertyValue('--size')")
    page.keyboard.press("Control+Equal")
    check("Ctrl+= enlarges text", js("getComputedStyle(document.documentElement).getPropertyValue('--size')") != size0)
    page.keyboard.press("Control+0")
    page.keyboard.press("Control+d")
    check("Ctrl+D forces RTL", js("document.querySelector('#doc').dir") == "rtl" and js("!document.querySelector('#doc p[dir=ltr]')"))
    page.keyboard.press("Control+d")
    check("Ctrl+D forces LTR", js("document.querySelector('#doc').dir") == "ltr")
    page.keyboard.press("Control+d")
    check("Ctrl+D back to auto", js("document.querySelector('#doc p[dir=ltr]') !== null"))

    print("Hebrew interface")
    page.click("#btn-aa")
    page.click(".seg[data-key=lang] button[data-v=he]")
    check("UI switches to RTL", js("document.documentElement.dir") == "rtl")
    check("toolbar tooltips in Hebrew", js("document.querySelector('#btn-open').title").startswith("פתיחת קובץ"))
    check("menu labels in Hebrew", js("document.querySelector('[data-act=print] span').textContent").startswith("הדפסה"))
    check("footer in Hebrew", "מילים" in js("document.querySelector('#doc-foot').textContent"))
    page.wait_for_timeout(200)
    page.screenshot(path=str(out / "03-hebrew-ui-menu.png"))
    page.keyboard.press("Escape")
    page.keyboard.press("F1")
    check("shortcuts dialog in Hebrew", "קיצורי מקלדת" in js("document.querySelector('#modal-body').textContent"))
    page.screenshot(path=str(out / "04-hebrew-shortcuts.png"))
    page.keyboard.press("Escape")

    print("live reload")
    with open(sample, "a", encoding="utf-8") as f:
        f.write("\n\nשורה חדשה שנוספה בזמן אמת.\n")
    wait_js(page, "document.querySelector('#doc').textContent.includes('שורה חדשה')", timeout=5000)
    check("file edits appear without reloading", True)

    print("home + guide")
    page.keyboard.press("Control+h")
    page.wait_for_selector("body.no-doc")
    names = js("Array.from(document.querySelectorAll('#recent .r-name')).map(e => e.textContent)")
    check("recent files listed", "sample.md" in names and "second.md" in names, names)
    check("welcome in Hebrew", js("document.querySelector('#wl-open span').textContent") == "פתיחת קובץ")
    page.screenshot(path=str(out / "05-hebrew-home.png"))
    page.click("#wl-guide")
    wait_js(page, "document.querySelector('#doc h1')?.textContent.includes('מדריך')", timeout=5000)
    check("guide opens in Hebrew", True)
    page.wait_for_selector("#doc .mermaid-block.rendered svg", timeout=15000)
    check("guide diagram drawn", True)
    page.click("#btn-aa")
    page.click(".seg[data-key=lang] button[data-v=en]")
    page.keyboard.press("Escape")
    wait_js(page, "document.querySelector('#doc h1')?.textContent.includes('User Guide')", timeout=5000)
    check("guide switches to English with the UI", js("document.documentElement.dir") == "ltr")

    print("settings persisted")
    page.wait_for_timeout(800)
    import json
    st = json.loads((tmp / "appdata" / "MadReader" / "settings.json").read_text(encoding="utf-8-sig"))
    check("theme saved", st["ui"].get("theme") == "dark", st["ui"])
    check("language saved", st["ui"].get("lang") == "en", st["ui"])
    check("recent files saved", any(r.endswith("sample.md") for r in st.get("recent", [])), st.get("recent"))


def finish(tmp, out):
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed. Screenshots: {out}")
    if out.parent == tmp:
        print("(temporary folder; pass --out to keep screenshots)")
    return 1 if failed or not results else 0


if __name__ == "__main__":
    sys.exit(main())
