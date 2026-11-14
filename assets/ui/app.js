// Mad Reader — reader UI logic.
// The Rust side renders Markdown and calls MR.load(payload); this file
// handles everything visual: direction detection (Hebrew / RTL), table of
// contents, find, appearance, menus, keyboard shortcuts.
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const send = (cmd, extra = {}) => window.ipc.postMessage(JSON.stringify({ cmd, ...extra }));

const DEFAULTS = { theme: 'system', font: 'sans', size: 17, leading: 'normal', width: 'normal', direction: 'auto', justify: 'off', toc: true, lang: 'auto' };
const ORIGIN = 'http://madreader.localhost';

const root = document.documentElement;
const body = document.body;
const docEl = $('#doc');
const scroller = $('#scroller');
const tocEl = $('#toc');

const state = {
  ui: { ...DEFAULTS },
  doc: null,
  recent: [],
  scrolls: new Map(),
  registered: false,
  installed: false,
  isDefault: false,
  dismissedDefaultHint: false,
  version: '',
  sysLang: 'en',
  autoUpdate: true,
  update: null, // { state, version, notes, canInstall, … }
  find: { hits: [], idx: -1, query: '' },
};

/* ── Interface language ──────────────────────────────── */

const STRINGS = {
  en: {
    tocTip: 'Contents (Ctrl+B)', backTip: 'Back (Alt+←)', fwdTip: 'Forward (Alt+→)', openTip: 'Open file (Ctrl+O)',
    findTip: 'Find (Ctrl+F)', dirTip: 'Text direction (Ctrl+D)', aaTip: 'Appearance', moreTip: 'More',
    contents: 'Contents', noHeadings: 'No headings',
    tagline: 'Markdown, beautifully. <span dir="rtl" lang="he">גם בעברית.</span>',
    openFile: 'Open file', userGuide: 'User guide', dropHint: '…or drop a Markdown file anywhere in this window',
    installTitle: 'Install Mad Reader', installText: 'Adds it to the Start menu and to “Open with” for .md files. No admin rights needed.', install: 'Install',
    defaultTitle: 'Open .md files with Mad Reader', defaultText: 'Windows asks you to confirm the default app once, in Settings → Default apps.',
    setDefault: 'Set as default', dontShow: "Don't show again",
    recent: 'Recent', clear: 'Clear', removeRecent: 'Remove from list', fileMissing: 'File not found',
    findPh: 'Find in document', prevTip: 'Previous (Shift+Enter)', nextTip: 'Next (Enter)', closeTip: 'Close (Esc)',
    theme: 'Theme', auto: 'Auto', followWindows: 'Follow Windows', light: 'Light', sepia: 'Sepia', dark: 'Dark',
    font: 'Font', sans: 'Sans · אבג', serif: 'Serif · אבג', textSize: 'Text size', smallerTip: 'Smaller (Ctrl+−)', largerTip: 'Larger (Ctrl+=)',
    lineSpacing: 'Line spacing', compact: 'Compact', normal: 'Normal', relaxed: 'Relaxed',
    pageWidth: 'Page width', narrow: 'Narrow', wide: 'Wide', full: 'Full',
    direction: 'Direction', dirAutoTip: 'Per paragraph, from its language', rtl: 'RTL · ימין', ltr: 'LTR',
    justify: 'Justify text', off: 'Off', on: 'On', language: 'Language',
    mEdit: 'Open in editor', mReveal: 'Show in folder', mOpenWith: 'Open with…', mCopyPath: 'Copy file path',
    mPrint: 'Print / Save as PDF', mReload: 'Reload', mNewWindow: 'New window', mFullscreen: 'Full screen',
    mHome: 'Home', mShortcuts: 'Keyboard shortcuts', mDefaultApps: 'Default app settings…', mAbout: 'About Mad Reader',
    dropToOpen: 'Drop to open', autoShort: 'Auto',
    copy: 'Copy', copied: 'Copied', linkSection: 'Link to this section',
    footer: (w, m) => `${w} words · ~${m} min read`,
    dirToast: { auto: 'Direction: automatic per paragraph', rtl: 'Direction: right-to-left', ltr: 'Direction: left-to-right' },
    themeToast: { system: 'Theme: follow Windows', light: 'Theme: light', sepia: 'Theme: sepia', dark: 'Theme: dark' },
    pathCopied: 'Path copied', installedToast: 'Installed. Pick “Mad Reader” in the Settings window to make it the default.',
    diagramError: 'Could not draw this diagram:',
    mCheckUpdate: 'Check for updates…', mUpdateTo: (v) => `Update to ${v}…`,
    ucTitle: (v) => `Mad Reader ${v}`, ucText: 'A new version is ready.', whatsNew: "What's new", updateNow: 'Update', later: 'Later',
    updTitle: (v) => `Mad Reader ${v} is available`, updCurrent: (v) => `You have version ${v}.`,
    updInstall: 'Update now', updDownload: 'Download…', updSkip: 'Skip this version', updLater: 'Later',
    updPortable: 'This copy is not installed, so the download page will open.',
    updNoNotes: 'No release notes.',
    updChecking: 'Checking for updates…', updLatest: (v) => `You have the latest version (${v}).`,
    updDownloading: 'Downloading the update…', updRestart: 'Mad Reader will close, update and open again.',
    updError: 'Could not update', updRetry: 'Try again', updReleases: 'Releases page',
    checkNow: 'Check for updates', autoCheck: 'Check for updates automatically',
    shortcutsTitle: 'Keyboard shortcuts',
    shortcuts: [
      ['Open file', 'Ctrl O'], ['New window', 'Ctrl N'], ['Close window', 'Ctrl W'],
      ['Find in document', 'Ctrl F'], ['Next / previous match', 'F3 / Shift F3'],
      ['Table of contents', 'Ctrl B'], ['Text direction: Auto → RTL → LTR', 'Ctrl D'],
      ['Theme: Auto → Light → Sepia → Dark', 'Ctrl T'], ['Larger / smaller / reset text', 'Ctrl + / Ctrl − / Ctrl 0'],
      ['Back / forward', 'Alt ← / Alt →'], ['Reload', 'F5 / Ctrl R'], ['Print or save as PDF', 'Ctrl P'],
      ['Open in editor', 'Ctrl E'], ['Show in folder', 'Ctrl Shift E'], ['Full screen', 'F11'],
      ['Home', 'Ctrl H'], ['Top / bottom', 'Home / End'], ['This list', 'F1'],
    ],
    about: 'A fast, good-looking Markdown reader for Windows.<br><span dir="rtl" lang="he">קורא Markdown מהיר ויפה, עם תמיכה מלאה בעברית.</span>',
  },
  he: {
    tocTip: 'תוכן עניינים (Ctrl+B)', backTip: 'אחורה (Alt+←)', fwdTip: 'קדימה (Alt+→)', openTip: 'פתיחת קובץ (Ctrl+O)',
    findTip: 'חיפוש (Ctrl+F)', dirTip: 'כיוון טקסט (Ctrl+D)', aaTip: 'תצוגה', moreTip: 'עוד',
    contents: 'תוכן עניינים', noHeadings: 'אין כותרות',
    tagline: 'קורא Markdown מהיר ויפה, עם תמיכה מלאה בעברית.',
    openFile: 'פתיחת קובץ', userGuide: 'מדריך למשתמש', dropHint: '…או גררו קובץ Markdown לכל מקום בחלון',
    installTitle: 'התקנת Mad Reader', installText: 'מוסיף אותו לתפריט התחל ולרשימת „פתח באמצעות” של קובצי md. לא נדרשות הרשאות מנהל.', install: 'התקנה',
    defaultTitle: 'פתיחת קובצי md עם Mad Reader', defaultText: 'Windows מבקש לאשר את אפליקציית ברירת המחדל פעם אחת, בהגדרות ← אפליקציות ברירת מחדל.',
    setDefault: 'הגדרה כברירת מחדל', dontShow: 'לא להציג שוב',
    recent: 'אחרונים', clear: 'ניקוי', removeRecent: 'הסרה מהרשימה', fileMissing: 'הקובץ לא נמצא',
    findPh: 'חיפוש במסמך', prevTip: 'הקודם (Shift+Enter)', nextTip: 'הבא (Enter)', closeTip: 'סגירה (Esc)',
    theme: 'ערכת נושא', auto: 'אוטומטי', followWindows: 'לפי Windows', light: 'בהירה', sepia: 'ספיה', dark: 'כהה',
    font: 'גופן', sans: 'ללא תגים · Aa', serif: 'עם תגים · Aa', textSize: 'גודל טקסט', smallerTip: 'הקטנה (Ctrl+−)', largerTip: 'הגדלה (Ctrl+=)',
    lineSpacing: 'ריווח שורות', compact: 'צפוף', normal: 'רגיל', relaxed: 'מרווח',
    pageWidth: 'רוחב עמוד', narrow: 'צר', wide: 'רחב', full: 'מלא',
    direction: 'כיוון', dirAutoTip: 'לכל פסקה לפי השפה שלה', rtl: 'ימין לשמאל', ltr: 'שמאל לימין',
    justify: 'יישור לשני הצדדים', off: 'כבוי', on: 'פעיל', language: 'שפה',
    mEdit: 'פתיחה בעורך', mReveal: 'הצגה בתיקייה', mOpenWith: 'פתיחה באמצעות…', mCopyPath: 'העתקת נתיב הקובץ',
    mPrint: 'הדפסה / שמירה כ-PDF', mReload: 'רענון', mNewWindow: 'חלון חדש', mFullscreen: 'מסך מלא',
    mHome: 'מסך הבית', mShortcuts: 'קיצורי מקלדת', mDefaultApps: 'הגדרות אפליקציית ברירת מחדל…', mAbout: 'אודות Mad Reader',
    dropToOpen: 'שחררו כדי לפתוח', autoShort: 'אוטו׳',
    copy: 'העתקה', copied: 'הועתק', linkSection: 'קישור לסעיף הזה',
    footer: (w, m) => `${w} מילים · כ-${m} דקות קריאה`,
    dirToast: { auto: 'כיוון: אוטומטי לכל פסקה', rtl: 'כיוון: מימין לשמאל', ltr: 'כיוון: משמאל לימין' },
    themeToast: { system: 'ערכת נושא: לפי Windows', light: 'ערכת נושא: בהירה', sepia: 'ערכת נושא: ספיה', dark: 'ערכת נושא: כהה' },
    pathCopied: 'הנתיב הועתק', installedToast: 'ההתקנה הושלמה. בחלון ההגדרות בחרו ב-Mad Reader כדי להגדיר אותו כברירת מחדל.',
    diagramError: 'לא ניתן לצייר את התרשים:',
    mCheckUpdate: 'בדיקת עדכונים…', mUpdateTo: (v) => `עדכון לגרסה ${v}…`,
    ucTitle: (v) => `Mad Reader ${v}`, ucText: 'גרסה חדשה מוכנה.', whatsNew: 'מה חדש', updateNow: 'עדכון', later: 'אחר כך',
    updTitle: (v) => `גרסה ${v} של Mad Reader זמינה`, updCurrent: (v) => `הגרסה המותקנת: ${v}.`,
    updInstall: 'עדכון עכשיו', updDownload: 'הורדה…', updSkip: 'דילוג על הגרסה הזאת', updLater: 'אחר כך',
    updPortable: 'העותק הזה אינו מותקן, ולכן ייפתח דף ההורדה.',
    updNoNotes: 'אין הערות גרסה.',
    updChecking: 'בודק עדכונים…', updLatest: (v) => `מותקנת הגרסה העדכנית ביותר (${v}).`,
    updDownloading: 'מוריד את העדכון…', updRestart: 'Mad Reader ייסגר, יתעדכן וייפתח מחדש.',
    updError: 'העדכון נכשל', updRetry: 'ניסיון נוסף', updReleases: 'דף הגרסאות',
    checkNow: 'בדיקת עדכונים', autoCheck: 'לבדוק עדכונים באופן אוטומטי',
    shortcutsTitle: 'קיצורי מקלדת',
    shortcuts: [
      ['פתיחת קובץ', 'Ctrl O'], ['חלון חדש', 'Ctrl N'], ['סגירת החלון', 'Ctrl W'],
      ['חיפוש במסמך', 'Ctrl F'], ['התוצאה הבאה / הקודמת', 'F3 / Shift F3'],
      ['תוכן עניינים', 'Ctrl B'], ['כיוון טקסט: אוטומטי ← ימין לשמאל ← שמאל לימין', 'Ctrl D'],
      ['ערכת נושא: אוטומטי ← בהירה ← ספיה ← כהה', 'Ctrl T'], ['הגדלה / הקטנה / איפוס הטקסט', 'Ctrl + / Ctrl − / Ctrl 0'],
      ['אחורה / קדימה', 'Alt ← / Alt →'], ['רענון', 'F5 / Ctrl R'], ['הדפסה או שמירה כ-PDF', 'Ctrl P'],
      ['פתיחה בעורך', 'Ctrl E'], ['הצגה בתיקייה', 'Ctrl Shift E'], ['מסך מלא', 'F11'],
      ['מסך הבית', 'Ctrl H'], ['תחילת / סוף המסמך', 'Home / End'], ['הרשימה הזאת', 'F1'],
    ],
    about: 'קורא Markdown מהיר ויפה ל-Windows, עם תמיכה מלאה בעברית.',
  },
};

