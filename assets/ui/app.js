// Mad Reader — reader UI logic.
// The Rust side renders Markdown and calls MR.load(payload); this file
// handles everything visual: direction detection (Hebrew / RTL), table of
// contents, find, appearance, menus, keyboard shortcuts.
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const send = (cmd, extra = {}) => window.ipc.postMessage(JSON.stringify({ cmd, ...extra }));

const DEFAULTS = { theme: 'system', font: 'sans', size: 17, leading: 'normal', width: 'normal', direction: 'auto', justify: 'off', toc: true };
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
  find: { hits: [], idx: -1, query: '' },
};

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
        if (t === 'CODE' || t === 'PRE' || t === 'KBD' || t === 'svg') continue;
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
  $('.sb-head').textContent = docDir === 'rtl' ? 'תוכן עניינים' : 'Contents';
  $('#dir-label').textContent = mode === 'auto' ? 'Auto' : mode.toUpperCase();
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
  if (dark !== lastDark) { lastDark = dark; send('theme', { dark }); }
}
darkMQ.addEventListener('change', () => applyUI());

let saveTimer = 0;
function setUI(patch, { redirection = false } = {}) {
  const anchor = topVisibleBlock();
  Object.assign(state.ui, patch);
  applyUI();
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
  applyUI();
  renderWelcome();
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
  const mins = Math.max(1, Math.round(p.words / 220));
  $('#doc-foot').textContent = `${p.words.toLocaleString()} words · ~${mins} min read`;

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
};

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
  MR.toast('Installed. Pick “Mad Reader” in the Settings window to make it the default.');
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
    a.title = 'Link to this section';
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
  for (const pre of $$('pre', docEl)) {
    const b = document.createElement('button');
    b.className = 'copy-btn';
    b.innerHTML = '<svg><use href="#i-copy"/></svg>Copy';
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const code = pre.querySelector('code') || pre;
      await copyText(code.innerText);
      b.classList.add('done');
      b.innerHTML = '<svg><use href="#i-check"/></svg>Copied';
      setTimeout(() => { b.classList.remove('done'); b.innerHTML = '<svg><use href="#i-copy"/></svg>Copy'; }, 1400);
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
    tocEl.innerHTML = '<div class="empty">No headings</div>';
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
    acceptNode: (n) => (n.parentElement.closest('.copy-btn,.h-anchor') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
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
    if (!r.exists) { li.classList.add('missing'); li.title = 'File not found'; }
    li.innerHTML = '<svg class="r-icon"><use href="#i-file"/></svg><div class="r-text"><span class="r-name"></span><span class="r-dir"></span></div><button class="tb sm r-x" title="Remove from list"><svg><use href="#i-x"/></svg></button>';
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
  MR.toast(next === 'auto' ? 'Direction: automatic per paragraph' : next === 'rtl' ? 'Direction: right-to-left (ימין לשמאל)' : 'Direction: left-to-right');
}
function cycleTheme() {
  const order = ['system', 'light', 'sepia', 'dark'];
  const next = order[(order.indexOf(state.ui.theme) + 1) % order.length];
  setUI({ theme: next });
  MR.toast('Theme: ' + (next === 'system' ? 'follow Windows' : next));
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
    case 'copyPath': if (state.doc?.path) copyText(state.doc.path).then(() => MR.toast('Path copied')); break;
    case 'shortcuts': showShortcuts(); break;
    case 'about': showAbout(); break;
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

const SHORTCUTS = [
  ['Open file', 'Ctrl O'], ['New window', 'Ctrl N'], ['Close window', 'Ctrl W'],
  ['Find in document', 'Ctrl F'], ['Next / previous match', 'F3 / Shift F3'],
  ['Table of contents', 'Ctrl B'], ['Text direction: Auto → RTL → LTR', 'Ctrl D'],
  ['Theme: Auto → Light → Sepia → Dark', 'Ctrl T'], ['Larger / smaller / reset text', 'Ctrl + / Ctrl − / Ctrl 0'],
  ['Back / forward', 'Alt ← / Alt →'], ['Reload', 'F5 / Ctrl R'], ['Print or save as PDF', 'Ctrl P'],
  ['Open in editor', 'Ctrl E'], ['Show in folder', 'Ctrl Shift E'], ['Full screen', 'F11'],
  ['Home', 'Ctrl H'], ['Top / bottom', 'Home / End'], ['This list', 'F1'],
];
function showShortcuts() {
  modal('<h2>Keyboard shortcuts</h2><table>' + SHORTCUTS.map(([a, k]) => `<tr><td>${a}</td><td><kbd>${k}</kbd></td></tr>`).join('') + '</table>');
}
function showAbout() {
  modal(`<div class="about"><img src="${ORIGIN}/icon.png" alt=""><h2>Mad Reader ${state.version}</h2>
    <p>A fast, good-looking Markdown reader for Windows.<br><span dir="rtl" lang="he">קורא Markdown מהיר ויפה, עם תמיכה מלאה בעברית.</span></p>
    <p>Built with Rust · pulldown-cmark · syntect · WebView2</p>
    <p>MIT License</p></div>`);
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
