// Mad Reader — export to Word (.docx), a standalone web page (.html) and PDF.
// Loaded on demand by app.js (it shares app.js's globals: $, $$, state, docEl,
// RTL_CH, ORIGIN, send). Everything is built from the rendered page, so text
// direction per paragraph, diagrams and equations match what's on screen.
// Rust only writes the result (and zips the .docx parts).
'use strict';

(() => {
  const X = window.MRX = {};

  /* ── shared helpers ───────────────────────────────────── */

  const xml = (s) => String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const isRtl = (el) => getComputedStyle(el).direction === 'rtl';
  /** CSS colour → RRGGBB (null for transparent). */
  const hex = (c) => {
    c = String(c).trim();
    if (/^#[0-9a-f]{6}$/i.test(c)) return c.slice(1).toUpperCase();
    if (/^#[0-9a-f]{3}$/i.test(c)) return c.slice(1).replace(/./g, (x) => x + x).toUpperCase();
    const m = c.match(/[\d.]+/g);
    if (!m || m.length < 3 || (m.length > 3 && +m[3] === 0)) return null;
    return m.slice(0, 3).map((x) => Math.round(+x).toString(16).padStart(2, '0')).join('').toUpperCase();
  };
  const blobToB64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  const loadImage = (src) => new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('image'));
    im.src = src;
  });
  /** Draw an image (or SVG) on a canvas → PNG blob. Throws for cross-origin images. */
  async function rasterize(src, w, h, scale) {
    const im = typeof src === 'string' ? await loadImage(src) : src;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0, c.width, c.height);
    return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas'))), 'image/png'));
  }
  /** A rendered diagram (inline SVG) → PNG blob at its on-screen size. */
  function svgToPng(svg, scale = 2) {
    const r = svg.getBoundingClientRect();
    const clone = svg.cloneNode(true);
    clone.setAttribute('width', r.width);
    clone.setAttribute('height', r.height);
    clone.style.maxWidth = 'none';
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    return rasterize(src, r.width, r.height, scale).then((blob) => ({ blob, w: r.width, h: r.height }));
  }

  // Word needs each run marked right-to-left or not. Letters decide for
  // themselves; spaces, punctuation and digits take the direction of the
  // letters around them, or the paragraph's when those disagree (as the
  // Unicode bidi algorithm does in the browser).
  const SEG = new RegExp(`[${RTL_CH}]+|[${LTR_CH}]+|[^${RTL_CH}${LTR_CH}]+`, 'g');
  const R_CH = new RegExp(`[${RTL_CH}]`), L_CH = new RegExp(`[${LTR_CH}]`);
  const TOKEN = /\u0001(\d+)\u0002/g;

  X.run = async (job) => {
    const title = state.doc.title || state.doc.name.replace(/\.[^.]+$/, '');
    if (job.format === 'pdf') {
      return new Promise((resolve) => { X.waiting = resolve; send('exportPdf', { id: job.id }); });
    }
    const files = job.format === 'docx' ? await buildDocx(job, title) : [{ name: 'index.html', text: await buildHtml(job, title) }];
    send('exportFiles', { id: job.id, files });
  };

  /* ── Word (.docx) ─────────────────────────────────────── */

  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const BLOCK = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'TABLE', 'HR', 'DIV', 'DL', 'DT', 'DD',
    'DETAILS', 'SUMMARY', 'FIGURE', 'FIGCAPTION', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'VIDEO', 'AUDIO', 'PICTURE']);
  const isBlock = (n) => n.nodeType === 1 && BLOCK.has(n.tagName) && !(n.tagName === 'PICTURE');
  const PX = 15; // twips per CSS pixel
  /** <p>$$ … $$</p>: an equation on its own line. */
  const onlyDisplayMath = (p) => p.querySelector(':scope > .math-display') &&
    Array.from(p.childNodes).every((n) => (n.nodeType === 1 ? n.classList.contains('math-display') : !n.nodeValue.trim()));
  const EMU = 9525; // EMU per CSS pixel

  class Docx {
    constructor(job) {
      this.letter = job.paper === 'letter';
      this.pageW = this.letter ? 12240 : 11906;
      this.pageH = this.letter ? 15840 : 16838;
      this.contentTw = this.pageW - 2 * 1440;
      this.contentPx = Math.floor(this.contentTw / PX);
      this.rels = [];
      this.media = [];
      this.images = new Map(); // element → { rid, w, h }
      this.nums = []; // ordered-list instances
      this.bookmarks = new Map(); // element id → bookmark name
      this.bmSeq = 0;
      this.drawSeq = 0;
      this.pieces = [];
    }

    rel(type, target, external) {
      const id = 'rId' + (this.rels.length + 10);
      this.rels.push({ id, type, target, external });
      return id;
    }

    async addMedia(el, blob, ext, w, h) {
      // name it before awaiting: pictures are added in parallel
      const name = `image${this.media.length + 1}.${ext}`;
      const part = { name: 'word/media/' + name, b64: '' };
      this.media.push(part);
      this.images.set(el, { rid: this.rel('image', 'media/' + name), w, h });
      part.b64 = await blobToB64(blob);
    }

    /** Images and rendered diagrams are fetched / rasterized up front. */
    async prepare(root) {
      const jobs = [];
      for (const img of $$('img', root)) jobs.push(this.prepImg(img).catch(() => {}));
      for (const b of $$('.mermaid-block.rendered, .graphviz-block.rendered', root)) {
        const svg = b.querySelector('svg');
        if (svg) jobs.push(svgToPng(svg).then(({ blob, w, h }) => this.addMedia(b, blob, 'png', ...this.fit(w, h))).catch(() => {}));
      }
      await Promise.all(jobs);
      let n = 0;
      for (const el of $$('[id]', root)) this.bookmarks.set(el.id, `_mr${++n}`);
      for (const a of $$('a[name]', root)) if (!this.bookmarks.has(a.name)) this.bookmarks.set(a.name, `_mr${++n}`);
    }

    fit(w, h) {
      const max = this.contentPx;
      return w > max ? [max, h * max / w] : [w, h];
    }

    async prepImg(img) {
      await img.decode().catch(() => {});
      const nw = img.naturalWidth, nh = img.naturalHeight;
      if (!nw || !nh) return;
      const src = img.currentSrc || img.src;
      let blob = null, ext = 'png';
      const kind = /\.(png|jpe?g|gif)(?:[?#]|$)/i.exec(src.split('#')[0]);
      if (src.startsWith(ORIGIN) && kind) {
        const r = await fetch(src);
        if (r.ok) { blob = await r.blob(); ext = kind[1].toLowerCase().replace('jpg', 'jpeg'); }
      }
      if (!blob) blob = await rasterize(img, nw, nh, 1); // SVG, WebP, data: … (throws for cross-origin)
      const sized = img.hasAttribute('width') || img.hasAttribute('height') || img.style.width;
      const shown = img.getBoundingClientRect();
      const w = sized && shown.width ? shown.width : nw;
      await this.addMedia(img, blob, ext, ...this.fit(w, w * nh / nw));
    }

    /* paragraphs */

    para(runs, o = {}, ctx = {}) {
      let p = '';
      const style = o.style || (ctx.quote ? 'Quote' : ctx.cell ? 'TableText' : null);
      if (style) p += `<w:pStyle w:val="${style}"/>`;
      if (o.keepNext) p += '<w:keepNext/>';
      if (o.num) p += `<w:numPr><w:ilvl w:val="${o.num.lvl}"/><w:numId w:val="${o.num.id}"/></w:numPr>`;
      if (o.hr) p += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D0D7DE"/></w:pBdr>';
      else if (ctx.quote) p += `<w:pBdr><w:${o.rtl ? 'right' : 'left'} w:val="single" w:sz="${ctx.alert ? 24 : 18}" w:space="10" w:color="${ctx.alert || 'D0D7DE'}"/></w:pBdr>`;
      if (o.rtl) p += '<w:bidi/>';
      if (o.after != null) p += `<w:spacing w:after="${o.after}"/>`;
      const left = (o.ind || 0) + (ctx.indent || 0) + (ctx.quote ? 300 * ctx.quote : 0);
      if (left && !(o.num && !ctx.indent && !ctx.quote)) {
        p += o.num ? `<w:ind w:left="${left + 360 * (o.num.lvl + 2)}" w:hanging="360"/>` : `<w:ind w:left="${left}"/>`;
      }
      if (o.jc) p += `<w:jc w:val="${o.jc}"/>`;
      const bm = o.bookmark ? this.bookmarks.get(o.bookmark) : null;
      const id = bm ? ++this.bmSeq : 0;
      runs = this.resolve(runs, !!o.rtl);
      return `<w:p>${p ? `<w:pPr>${p}</w:pPr>` : ''}${bm ? `<w:bookmarkStart w:id="${id}" w:name="${bm}"/>` : ''}${runs}${bm ? `<w:bookmarkEnd w:id="${id}"/>` : ''}</w:p>`;
    }

    jc(el) {
      const a = getComputedStyle(el).textAlign;
      return a === 'center' ? 'center' : a === 'justify' ? 'both' : null;
    }

    /* inline content */

    inline(nodes, f = {}) {
      this.space = true;
      let out = '';
      for (const n of nodes) out += this.inl(n, f);
      return out;
    }

    inl(n, f) {
      if (n.nodeType === 3) {
        let t = n.nodeValue.replace(/[\t\n\r ]+/g, ' ');
        if (this.space && t.startsWith(' ')) t = t.slice(1);
        if (!t) return '';
        this.space = t.endsWith(' ');
        return this.text(t, f);
      }
      if (n.nodeType !== 1) return '';
      const el = n;
      const tag = el.tagName;
      const cls = el.classList;
      if (cls.contains('h-anchor') || cls.contains('copy-btn') || tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') return '';
      if (cls.contains('math') || cls.contains('katex')) return this.math(el, false);
      const kids = (g) => Array.from(el.childNodes).map((c) => this.inl(c, g)).join('');
      switch (tag) {
        case 'BR': this.space = true; return '<w:r><w:br/></w:r>';
        case 'IMG': return this.image(el);
        case 'INPUT': return el.type === 'checkbox' ? this.text(el.checked ? '☒ ' : '☐ ', f) : '';
        case 'A': return this.link(el, f, kids);
        case 'STRONG': case 'B': return kids({ ...f, b: 1 });
        case 'EM': case 'I': case 'CITE': case 'DFN': case 'VAR': return kids({ ...f, i: 1 });
        case 'DEL': case 'S': case 'STRIKE': return kids({ ...f, s: 1 });
        case 'U': case 'INS': return kids({ ...f, u: 1 });
        case 'CODE': case 'KBD': case 'SAMP': case 'TT': this.space = false; return kids({ ...f, code: 1 });
        case 'SUP': return kids({ ...f, va: 'superscript' });
        case 'SUB': return kids({ ...f, va: 'subscript' });
        case 'MARK': return cls.contains('find-hit') ? kids(f) : kids({ ...f, mark: 1 });
        case 'SMALL': return kids({ ...f, sz: 18 });
        case 'svg': case 'VIDEO': case 'AUDIO': case 'IFRAME': return '';
        default: return kids(f);
      }
    }

    /** Text becomes a placeholder; para() turns it into runs once the whole
     *  paragraph is known (see resolve). */
    text(t, f) {
      this.pieces.push({ t, f });
      return `\u0001${this.pieces.length - 1}\u0002`;
    }

    resolve(runs, rtlPara) {
      const ids = Array.from(runs.matchAll(TOKEN), (m) => +m[1]);
      if (!ids.length) return runs;
      const segs = [];
      for (const id of ids) {
        for (const m of this.pieces[id].t.matchAll(SEG)) {
          segs.push({ id, t: m[0], d: R_CH.test(m[0][0]) ? 'R' : L_CH.test(m[0][0]) ? 'L' : null, strong: true });
        }
      }
      const base = rtlPara ? 'R' : 'L';
      for (let i = 0; i < segs.length; i++) {
        if (segs[i].d) continue;
        let a = base, z = base;
        for (let k = i - 1; k >= 0; k--) if (segs[k].strong && segs[k].d) { a = segs[k].d; break; }
        for (let k = i + 1; k < segs.length; k++) if (segs[k].d && segs[k].strong) { z = segs[k].d; break; }
        segs[i].d = a === z ? a : base;
        segs[i].strong = false;
      }
      const xmlOf = new Map();
      for (const id of ids) {
        const f = this.pieces[id].f;
        let out = '', cur = null, buf = '';
        const emit = () => { if (buf) out += `<w:r>${this.rPr(f, cur === 'R')}<w:t xml:space="preserve">${xml(buf)}</w:t></w:r>`; buf = ''; };
        for (const sg of segs) {
          if (sg.id !== id) continue;
          if (sg.d !== cur) { emit(); cur = sg.d; }
          buf += sg.t;
        }
        emit();
        xmlOf.set(id, out);
      }
      return runs.replace(TOKEN, (_, id) => xmlOf.get(+id) || '');
    }

    rPr(f, rtl) {
      let p = '';
      if (f.link) p += '<w:rStyle w:val="Hyperlink"/>';
      else if (f.code) p += '<w:rStyle w:val="CodeChar"/>';
      if (f.b) p += '<w:b/><w:bCs/>';
      if (f.i) p += '<w:i/><w:iCs/>';
      if (f.s) p += '<w:strike/>';
      if (f.color) p += `<w:color w:val="${f.color}"/>`;
      if (f.sz) p += `<w:sz w:val="${f.sz}"/><w:szCs w:val="${f.sz}"/>`;
      if (f.mark) p += '<w:highlight w:val="yellow"/>';
      if (f.u) p += '<w:u w:val="single"/>';
      if (f.va) p += `<w:vertAlign w:val="${f.va}"/>`;
      if (rtl) p += '<w:rtl/>';
      return p ? `<w:rPr>${p}</w:rPr>` : '';
    }

    link(a, f, kids) {
      const raw = a.getAttribute('href') || '';
      const inner = kids({ ...f, link: 1 });
      let target = null;
      if (raw.startsWith('#')) {
        let id = raw.slice(1);
        try { id = decodeURIComponent(id); } catch {}
        const bm = this.bookmarks.get(id);
        return bm ? `<w:hyperlink w:anchor="${bm}" w:history="1">${inner}</w:hyperlink>` : inner;
      }
      const url = a.href;
      if (url.startsWith(ORIGIN + '/doc/')) target = 'file:///' + url.slice(ORIGIN.length + 5);
      else if (/^(https?:|mailto:|file:)/i.test(url)) target = url;
      if (!target) return inner;
      return `<w:hyperlink r:id="${this.rel('hyperlink', target, true)}" w:history="1">${inner}</w:hyperlink>`;
    }

    image(el) {
      const im = this.images.get(el);
      if (!im) {
        const alt = el.getAttribute('alt');
        return alt ? this.text(`[${alt}]`, { i: 1 }) : '';
      }
      this.space = false;
      const cx = Math.round(im.w * EMU), cy = Math.round(im.h * EMU);
      const n = ++this.drawSeq;
      const descr = xml(el.getAttribute?.('alt') || '');
      return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}" descr="${descr}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="Picture ${n}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${im.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    }

    /* blocks */

    blocks(parent, ctx) {
      let out = '';
      let buf = [];
      const flush = () => {
        if (buf.some((n) => n.nodeType === 1 || n.nodeValue.trim())) {
          out += this.para(this.inline(buf, ctx.f || {}), { rtl: isRtl(parent), jc: this.jc(parent) }, ctx);
        }
        buf = [];
      };
      for (const n of parent.childNodes) {
        if (isBlock(n)) { flush(); out += this.block(n, ctx); } else buf.push(n);
      }
      flush();
      return out;
    }

    block(el, ctx) {
      const tag = el.tagName;
      const cls = el.classList;
      const rtl = isRtl(el);
      const f = ctx.f || {};
      switch (tag) {
        case 'P':
          if (cls.contains('math-block') || onlyDisplayMath(el)) return this.displayMath(el, ctx);
          return this.para(this.inline(el.childNodes, f), { rtl, jc: this.jc(el) }, ctx);
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
          return this.para(this.inline(el.childNodes, f), { style: 'Heading' + tag[1], rtl, jc: this.jc(el), bookmark: el.id }, ctx);
        case 'PRE': return this.code(el, ctx);
        case 'UL': case 'OL': return this.list(el, ctx, -1);
        case 'BLOCKQUOTE': return this.quote(el, ctx);
        case 'TABLE': return this.table(el, ctx);
        case 'HR': return this.para('', { hr: true }, ctx);
        case 'DT': return this.para(this.inline(el.childNodes, { ...f, b: 1 }), { rtl, keepNext: true, after: 40 }, ctx);
        case 'DD': return this.blocks(el, { ...ctx, indent: (ctx.indent || 0) + 480 });
        case 'SUMMARY': return this.para(this.inline(el.childNodes, { ...f, b: 1 }), { rtl }, ctx);
        case 'FIGCAPTION': return this.para(this.inline(el.childNodes, f), { style: 'Caption', rtl }, ctx);
        case 'VIDEO': case 'AUDIO': return '';
        case 'DIV':
          if (cls.contains('mermaid-block') || cls.contains('graphviz-block')) {
            if (this.images.has(el)) { this.space = false; return this.para(this.image(el), { jc: 'center' }, ctx); }
            const pre = el.querySelector('pre');
            return pre ? this.code(pre, ctx) : '';
          }
          if (cls.contains('footnote-definition')) return this.footnote(el, ctx);
          return this.blocks(el, ctx);
        default: return this.blocks(el, ctx);
      }
    }

    code(pre, ctx) {
      const code = pre.querySelector('code') || pre;
      const lines = [[]];
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType === 3) {
            const st = getComputedStyle(c.parentElement);
            const fmt = { color: hex(st.color), b: +st.fontWeight >= 600, i: st.fontStyle === 'italic' };
            c.nodeValue.replace(/\t/g, '    ').split('\n').forEach((part, i) => {
              if (i) lines.push([]);
              if (part) lines[lines.length - 1].push([part, fmt]);
            });
          } else if (c.nodeType === 1 && !c.classList.contains('copy-btn')) walk(c);
        }
      };
      walk(code);
      if (lines.length > 1 && !lines[lines.length - 1].length) lines.pop();
      return lines.map((segs, i) => {
        const runs = segs.map(([t, fmt]) => {
          let p = '';
          if (fmt.b) p += '<w:b/>';
          if (fmt.i) p += '<w:i/>';
          if (fmt.color) p += `<w:color w:val="${fmt.color}"/>`;
          return `<w:r>${p ? `<w:rPr>${p}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;
        }).join('');
        return this.para(runs, { style: 'Code', after: i === lines.length - 1 ? 200 : null }, { ...ctx, quote: 0, cell: false, indent: (ctx.indent || 0) + (ctx.quote ? 300 * ctx.quote : 0) });
      }).join('');
    }

    list(el, ctx, parentLvl) {
      const lvl = Math.min(8, parentLvl + 1);
      let numId = 1;
      if (el.tagName === 'OL') {
        numId = this.nums.length + 2;
        this.nums.push({ id: numId, lvl, start: +(el.getAttribute('start') || 1) || 1 });
      }
      let out = '';
      for (const li of el.children) {
        if (li.tagName !== 'LI') continue;
        const rtl = isRtl(li);
        const task = li.classList.contains('task');
        let first = true;
        let buf = [];
        const lead = () => (task ? { rtl, ind: 360 * (lvl + 1) } : { rtl, num: { id: numId, lvl } });
        const flush = () => {
          if (!buf.some((n) => n.nodeType === 1 || n.nodeValue.trim())) { buf = []; return; }
          out += this.para(this.inline(buf, ctx.f || {}), first ? lead() : { rtl, ind: 360 * (lvl + 2) }, ctx);
          first = false;
          buf = [];
        };
        for (const n of li.childNodes) {
          if (!isBlock(n)) { buf.push(n); continue; }
          if (n.tagName === 'P' && first) { buf.push(...n.childNodes); flush(); continue; }
          flush();
          if (first) { out += this.para('', lead(), ctx); first = false; }
          if (n.tagName === 'UL' || n.tagName === 'OL') out += this.list(n, ctx, lvl);
          else out += this.block(n, { ...ctx, indent: (ctx.indent || 0) + 360 * (lvl + 2) });
        }
        flush();
        if (first) out += this.para('', lead(), ctx);
      }
      return out;
    }

    quote(el, ctx) {
      const m = /markdown-alert-(\w+)/.exec(el.className);
      const inner = { ...ctx, quote: (ctx.quote || 0) + 1 };
      let out = '';
      if (m) {
        inner.alert = hex(getComputedStyle(el).getPropertyValue('--alert').trim() || '#3b82f6') || '3B82F6';
        let label = getComputedStyle(el, '::before').content;
        label = label && label !== 'none' ? label.replace(/^"|"$/g, '').replace(/\\"/g, '"') : m[1];
        out += this.para(this.text(label, { b: 1, color: inner.alert }), { rtl: isRtl(el), keepNext: true, after: 60 }, inner);
      } else {
        inner.f = { ...(ctx.f || {}), color: '59636E' };
      }
      return out + this.blocks(el, inner);
    }

    footnote(el, ctx) {
      const label = el.querySelector('.footnote-definition-label');
      const ps = Array.from(el.children).filter((c) => c !== label);
      const f = { ...(ctx.f || {}), sz: 18, color: '59636E' };
      let out = '';
      ps.forEach((p, i) => {
        let runs = this.inline(p.tagName === 'P' ? p.childNodes : [p], f);
        if (i === 0 && label) runs = this.text(label.textContent.trim() + '. ', { ...f, b: 1 }) + runs;
        out += this.para(runs, { rtl: isRtl(p), bookmark: i === 0 ? el.id : null, after: 60 }, ctx);
      });
      return out;
    }

    table(tbl, ctx) {
      const rows = Array.from(tbl.rows);
      if (!rows.length) return '';
      const span = (c) => Math.max(1, +c.colSpan || 1);
      const ncol = Math.max(...rows.map((r) => Array.from(r.cells).reduce((a, c) => a + span(c), 0)));
      // column widths from the widest row as laid out on screen
      const widths = new Array(ncol).fill(0);
      for (const r of rows) {
        let i = 0;
        for (const c of r.cells) {
          const w = c.getBoundingClientRect().width / span(c);
          for (let k = 0; k < span(c); k++, i++) widths[i] = Math.max(widths[i], w);
        }
      }
      let tw = widths.map((w) => Math.max(400, w * PX));
      const avail = this.contentTw - (ctx.indent || 0);
      const sum = tw.reduce((a, b) => a + b, 0);
      if (sum > avail) tw = tw.map((w) => Math.floor(w * avail / sum));
      tw = tw.map(Math.round);
      const rtl = isRtl(tbl);
      let out = `<w:tbl><w:tblPr><w:tblStyle w:val="MRTable"/>${rtl ? '<w:bidiVisual/>' : ''}<w:tblW w:w="${tw.reduce((a, b) => a + b, 0)}" w:type="dxa"/>${ctx.indent ? `<w:tblInd w:w="${ctx.indent}" w:type="dxa"/>` : ''}<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>`;
      out += '<w:tblGrid>' + tw.map((w) => `<w:gridCol w:w="${w}"/>`).join('') + '</w:tblGrid>';
      for (const r of rows) {
        const head = r.parentElement.tagName === 'THEAD' || Array.from(r.cells).every((c) => c.tagName === 'TH');
        out += `<w:tr>${head ? '<w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>'}`;
        let i = 0;
        for (const c of r.cells) {
          const s = span(c);
          const w = tw.slice(i, i + s).reduce((a, b) => a + b, 0);
          i += s;
          const th = c.tagName === 'TH';
          let body = this.blocks(c, { ...ctx, indent: 0, quote: 0, cell: true, f: th ? { ...(ctx.f || {}), b: 1 } : ctx.f });
          if (!body) body = this.para('', { rtl: isRtl(c) }, { cell: true });
          out += `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${s > 1 ? `<w:gridSpan w:val="${s}"/>` : ''}${th ? '<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>' : ''}</w:tcPr>${body}</w:tc>`;
        }
        for (; i < ncol; i++) out += `<w:tc><w:tcPr><w:tcW w:w="${tw[i]}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`;
        out += '</w:tr>';
      }
      // Word needs a paragraph between two tables (and after a table in a cell)
      return out + '</w:tbl>' + this.para('', { after: 0 }, {});
    }

    /* math: KaTeX's MathML → Office Math (OMML), editable in Word */

    math(el, display) {
      const mm = el.querySelector('.katex-mathml math') || (el.localName === 'math' ? el : null);
      if (!mm) return this.text(el.dataset.tex || el.textContent, { code: 1 });
      this.space = false;
      const sem = mm.querySelector('semantics');
      const body = this.mm(sem ? sem.firstElementChild : mm);
      return display ? `<m:oMathPara><m:oMath>${body}</m:oMath></m:oMathPara>` : `<m:oMath>${body}</m:oMath>`;
    }

    displayMath(p, ctx) {
      let out = '';
      for (const el of $$('.math', p)) out += this.para(this.math(el, true), { jc: 'center' }, ctx);
      return out || this.para(this.inline(p.childNodes, ctx.f || {}), {}, ctx);
    }

    mr(text, el) {
      const v = el?.getAttribute('mathvariant');
      let p = '';
      if (v === 'double-struck') p += '<m:scr m:val="double-struck"/>';
      else if (v === 'fraktur' || v === 'bold-fraktur') p += '<m:scr m:val="fraktur"/>';
      else if (v === 'script' || v === 'bold-script') p += '<m:scr m:val="script"/>';
      const tag = el?.localName;
      const plain = tag !== 'mi' || v === 'normal' || [...text].length > 1;
      const sty = v === 'bold' ? 'b' : v === 'bold-italic' ? 'bi' : plain || p ? 'p' : null;
      if (sty) p += `<m:sty m:val="${sty}"/>`;
      if (tag === 'mtext') p = '<m:nor/>';
      return `<m:r>${p ? `<m:rPr>${p}</m:rPr>` : ''}<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr><m:t xml:space="preserve">${xml(text)}</m:t></m:r>`;
    }

    mseq(children) {
      const kids = Array.from(children);
      // \left( … \right) → a growing delimiter
      if (kids.length >= 2) {
        const a = kids[0], z = kids[kids.length - 1];
        if (a.localName === 'mo' && z.localName === 'mo' && a.getAttribute('fence') === 'true' && z.getAttribute('fence') === 'true') {
          const chr = (c) => xml(c.textContent.trim());
          return `<m:d><m:dPr><m:begChr m:val="${chr(a)}"/><m:endChr m:val="${chr(z)}"/></m:dPr><m:e>${this.mseq(kids.slice(1, -1))}</m:e></m:d>`;
        }
      }
      let out = '';
      for (let i = 0; i < kids.length; i++) {
        const nary = this.nary(kids[i]);
        if (nary) out += nary(kids[i + 1] ? this.mm(kids[++i]) : '');
        else out += this.mm(kids[i]);
      }
      return out;
    }

    /** ∑ ∫ ∏ … with limits: the next element is their operand. */
    nary(el) {
      const NARY = '∑∏∐∫∬∭∮∯∰⋀⋁⋂⋃⨀⨁⨂⨄⨆';
      const kind = el.localName;
      if (!['munderover', 'msubsup', 'munder', 'mover', 'msub', 'msup'].includes(kind)) return null;
      const [base, a, b] = el.children;
      const ch = base?.localName === 'mo' ? base.textContent.trim() : '';
      if (ch.length !== 1 || !NARY.includes(ch)) return null;
      const under = kind === 'munderover' || kind === 'munder' || kind === 'msubsup' || kind === 'msub' ? a : null;
      const over = kind === 'munderover' || kind === 'msubsup' ? b : kind === 'mover' || kind === 'msup' ? a : null;
      const loc = kind.startsWith('mu') || kind === 'mover' ? 'undOvr' : 'subSup';
      const pr = `<m:chr m:val="${ch}"/><m:limLoc m:val="${loc}"/>${under ? '' : '<m:subHide m:val="1"/>'}${over ? '' : '<m:supHide m:val="1"/>'}`;
      return (e) => `<m:nary><m:naryPr>${pr}</m:naryPr><m:sub>${under ? this.mm(under) : ''}</m:sub><m:sup>${over ? this.mm(over) : ''}</m:sup><m:e>${e}</m:e></m:nary>`;
    }

    mm(el) {
      if (!el) return '';
      const c = el.children;
      const arg = (i) => this.mm(c[i]);
      const ACC = { '^': '̂', 'ˆ': '̂', '~': '̃', '˜': '̃', '˙': '̇', '¨': '̈', '→': '⃗', 'ˇ': '̌', '˘': '̆', '´': '́', '`': '̀', '˚': '̊' };
      switch (el.localName) {
        case 'mi': case 'mn': case 'mo': case 'mtext': case 'ms': {
          const tx = el.textContent;
          return tx ? this.mr(tx, el) : '';
        }
        case 'mspace': return parseFloat(el.getAttribute('width') || '0') >= 0.2 ? this.mr(' ', null) : '';
        case 'annotation': case 'annotation-xml': case 'mphantom': case 'none': return '';
        case 'semantics': return arg(0);
        case 'msup': return `<m:sSup><m:e>${arg(0)}</m:e><m:sup>${arg(1)}</m:sup></m:sSup>`;
        case 'msub': return `<m:sSub><m:e>${arg(0)}</m:e><m:sub>${arg(1)}</m:sub></m:sSub>`;
        case 'msubsup': return `<m:sSubSup><m:e>${arg(0)}</m:e><m:sub>${arg(1)}</m:sub><m:sup>${arg(2)}</m:sup></m:sSubSup>`;
        case 'mfrac': {
          const lt = el.getAttribute('linethickness');
          const noBar = lt != null && parseFloat(lt) === 0;
          return `<m:f>${noBar ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : ''}<m:num>${arg(0)}</m:num><m:den>${arg(1)}</m:den></m:f>`;
        }
        case 'msqrt': return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${this.mseq(c)}</m:e></m:rad>`;
        case 'mroot': return `<m:rad><m:deg>${arg(1)}</m:deg><m:e>${arg(0)}</m:e></m:rad>`;
        case 'mover': case 'munder': {
          const top = el.localName === 'mover';
          const mark = c[1]?.localName === 'mo' ? c[1].textContent.trim() : '';
          const accent = el.getAttribute(top ? 'accent' : 'accentunder') === 'true';
          if (accent && (mark === '‾' || mark === '¯' || mark === '_' || mark === '―')) {
            return `<m:bar><m:barPr><m:pos m:val="${top ? 'top' : 'bot'}"/></m:barPr><m:e>${arg(0)}</m:e></m:bar>`;
          }
          if (top && accent && mark) return `<m:acc><m:accPr><m:chr m:val="${xml(ACC[mark] || mark)}"/></m:accPr><m:e>${arg(0)}</m:e></m:acc>`;
          const tagName = top ? 'limUpp' : 'limLow';
          return `<m:${tagName}><m:e>${arg(0)}</m:e><m:lim>${arg(1)}</m:lim></m:${tagName}>`;
        }
        case 'munderover': return `<m:limUpp><m:e><m:limLow><m:e>${arg(0)}</m:e><m:lim>${arg(1)}</m:lim></m:limLow></m:e><m:lim>${arg(2)}</m:lim></m:limUpp>`;
        case 'mtable': {
          const rows = Array.from(c).filter((r) => r.localName === 'mtr' || r.localName === 'mlabeledtr');
          const n = Math.max(1, ...rows.map((r) => r.children.length));
          return `<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="${n}"/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs></m:mPr>` +
            rows.map((r) => '<m:mr>' + Array.from({ length: n }, (_, i) => `<m:e>${r.children[i] ? this.mseq(r.children[i].children) : ''}</m:e>`).join('') + '</m:mr>').join('') + '</m:m>';
        }
        default: return this.mseq(c); // math, mrow, mstyle, mpadded, menclose, merror, …
      }
    }

    /* package */

    async build(job, title) {
      await this.prepare(docEl);
      const body = this.blocks(docEl, {});
      const rtl = isRtl(docEl);
      const sect = `<w:sectPr><w:footerReference w:type="default" r:id="rId4"/><w:pgSz w:w="${this.pageW}" w:h="${this.pageH}"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>${rtl ? '<w:bidi/>' : ''}</w:sectPr>`;
      const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS} xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}${sect}</w:body></w:document>`;
      const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL}styles" Target="styles.xml"/><Relationship Id="rId2" Type="${REL}numbering" Target="numbering.xml"/>` +
        `<Relationship Id="rId3" Type="${REL}settings" Target="settings.xml"/><Relationship Id="rId4" Type="${REL}footer" Target="footer1.xml"/>` +
        this.rels.map((r) => `<Relationship Id="${r.id}" Type="${REL}${r.type}" Target="${xml(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('') +
        '</Relationships>';
      const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      return [
        { name: '[Content_Types].xml', text: CONTENT_TYPES },
        { name: '_rels/.rels', text: ROOT_RELS },
        { name: 'docProps/core.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
        { name: 'docProps/app.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${xml(job.generator)}</Application></Properties>` },
        { name: 'word/document.xml', text: doc },
        { name: 'word/_rels/document.xml.rels', text: rels },
        { name: 'word/styles.xml', text: styles(state.ui.font === 'serif') },
        { name: 'word/numbering.xml', text: numbering(this.nums) },
        { name: 'word/settings.xml', text: SETTINGS },
        { name: 'word/footer1.xml', text: FOOTER },
        ...this.media,
      ];
    }
  }

  async function buildDocx(job, title) {
    return new Docx(job).build(job, title);
  }

  const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

  const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

  const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings ${NS}><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat><w:themeFontLang w:val="en-US" w:bidi="he-IL"/></w:settings>`;

  const FOOTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr ${NS}><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:fldSimple w:instr=" PAGE "><w:r><w:rPr><w:color w:val="8C959F"/><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;

  function styles(serif) {
    const fonts = serif
      ? '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:eastAsia="Georgia" w:cs="David"/>'
      : '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Arial"/>';
    const heading = (n, sz, before, border) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/>${border ? '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="D8DEE4"/></w:pBdr>' : ''}<w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="${n === 6 ? '59636E' : '0B0D12'}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr>${fonts}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="he-IL"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="1F2328"/></w:rPr></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>
${heading(1, 40, 240, true)}${heading(2, 32, 360, true)}${heading(3, 28, 280, false)}${heading(4, 24, 240, false)}${heading(5, 22, 240, false)}${heading(6, 22, 240, false)}
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="E1E4E8"/><w:left w:val="single" w:sz="4" w:space="4" w:color="E1E4E8"/><w:bottom w:val="single" w:sz="4" w:space="4" w:color="E1E4E8"/><w:right w:val="single" w:sz="4" w:space="4" w:color="E1E4E8"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="100" w:right="100"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Courier New"/><w:noProof/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="character" w:customStyle="1" w:styleId="CodeChar"><w:name w:val="Inline Code"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Courier New"/><w:noProof/><w:color w:val="1F2328"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="EFF1F3"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="35"/><w:qFormat/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="59636E"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0969DA"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:customStyle="1" w:styleId="MRTable"><w:name w:val="Mad Reader Table"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="59"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/></w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="115" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="115" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;
  }

  function numbering(nums) {
    const BUL = ['•', '◦', '▪'];
    const lvl = (i, bullet) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${bullet ? 'bullet' : 'decimal'}"/><w:lvlText w:val="${bullet ? BUL[i % 3] : `%${i + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${360 * (i + 2)}" w:hanging="360"/></w:pPr>${bullet ? '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:hint="default"/></w:rPr>' : ''}</w:lvl>`;
    const abs = (id, bullet) => `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${Array.from({ length: 9 }, (_, i) => lvl(i, bullet)).join('')}</w:abstractNum>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${NS}>${abs(0, true)}${abs(1, false)}<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
      nums.map((n) => `<w:num w:numId="${n.id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="${n.lvl}"><w:startOverride w:val="${n.start}"/></w:lvlOverride></w:num>`).join('') +
      '</w:numbering>';
  }

  /* ── Standalone web page (.html) ──────────────────────── */

  async function buildHtml(job, title) {
    const clone = docEl.cloneNode(true);
    for (const el of clone.querySelectorAll('.copy-btn, .h-anchor')) el.remove();
    for (const m of clone.querySelectorAll('mark.find-hit')) m.replaceWith(...m.childNodes);
    for (const el of clone.querySelectorAll('.flash')) el.classList.remove('flash');
    for (const el of clone.querySelectorAll('[data-mrdir]')) el.removeAttribute('data-mrdir');
    for (const el of clone.querySelectorAll('.mermaid-block.rendered, .graphviz-block.rendered')) el.removeAttribute('data-src');
    // Equations as MathML: every current browser typesets it, no fonts to embed.
    for (const k of clone.querySelectorAll('.math')) {
      const mm = k.querySelector('.katex-mathml math');
      if (!mm) continue;
      for (const a of mm.querySelectorAll('annotation')) a.remove();
      if (k.classList.contains('math-display')) mm.setAttribute('display', 'block');
      k.replaceChildren(mm);
    }
    // Local pictures go inside the file, so it can be mailed or moved.
    const imgs = $$('img', docEl), copies = $$('img', clone);
    await Promise.all(imgs.map(async (img, i) => {
      const c = copies[i];
      c.removeAttribute('loading');
      c.removeAttribute('decoding');
      const src = img.currentSrc || img.src;
      if (!src.startsWith(ORIGIN)) return;
      try {
        const r = await fetch(src);
        if (r.ok) c.setAttribute('src', await blobToDataUrl(await r.blob()));
      } catch {}
    }));
    const dir = docEl.getAttribute('dir') || 'ltr';
    const lang = dir === 'rtl' && /[֐-׿]/.test(docEl.textContent) ? ' lang="he"' : '';
    const ui = state.ui;
    const attrs = `data-theme="light" data-font="${xml(ui.font)}" data-leading="${xml(ui.leading)}" data-width="${xml(ui.width)}" data-justify="${xml(ui.justify)}" style="--size:${+ui.size || 17}px"`;
    return `<!DOCTYPE html>
<html dir="${dir}"${lang} ${attrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${xml(job.generator)}">
<title>${xml(title)}</title>
<style>
${collectCss()}
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { -webkit-text-size-adjust: 100%; }
#doc { padding: 40px 24px 64px; }
#doc .math { direction: ltr; }
#doc math { font-family: "Cambria Math", "STIX Two Math", "Latin Modern Math", math; font-size: 1.12em; }
#doc math[display="block"] { display: block math; margin: .9em auto; overflow-x: auto; text-align: center; }
#doc .math-display { text-align: center; }
#doc a.ext::after { content: none; }
</style>
</head>
<body>
<article id="doc" dir="${dir}">
${clone.innerHTML}
</article>
</body>
</html>
`;
  }

  /** The document styles of the reader (light theme), without the UI chrome. */
  function collectCss() {
    const keepSel = (sel) => sel.split(',').some((s) => {
      s = s.trim();
      return /#doc\b/.test(s) || /^:root(\[data-theme="light"\]|\[data-(font|leading|width|justify)="[^"]*"\])?$/.test(s);
    });
    // syntax colours: the light set (the dark one is scoped under data-theme="dark")
    const keepHl = (sel) => !sel.includes('data-theme="dark"');
    const walk = (rules, keep) => {
      let out = '';
      for (const r of rules) {
        if (r instanceof CSSStyleRule) { if (keep(r.selectorText)) out += r.cssText + '\n'; }
        else if (r instanceof CSSMediaRule) { const inner = walk(r.cssRules, keep); if (inner) out += `@media ${r.conditionText} {\n${inner}}\n`; }
      }
      return out;
    };
    let css = '';
    for (const sheet of document.styleSheets) {
      const href = sheet.href || '';
      const keep = /\/app\.css$/.test(href) ? keepSel : /\/highlight\.css$/.test(href) ? keepHl : null;
      if (!keep) continue;
      try { css += walk(sheet.cssRules, keep); } catch {}
    }
    return css;
  }
})();