let LANG = 'en';
const t = (key) => STRINGS[LANG][key] ?? STRINGS.en[key] ?? key;

function applyLang() {
  const want = state.ui.lang === 'auto' ? state.sysLang : state.ui.lang;
  LANG = want === 'he' ? 'he' : 'en';
  root.lang = LANG;
  root.dir = LANG === 'he' ? 'rtl' : 'ltr';
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of $$('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of $$('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  $('#dir-label').textContent = state.ui.direction === 'auto' ? t('autoShort') : state.ui.direction.toUpperCase();
  if (state.doc) {
    updateFooter();
    for (const b of $$('.copy-btn:not(.done)', docEl)) b.lastChild.textContent = t('copy');
    for (const a of $$('.h-anchor', docEl)) a.title = t('linkSection');
    if (!headings.length) buildToc();
  }
  renderWelcome();
  renderUpdateBadge();
}

/* ── Bidi / RTL ──────────────────────────────────────── */

const RTL_CH = '֐-׿؀-ۿ܀-ࣿיִ-﷿ﹰ-﻿';
const LTR_CH = 'A-Za-zÀ-ɏͰ-ϿЀ-ӿḀ-ỿ';
const STRONG = new RegExp(`[${RTL_CH}]|[${LTR_CH}]`);
const IS_RTL = new RegExp(`[${RTL_CH}]`);

/** Text of an element, skipping code (and optionally nested blocks). */
function proseText(el, skipNested) {
  let out = '';
  const walk = (n) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.nodeType === 1) {
        const t = c.tagName;
        if (t === 'CODE' || t === 'PRE' || t === 'KBD' || t === 'svg' || t === 'math') continue;
        if (c.classList.contains('math') || c.classList.contains('mermaid-block') || c.classList.contains('graphviz-block')) continue;
        if (skipNested && (t === 'UL' || t === 'OL' || t === 'TABLE' || t === 'BLOCKQUOTE')) continue;
        if (t === 'BR' || t === 'P' || t === 'LI') out += ' ';
        walk(c);
        out += ' ';
      }
    }
  };
  walk(el);
  return out;
}

/** Decide direction by counting RTL vs LTR words; tie → first strong word.
 *  "React הוא ספרייה" → rtl;  "The word שלום means peace" → ltr. */
function detectDir(text) {
  let r = 0, l = 0, first = null;
  for (const w of text.split(/\s+/)) {
    const m = STRONG.exec(w);
    if (!m) continue;
    const rtl = IS_RTL.test(m[0]);
    if (rtl) r++; else l++;
    if (!first) first = rtl ? 'rtl' : 'ltr';
  }
  if (r > l) return 'rtl';
  if (l > r) return 'ltr';
  return first;
}

const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,dt,dd,th,td,caption,summary,figcaption,blockquote,ul,ol,table,details,dl,.footnote-definition,div:not(.table-wrap)';

function applyDirection() {
  const mode = state.ui.direction;
  for (const el of $$('[data-mrdir]', docEl)) { el.removeAttribute('dir'); el.removeAttribute('data-mrdir'); }
  let docDir;
  if (mode === 'rtl' || mode === 'ltr') {
    docDir = mode;
  } else {
    docDir = detectDir(proseText(docEl, false)) || 'ltr';
    for (const el of $$(BLOCKS, docEl)) {
      if (el.closest('pre')) continue;
      const nested = el.tagName === 'LI' || el.tagName === 'DD';
      const d = detectDir(proseText(el, nested)) || (nested ? detectDir(proseText(el, false)) : null);
      if (d) { el.setAttribute('dir', d); el.setAttribute('data-mrdir', ''); }
    }
  }
  docEl.setAttribute('dir', docDir);
  body.dataset.docdir = docDir;
  // TOC entries follow their headings
  for (const a of $$('a', tocEl)) {
    const h = document.getElementById(a.dataset.id);
    a.dir = h ? (h.getAttribute('dir') || docDir) : docDir;
  }
  tocEl.dir = docDir;
  $('#dir-label').textContent = mode === 'auto' ? t('autoShort') : mode.toUpperCase();
  $('#btn-dir').classList.toggle('on', mode !== 'auto');
}

/* ── Appearance ──────────────────────────────────────── */

const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function resolvedTheme() {
  const t = state.ui.theme;
  return t === 'system' ? (darkMQ.matches ? 'dark' : 'light') : t;
}
let lastDark = null;
function applyUI() {
  const ui = state.ui;
  const theme = resolvedTheme();
  root.dataset.theme = theme;
  root.dataset.font = ui.font;
  root.dataset.leading = ui.leading;
  root.dataset.width = ui.width;
  root.dataset.justify = ui.justify;
  root.style.setProperty('--size', ui.size + 'px');
  $('#size-val').textContent = ui.size;
  body.classList.toggle('toc-open', !!ui.toc);
  $('#btn-toc').classList.toggle('on', !!ui.toc);
  for (const seg of $$('.seg')) {
    for (const b of $$('button', seg)) b.classList.toggle('on', String(ui[seg.dataset.key]) === b.dataset.v);
  }
  const dark = theme === 'dark';
  if (dark !== lastDark) {
    const first = lastDark === null;
    lastDark = dark;
    send('theme', { dark });
    if (!first && state.doc) { renderDiagrams(); renderGraphviz(); }
  }
}
darkMQ.addEventListener('change', () => applyUI());

let saveTimer = 0;
function setUI(patch, { redirection = false } = {}) {
  const anchor = topVisibleBlock();
  Object.assign(state.ui, patch);
  applyUI();
  if ('lang' in patch) applyLang();
  if (redirection && state.doc) applyDirection();
  if (anchor) restoreAnchor(anchor);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => send('ui', { ui: state.ui }), 250);
}

// Keep the reading position when text size / width changes.
function topVisibleBlock() {
  if (!state.doc) return null;
  const top = scroller.getBoundingClientRect().top;
  for (const el of docEl.children) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top + 4) return { el, offset: r.top - top };
  }
  return null;
}
function restoreAnchor({ el, offset }) {
  const top = scroller.getBoundingClientRect().top;
  scroller.scrollTop += (el.getBoundingClientRect().top - top) - offset;
}

/* ── Document loading ────────────────────────────────── */

const MR = window.MR = {};

MR.init = (cfg) => {
  state.version = cfg.version;
  state.ui = { ...DEFAULTS, ...(cfg.ui && typeof cfg.ui === 'object' ? cfg.ui : {}) };
  state.recent = cfg.recent || [];
  state.registered = cfg.registered;
  state.installed = cfg.installed;
  state.isDefault = cfg.isDefault;
  state.dismissedDefaultHint = cfg.dismissedDefaultHint;
  state.sysLang = cfg.sysLang || 'en';
  state.autoUpdate = cfg.autoUpdate !== false;
  applyUI();
  applyLang();
};

MR.rememberScroll = () => {
  if (state.doc) state.scrolls.set(state.doc.url, scroller.scrollTop);
};

MR.load = (p) => {
  const keepScroll = p.reload && state.doc && state.doc.url === p.url;
  const prevTop = scroller.scrollTop;
  const anchor = keepScroll ? topVisibleBlock() : null;
  if (!keepScroll) MR.rememberScroll();

  state.doc = p;
  $('#docbase').href = p.base;
  docEl.innerHTML = p.html;
  enhance();
  buildToc();
  applyDirection();
  body.classList.remove('no-doc');

  $('#doc-title-main').textContent = p.title || p.name;
  $('#doc-title-file').textContent = p.title && p.title !== p.name ? p.name : '';
  $('#doc-title').title = p.path || p.name;
  $('#btn-back').disabled = !p.canBack;
  $('#btn-fwd').disabled = !p.canForward;
  updateFooter();
  const gen = ++renderGen;

  if (keepScroll) {
    scroller.scrollTop = prevTop;
    if (anchor && !anchor.el.isConnected) scroller.scrollTop = prevTop;
  } else if (p.fragment) {
    requestAnimationFrame(() => scrollToId(p.fragment, false));
  } else {
    scroller.scrollTop = state.scrolls.get(p.url) || 0;
  }
  if (!$('#findbar').hidden && state.find.query) runFind(state.find.query, true);
  onScroll();
  if (p.hasMath || p.hasMermaid || p.hasGraphviz) {
    renderRich(gen).then(() => {
      if (gen !== renderGen) return;
      if (keepScroll) scroller.scrollTop = prevTop;
      else if (p.fragment) scrollToId(p.fragment, false);
      if (!$('#findbar').hidden && state.find.query) runFind(state.find.query, true);
      onScroll();
    });
  }
};

function updateFooter() {
  const p = state.doc;
  if (!p) return;
  const mins = Math.max(1, Math.round(p.words / 220));
  $('#doc-foot').textContent = t('footer')(p.words.toLocaleString(LANG === 'he' ? 'he-IL' : 'en-US'), mins);
}

/* ── Math (KaTeX) and diagrams (Mermaid), loaded on demand ── */

let renderGen = 0;
const loaded = {};
function loadScript(src) {
  return (loaded[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { delete loaded[src]; reject(new Error('failed to load ' + src)); };
    document.head.appendChild(s);
  }));
}
function loadCss(href) {
  if (loaded[href]) return;
  loaded[href] = true;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}

async function renderRich(gen) {
  const jobs = [];
  if ($('.math', docEl)) jobs.push(renderMath(gen));
  if ($('.mermaid-block', docEl)) jobs.push(renderDiagrams(gen));
  if ($('.graphviz-block', docEl)) jobs.push(renderGraphviz(gen));
  await Promise.allSettled(jobs);
}

async function renderMath(gen) {
  loadCss(ORIGIN + '/vendor/katex/katex.min.css');
  await loadScript(ORIGIN + '/vendor/katex/katex.min.js');
  if (gen !== renderGen) return;
  for (const el of $$('.math', docEl)) {
    const tex = el.textContent;
    try {
      window.katex.render(tex, el, {
        displayMode: el.classList.contains('math-display'),
        throwOnError: false,
        output: 'htmlAndMathml',
        trust: false,
        strict: 'ignore',
      });
      el.dataset.tex = tex;
    } catch (e) {
      el.classList.add('error');
      el.title = String(e.message || e);
    }
  }
}

let mermaidTheme = null;
async function renderDiagrams(gen = renderGen) {
  const blocks = $$('.mermaid-block', docEl);
  if (!blocks.length) return;
  await loadScript(ORIGIN + '/vendor/mermaid/mermaid.min.js');
  if (gen !== renderGen) return;
  const theme = resolvedTheme() === 'dark' ? 'dark' : 'default';
  if (theme !== mermaidTheme) {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      fontFamily: getComputedStyle(docEl).fontFamily,
    });
    mermaidTheme = theme;
  }
  let i = 0;
  for (const block of blocks) {
    const src = block.dataset.src ?? block.querySelector('.mermaid-src')?.textContent ?? '';
    block.dataset.src = src;
    try {
      const { svg } = await window.mermaid.render(`mmd-${gen}-${i++}`, src);
      if (gen !== renderGen) return;
      block.innerHTML = svg;
      block.classList.add('rendered');
    } catch (e) {
      if (gen !== renderGen) return;
      block.classList.remove('rendered');
      block.innerHTML = '';
      const pre = document.createElement('pre');
      pre.className = 'mermaid-src';
      pre.textContent = src;
      const err = document.createElement('p');
      err.className = 'mermaid-error';
      err.textContent = `${t('diagramError')} ${String(e.message || e).split('\n')[0]}`;
      block.append(pre, err);
    }
  }
}

let vizReady = null;
/** Graphviz (```dot) via Viz.js (Graphviz compiled to WebAssembly). Graphs
 *  that set no colours of their own follow the reader's theme. */
async function renderGraphviz(gen = renderGen) {
  const blocks = $$('.graphviz-block', docEl);
  if (!blocks.length) return;
  await loadScript(ORIGIN + '/vendor/viz/viz-global.js');
  vizReady ||= window.Viz.instance();
  const viz = await vizReady;
  if (gen !== renderGen) return;
  // Graphviz understands #rrggbb but not CSS rgb(...)
  const hex = (c) => {
    const m = String(c).match(/\d+(\.\d+)?/g);
    return c.startsWith('#') || !m ? c : '#' + m.slice(0, 3).map((x) => Math.round(+x).toString(16).padStart(2, '0')).join('');
  };
  const fg = hex(getComputedStyle(docEl).color);
  const muted = hex(getComputedStyle(root).getPropertyValue('--muted').trim() || fg);
  const fontname = state.ui.font === 'serif' ? 'Times' : 'Helvetica';
  const opts = {
    graphAttributes: { bgcolor: 'transparent', fontname, fontcolor: fg, color: muted },
    nodeAttributes: { fontname, fontcolor: fg, color: fg },
    edgeAttributes: { fontname, fontcolor: fg, color: muted },
  };
  for (const block of blocks) {
    const src = block.dataset.src ?? block.querySelector('.graphviz-src')?.textContent ?? '';
    block.dataset.src = src;
    try {
      const svg = viz.renderSVGElement(src, opts);
      cleanSvg(svg);
      fixContrast(svg, fg);
      block.replaceChildren(svg);
      block.classList.add('rendered');
    } catch (e) {
      block.classList.remove('rendered');
      const pre = document.createElement('pre');
      pre.className = 'graphviz-src';
      pre.textContent = src;
      const err = document.createElement('p');
      err.className = 'mermaid-error';
      err.textContent = `${t('diagramError')} ${String(e.message || e).split('\n').filter(Boolean).slice(0, 2).join(' ')}`;
      block.replaceChildren(pre, err);
    }
  }
}

/** Graphviz SVG may carry links from the source (URL="…"): keep only safe
 *  ones, and drop anything scriptable. */
function cleanSvg(svg) {
  for (const el of svg.querySelectorAll('script, foreignObject, iframe')) el.remove();
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'xlink:href') && !/^(https?:|mailto:|#)/i.test(a.value.trim())) el.removeAttribute(a.name);
    }
  }
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  const vb = svg.viewBox?.baseVal;
  if (vb && vb.width) svg.style.width = Math.round(vb.width * 1.333) + 'px';
}

/** Text in our default colour that sits on a filled shape (style=filled):
 *  make it dark or light, whichever reads on that fill. */
function fixContrast(svg, fg) {
  const lum = (c) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c || '');
    if (!m) return null;
    const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const g of svg.querySelectorAll('g.node, g.cluster')) {
    const shape = g.querySelector('polygon, ellipse, path');
    const l = lum(shape?.getAttribute('fill'));
    if (l === null) continue;
    for (const tx of g.querySelectorAll(':scope > text, :scope > g > text')) {
      if (tx.getAttribute('fill') === fg) tx.setAttribute('fill', l > 0.55 ? '#1d2026' : '#f4f5f7');
    }
  }
}

/* ── Updates ─────────────────────────────────────────── */

let ucDismissed = false;
MR.update = (u) => {
  const prev = state.update;
  if (u.state === 'available') state.update = u;
  else if (prev && prev.state === 'available') state.update = { ...prev, phase: u };
  renderUpdateBadge();
  const modalOpen = !$('#modal').hidden && $('#modal-body .update-modal');
  switch (u.state) {
    case 'checking': if (modalOpen || !$('#modal').hidden) updateModal({ state: 'checking' }); else MR.toast(t('updChecking')); break;
    case 'latest': state.update = null; renderUpdateBadge(); $('#update-card').hidden = true; if (!$('#modal').hidden) closeModal(); MR.toast(t('updLatest')(u.current)); break;
    case 'error': updateModal(u); break;
    case 'downloading': updateModal(u); break;
    case 'available':
      if (u.manual || modalOpen) updateModal(u);
      else showUpdateCard();
      break;
  }
};

function renderUpdateBadge() {
  const u = state.update && state.update.version ? state.update : null;
  $('#btn-more').classList.toggle('has-update', !!u);
  $('#m-update span').textContent = u ? t('mUpdateTo')(u.version) : t('mCheckUpdate');
  if (u) $('#uc-title').textContent = t('ucTitle')(u.version);
}

function showUpdateCard() {
  if (ucDismissed || !state.update) return;
  $('#uc-title').textContent = t('ucTitle')(state.update.version);
  $('#update-card').hidden = false;
}

function updateModal(u) {
  $('#update-card').hidden = true;
  const a = state.update;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let html;
  if (u.state === 'checking') {
    html = `<div class="update-modal"><h2>${t('updChecking')}</h2><div class="um-bar"><i style="width:35%"></i></div></div>`;
  } else if (u.state === 'downloading') {
    const pct = Math.round((u.progress || 0) * 100);
    html = `<div class="update-modal"><h2>${t('updDownloading')}</h2>
      <div class="um-bar"><i style="width:${pct}%"></i></div><p class="um-sub">${pct}% · ${t('updRestart')}</p></div>`;
  } else if (u.state === 'error') {
    html = `<div class="update-modal"><h2>${t('updError')}</h2><p class="um-error" dir="auto">${esc(u.message || '')}</p>
      <div class="um-actions"><button class="btn" data-u="page">${t('updReleases')}</button>
      <button class="btn primary" data-u="${a ? 'install' : 'check'}">${t('updRetry')}</button></div></div>`;
  } else {
    html = `<div class="update-modal"><h2>${t('updTitle')(esc(u.version))}</h2><p class="um-sub">${t('updCurrent')(esc(u.current || state.version))}</p>
      <div class="um-notes markdown-body" dir="auto">${u.notes || `<p>${t('updNoNotes')}</p>`}</div>
      ${u.canInstall ? '' : `<p class="um-sub">${t('updPortable')}</p>`}
      <div class="um-actions">
        <button class="btn ghost" data-u="skip">${t('updSkip')}</button>
        <button class="btn" data-u="later">${t('updLater')}</button>
        <button class="btn primary" data-u="install">${u.canInstall ? t('updInstall') : t('updDownload')}</button>
      </div></div>`;
  }
  modal(html);
  for (const el of $$('.um-notes [data-mrdir], .um-notes p, .um-notes li, .um-notes h1, .um-notes h2, .um-notes h3', $('#modal-body'))) {
    const d = detectDir(proseText(el, false));
    if (d) el.dir = d;
  }
}

$('#modal-body').addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (link) { e.preventDefault(); send('link', { href: link.href }); return; }
  const b = e.target.closest('[data-u]');
  if (!b) return;
  switch (b.dataset.u) {
    case 'install': send('installUpdate'); if (!state.update?.canInstall) closeModal(); break;
    case 'skip': send('skipUpdate'); state.update = null; renderUpdateBadge(); closeModal(); break;
    case 'later': closeModal(); break;
    case 'page': send('releasePage'); break;
    case 'check': send('checkUpdate'); break;
  }
});
$('#modal-body').addEventListener('change', (e) => {
  if (e.target.id === 'auto-update') {
    state.autoUpdate = e.target.checked;
    send('autoUpdate', { on: e.target.checked });
  }
});
$('#uc-notes').onclick = () => state.update && updateModal(state.update);
$('#uc-install').onclick = () => { $('#update-card').hidden = true; if (state.update?.canInstall) updateModal({ state: 'downloading', progress: 0 }); send('installUpdate'); };
$('#uc-close').onclick = () => { ucDismissed = true; $('#update-card').hidden = true; };

MR.home = (recent) => {
  state.doc = null;
  state.recent = recent || state.recent;
  docEl.innerHTML = '';
  tocEl.innerHTML = '';
  body.classList.add('no-doc');
  body.dataset.docdir = 'ltr';
  $('#doc-title-main').textContent = 'Mad Reader';
  $('#doc-title-file').textContent = '';
  $('#btn-back').disabled = $('#btn-fwd').disabled = true;
  closeFind();
  renderWelcome();
};

MR.toast = (msg) => {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(MR._toastT);
  MR._toastT = setTimeout(() => (t.hidden = true), 3200);
};

MR.installed = (ok) => {
  state.installed = ok;
  state.registered = ok;
  renderWelcome();
  MR.toast(t('installedToast'));
};

MR.dragging = (on) => { $('#drop-overlay').hidden = !on; };

function enhance() {
  // External links + heading anchors
  for (const a of $$('a[href]', docEl)) {
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:)/i.test(href)) a.classList.add('ext');
  }
  for (const h of $$('h1[id],h2[id],h3[id],h4[id]', docEl)) {
    const a = document.createElement('a');
    a.className = 'h-anchor';
    a.href = '#' + h.id;
    a.textContent = '#';
    a.title = t('linkSection');
    a.setAttribute('aria-hidden', 'true');
    h.appendChild(a);
  }
  // Tables scroll horizontally instead of overflowing
  for (const t of $$('table', docEl)) {
    if (t.parentElement.classList.contains('table-wrap')) continue;
    const w = document.createElement('div');
    w.className = 'table-wrap';
    t.replaceWith(w);
    w.appendChild(t);
  }
  // Task lists
  for (const cb of $$('input[type=checkbox]', docEl)) {
    cb.disabled = true;
    cb.closest('li')?.classList.add('task');
  }
  // Copy buttons
  for (const pre of $$('pre:not(.mermaid-src):not(.graphviz-src)', docEl)) {
    const b = document.createElement('button');
    b.className = 'copy-btn';
    b.innerHTML = '<svg><use href="#i-copy"/></svg>';
    b.append(t('copy'));
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const code = pre.querySelector('code') || pre;
      await copyText(code.innerText);
      b.classList.add('done');
      b.innerHTML = '<svg><use href="#i-check"/></svg>';
      b.append(t('copied'));
      setTimeout(() => { b.classList.remove('done'); b.innerHTML = '<svg><use href="#i-copy"/></svg>'; b.append(t('copy')); }, 1400);
    });
    pre.appendChild(b);
  }
  for (const img of $$('img', docEl)) {
    img.loading = 'lazy';
    img.decoding = 'async';
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
}

/* ── Table of contents ───────────────────────────────── */

let headings = [];
function buildToc() {
  headings = $$('h1[id],h2[id],h3[id],h4[id]', docEl);
  tocEl.innerHTML = '';
  if (!headings.length) {
    tocEl.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = t('noHeadings');
    tocEl.appendChild(d);
    return;
  }
  const minLevel = Math.min(...headings.map((h) => +h.tagName[1]));
  const frag = document.createDocumentFragment();
  for (const h of headings) {
    const a = document.createElement('a');
    const lvl = +h.tagName[1] - minLevel + 1;
    a.className = 'l' + lvl;
    a.href = '#' + h.id;
    a.dataset.id = h.id;
    const clone = h.cloneNode(true);
    clone.querySelector('.h-anchor')?.remove();
    a.textContent = clone.textContent.trim();
    a.title = a.textContent;
    frag.appendChild(a);
  }
  tocEl.appendChild(frag);
}

tocEl.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  scrollToId(a.dataset.id, true);
  if (innerWidth < 980) setUI({ toc: false });
});

function scrollToId(id, smooth) {
  let el = document.getElementById(id);
  if (!el) { try { el = document.getElementById(decodeURIComponent(id)); } catch {} }
  if (!el) el = document.getElementsByName(id)[0];
  if (!el || !docEl.contains(el)) return;
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 14;
  scroller.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

let scrollRaf = 0;
function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const max = scroller.scrollHeight - scroller.clientHeight;
    $('#progress').style.width = (max > 0 ? (scroller.scrollTop / max) * 100 : 0) + '%';
    if (!headings.length) return;
    const top = scroller.getBoundingClientRect().top + 90;
    let cur = null;
    for (const h of headings) {
      if (h.getBoundingClientRect().top <= top) cur = h; else break;
    }
    if (!cur && headings.length) cur = headings[0];
    if (scroller.scrollTop >= max - 2) cur = headings[headings.length - 1].getBoundingClientRect().top < scroller.getBoundingClientRect().bottom ? headings[headings.length - 1] : cur;
    for (const a of $$('a.active', tocEl)) a.classList.remove('active');
    if (cur) {
      const a = tocEl.querySelector(`a[data-id="${CSS.escape(cur.id)}"]`);
      if (a) {
        a.classList.add('active');
        const sb = $('#sidebar');
        const ar = a.getBoundingClientRect(), sr = sb.getBoundingClientRect();
        if (ar.top < sr.top + 30 || ar.bottom > sr.bottom - 30) sb.scrollTop += ar.top - sr.top - sr.height / 3;
      }
    }
  });
}
scroller.addEventListener('scroll', onScroll, { passive: true });

/* ── Links ───────────────────────────────────────────── */

docEl.addEventListener('click', (e) => {
  const svgA = e.target.closest('svg a');
  if (svgA) {
    e.preventDefault();
    const h = svgA.getAttribute('href') || svgA.getAttribute('xlink:href');
    if (h && /^(https?:|mailto:)/i.test(h)) send('link', { href: h });
    return;
  }
  const a = e.target.closest('a[href]');
  if (!a || e.target.closest('.copy-btn')) return;
  e.preventDefault();
  const raw = a.getAttribute('href');
  if (raw.startsWith('#')) {
    scrollToId(decodeURIComponent(raw.slice(1)), true);
    return;
  }
  const url = a.href;
  const [path, hash] = url.split('#');
  if (state.doc && path === state.doc.url && hash !== undefined) {
    scrollToId(decodeURIComponent(hash), true);
    return;
  }
  send('link', { href: url });
});

// Link preview in the corner, like a browser status bar
docEl.addEventListener('mouseover', (e) => {
  const a = e.target.closest('a[href]');
  const hint = $('#linkhint');
  if (!a || a.classList.contains('h-anchor')) { hint.hidden = true; return; }
  let u = a.href;
  if (u.startsWith(ORIGIN + '/doc/')) {
    try { u = decodeURIComponent(u.slice(ORIGIN.length + 5)).replace(/\//g, '\\'); } catch {}
  }
  hint.textContent = u;
  hint.hidden = false;
});
docEl.addEventListener('mouseout', (e) => {
  if (!e.relatedTarget || !e.relatedTarget.closest?.('a[href]')) $('#linkhint').hidden = true;
});

/* ── Find ────────────────────────────────────────────── */

const isMark = (c) => { const k = c.charCodeAt(0); return (k >= 0x0591 && k <= 0x05C7 && k !== 0x05BE && k !== 0x05C0 && k !== 0x05C3 && k !== 0x05C6) || (k >= 0x064B && k <= 0x065F); };
const fold = (c) => { const l = c.toLowerCase(); return l.length === c.length ? l : c; };
function normalize(s) {
  let out = '';
  const map = [];
  for (let i = 0; i < s.length; i++) {
    if (isMark(s[i])) continue;
    out += fold(s[i]);
    map.push(i);
  }
  return { out, map };
}

function clearFind() {
  for (const m of state.find.hits) {
    if (!m.isConnected) continue;
    m.replaceWith(document.createTextNode(m.textContent));
  }
  state.find.hits = [];
  state.find.idx = -1;
  docEl.normalize();
}

/** Search ignores case and Hebrew niqqud: "בראשית" finds "בְּרֵאשִׁית". */
function runFind(query, keepPos) {
  const prevIdx = state.find.idx;
  clearFind();
  state.find.query = query;
  const q = normalize(query).out;
  $('#findbar').classList.remove('nomatch');
  if (!q) { $('#find-count').textContent = ''; return; }
  const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('.copy-btn,.h-anchor,.katex,.mermaid-block,.graphviz-block') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const hits = [];
  for (const node of nodes) {
    const text = node.nodeValue;
    const { out, map } = normalize(text);
    const ranges = [];
    let from = 0, k;
    while ((k = out.indexOf(q, from)) !== -1) {
      let end = map[k + q.length - 1] + 1;
      while (end < text.length && isMark(text[end])) end++;
      ranges.push([map[k], end]);
      from = k + q.length;
    }
    for (let i = ranges.length - 1; i >= 0; i--) {
      const [s, e] = ranges[i];
      const mid = node.splitText(s);
      mid.splitText(e - s);
      const mark = document.createElement('mark');
      mark.className = 'find-hit';
      mid.replaceWith(mark);
      mark.appendChild(mid);
      hits.push({ mark, order: i });
    }
    // hits for this node were pushed in reverse; fix order
    const added = hits.splice(hits.length - ranges.length, ranges.length).reverse();
    hits.push(...added);
  }
  state.find.hits = hits.map((h) => h.mark);
  if (!state.find.hits.length) {
    $('#find-count').textContent = '0/0';
    $('#findbar').classList.add('nomatch');
    return;
  }
  gotoHit(keepPos && prevIdx >= 0 ? Math.min(prevIdx, state.find.hits.length - 1) : firstHitBelowTop(), !keepPos);
}

function firstHitBelowTop() {
  const top = scroller.getBoundingClientRect().top;
  const i = state.find.hits.findIndex((m) => m.getBoundingClientRect().top >= top);
  return i < 0 ? 0 : i;
}

function gotoHit(i, scroll = true) {
  const hits = state.find.hits;
  if (!hits.length) return;
  i = (i + hits.length) % hits.length;
  hits[state.find.idx]?.classList.remove('current');
  state.find.idx = i;
  const m = hits[i];
  m.classList.add('current');
  $('#find-count').textContent = `${i + 1}/${hits.length}`;
  if (scroll) {
    const r = m.getBoundingClientRect(), s = scroller.getBoundingClientRect();
    if (r.top < s.top + 40 || r.bottom > s.bottom - 40) scroller.scrollTop += r.top - s.top - s.height / 3;
  }
}

function openFind() {
  if (!state.doc) return;
  const fb = $('#findbar');
  fb.hidden = false;
  const input = $('#find-input');
  const sel = getSelection().toString().trim();
  if (sel && sel.length < 80 && !sel.includes('\n')) { input.value = sel; runFind(sel); }
  input.focus();
  input.select();
}
function closeFind() {
  $('#findbar').hidden = true;
  clearFind();
  $('#find-count').textContent = '';
}
let findT = 0;
$('#find-input').addEventListener('input', (e) => {
  clearTimeout(findT);
  findT = setTimeout(() => runFind(e.target.value), 120);
});
$('#find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (state.find.query !== e.target.value) runFind(e.target.value);
    else gotoHit(state.find.idx + (e.shiftKey ? -1 : 1));
  } else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('#find-next').onclick = () => gotoHit(state.find.idx + 1);
$('#find-prev').onclick = () => gotoHit(state.find.idx - 1);
$('#find-close').onclick = closeFind;

/* ── Welcome screen ──────────────────────────────────── */

function renderWelcome() {
  $('#card-install').hidden = state.installed || state.registered;
  $('#card-default').hidden = !(state.installed || state.registered) || state.isDefault || state.dismissedDefaultHint;
  const list = $('#recent');
  list.innerHTML = '';
  $('#recent-wrap').hidden = !state.recent.length;
  for (const r of state.recent) {
    const li = document.createElement('li');
    if (!r.exists) { li.classList.add('missing'); li.title = t('fileMissing'); }
    li.innerHTML = '<svg class="r-icon"><use href="#i-file"/></svg><div class="r-text"><span class="r-name"></span><span class="r-dir"></span></div><button class="tb sm r-x"><svg><use href="#i-x"/></svg></button>';
    $('.r-x', li).title = t('removeRecent');
    $('.r-name', li).textContent = r.name;
    $('.r-dir', li).textContent = r.dir;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.r-x')) {
        e.stopPropagation();
        state.recent = state.recent.filter((x) => x.path !== r.path);
        send('removeRecent', { path: r.path });
        renderWelcome();
        return;
      }
      send('openPath', { path: r.path, newWindow: e.ctrlKey });
    });
    list.appendChild(li);
  }
}

$('#wl-open').onclick = () => send('open');
$('#wl-guide').onclick = () => send('guide');
$('#btn-install').onclick = () => send('install');
$('#btn-default').onclick = () => send('defaultApps');
$('#btn-dismiss').onclick = () => { state.dismissedDefaultHint = true; send('dismissHint'); renderWelcome(); };
$('#btn-clear-recent').onclick = () => { state.recent = []; send('clearRecent'); renderWelcome(); };

/* ── Toolbar, popovers, menus ────────────────────────── */

$('#btn-toc').onclick = () => setUI({ toc: !state.ui.toc });
$('#btn-back').onclick = () => send('back');
$('#btn-fwd').onclick = () => send('forward');
$('#btn-open').onclick = () => send('open');
$('#btn-find').onclick = () => ($('#findbar').hidden ? openFind() : closeFind());
$('#btn-dir').onclick = cycleDirection;

function cycleDirection() {
  const order = ['auto', 'rtl', 'ltr'];
  const next = order[(order.indexOf(state.ui.direction) + 1) % order.length];
  setUI({ direction: next }, { redirection: true });
  MR.toast(t('dirToast')[next]);
}
function cycleTheme() {
  const order = ['system', 'light', 'sepia', 'dark'];
  const next = order[(order.indexOf(state.ui.theme) + 1) % order.length];
  setUI({ theme: next });
  MR.toast(t('themeToast')[next]);
}
function setSize(delta) {
  const size = delta === 0 ? 17 : Math.max(11, Math.min(34, state.ui.size + delta));
  setUI({ size });
}

function togglePop(id, btn) {
  const pop = $(id);
  const open = pop.hidden;
  closePops();
  if (open) {
    pop.hidden = false;
    btn.classList.add('on');
  }
}
function closePops() {
  for (const p of $$('.pop')) p.hidden = true;
  $('#btn-aa').classList.remove('on');
  $('#btn-more').classList.remove('on');
}
$('#btn-aa').onclick = (e) => { e.stopPropagation(); togglePop('#pop-aa', e.currentTarget); };
$('#btn-more').onclick = (e) => {
  e.stopPropagation();
  const noFile = !state.doc || !state.doc.path;
  for (const a of ['edit', 'reveal', 'openWith', 'copyPath', 'print', 'reload']) {
    $(`[data-act="${a}"]`).disabled = noFile && a !== 'print' ? true : !state.doc;
  }
  togglePop('#pop-more', e.currentTarget);
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('.pop')) closePops();
});
for (const seg of $$('.seg')) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setUI({ [seg.dataset.key]: b.dataset.v }, { redirection: seg.dataset.key === 'direction' });
  });
}
$('#size-down').onclick = () => setSize(-1);
$('#size-up').onclick = () => setSize(1);

$('#pop-more').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  closePops();
  action(b.dataset.act);
});

function action(act) {
  switch (act) {
    case 'print': if (state.doc) window.print(); break;
    case 'copyPath': if (state.doc?.path) copyText(state.doc.path).then(() => MR.toast(t('pathCopied'))); break;
    case 'shortcuts': showShortcuts(); break;
    case 'about': showAbout(); break;
    case 'checkUpdate':
      if (state.update?.version) updateModal(state.update);
      else send('checkUpdate');
      break;
    default: send(act);
  }
}

/* ── Modals ──────────────────────────────────────────── */

function modal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; }
$('#modal-close').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

function showShortcuts() {
  modal(`<h2>${t('shortcutsTitle')}</h2><table>` + t('shortcuts').map(([a, k]) => `<tr><td>${a}</td><td><kbd dir="ltr">${k}</kbd></td></tr>`).join('') + '</table>');
}
function showAbout() {
  modal(`<div class="about"><img src="${ORIGIN}/icon.png" alt=""><h2>Mad Reader ${state.version}</h2>
    <p>${t('about')}</p>
    <p dir="ltr">Rust · pulldown-cmark · syntect · KaTeX · Mermaid · Graphviz · WebView2</p>
    <p>MIT License</p>
    <div class="about-update"><button class="btn" data-u="check">${t('checkNow')}</button>
    <label><input type="checkbox" id="auto-update" ${state.autoUpdate ? 'checked' : ''}> ${t('autoCheck')}</label></div></div>`);
}

/* ── Keyboard ────────────────────────────────────────── */

document.addEventListener('keydown', (e) => {
  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  const inInput = e.target.matches?.('input, textarea');
  let handled = true;

  if (k === 'Escape') {
    if (!$('#modal').hidden) closeModal();
    else if ($$('.pop').some((p) => !p.hidden)) closePops();
    else if (!$('#findbar').hidden) closeFind();
    else handled = false;
  } else if (ctrl && !e.shiftKey && (k === 'o' || k === 'O')) send('open');
  else if (ctrl && (k === 'n' || k === 'N')) send('newWindow');
  else if (ctrl && (k === 'w' || k === 'W')) send('close');
  else if (ctrl && (k === 'f' || k === 'F')) openFind();
  else if (k === 'F3') { if ($('#findbar').hidden) openFind(); else gotoHit(state.find.idx + (e.shiftKey ? -1 : 1)); }
  else if (ctrl && (k === 'b' || k === 'B')) setUI({ toc: !state.ui.toc });
  else if (ctrl && (k === 'd' || k === 'D')) cycleDirection();
  else if (ctrl && (k === 't' || k === 'T')) cycleTheme();
  else if (ctrl && (k === '=' || k === '+')) setSize(1);
  else if (ctrl && (k === '-' || k === '_')) setSize(-1);
  else if (ctrl && k === '0') setSize(0);
  else if (ctrl && (k === 'p' || k === 'P')) { if (state.doc) window.print(); }
  else if (k === 'F5' || (ctrl && (k === 'r' || k === 'R'))) send('reload');
  else if (ctrl && e.shiftKey && (k === 'e' || k === 'E')) send('reveal');
  else if (ctrl && (k === 'e' || k === 'E')) send('edit');
  else if (ctrl && (k === 'h' || k === 'H')) send('home');
  else if (k === 'F11') send('fullscreen');
  else if (k === 'F1') showShortcuts();
  else if (e.altKey && k === 'ArrowLeft') send('back');
  else if (e.altKey && k === 'ArrowRight') send('forward');
  else if (k === 'BrowserBack') send('back');
  else if (k === 'BrowserForward') send('forward');
  else if (!inInput && !ctrl && k === 'Backspace') send('back');
  else if (!inInput && k === '?' ) showShortcuts();
  else if (ctrl && ['g', 'G', 'j', 'J', 'l', 'L', 's', 'S', 'u', 'U', 'k', 'K'].includes(k)) { /* swallow browser shortcuts */ }
  else handled = false;

  if (handled) { e.preventDefault(); e.stopPropagation(); }
}, true);

// Mouse back/forward buttons
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); send('back'); }
  if (e.button === 4) { e.preventDefault(); send('forward'); }
});

// Ctrl + wheel = text size
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setSize(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

applyUI();
send('ready');
