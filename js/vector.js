// Canvas-2D-compatible vector contexts: the plot renderer draws into these to produce SVG or PDF.
// Supports the subset of the Canvas API used by render.js (paths, rects, text, clipping, transforms,
// alpha, dashes) plus drawRaster() for embedded bitmaps (density plots).

const r2 = v => Math.round(v * 100) / 100;

function parseFont(font) {
  const size = parseFloat((/(\d+(?:\.\d+)?)px/.exec(font) || [, '10'])[1]);
  const bold = /\b(600|700|800|900|bold)\b/.test(font);
  return { size, bold };
}

export function parseColor(c) {
  if (!c || c === 'transparent' || c === 'none') return { r: 0, g: 0, b: 0, a: 0 };
  c = String(c).trim();
  if (c[0] === '#') {
    let s = c.slice(1);
    if (s.length === 3 || s.length === 4) s = s.split('').map(x => x + x).join('');
    const n = parseInt(s.slice(0, 6), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: s.length === 8 ? parseInt(s.slice(6), 16) / 255 : 1 };
  }
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) { const p = m[1].split(',').map(x => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
  const named = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128] };
  const v = named[c.toLowerCase()] || [0, 0, 0];
  return { r: v[0], g: v[1], b: v[2], a: 1 };
}

let _measureCtx = null;
function measure(text, font) {
  if (typeof document !== 'undefined') {
    _measureCtx = _measureCtx || document.createElement('canvas').getContext('2d');
    _measureCtx.font = font;
    return _measureCtx.measureText(text).width;
  }
  return text.length * parseFont(font).size * 0.55;
}

// Vertical offset (canvas y-down units) from the requested baseline to the alphabetic baseline
function baselineShift(baseline, size) {
  return { top: 0.78, hanging: 0.78, middle: 0.35, bottom: -0.22, ideographic: -0.22 }[baseline] * size || 0;
}

class VectorContext {
  constructor(w, h) {
    this.width = w; this.height = h;
    this.st = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', dash: [], m: [1, 0, 0, 1, 0, 0] };
    this.stack = [];
    this.path = [];
    this.imageSmoothingEnabled = true;
  }
  // ---- state ----
  get fillStyle() { return this.st.fillStyle; } set fillStyle(v) { this.st.fillStyle = v; }
  get strokeStyle() { return this.st.strokeStyle; } set strokeStyle(v) { this.st.strokeStyle = v; }
  get lineWidth() { return this.st.lineWidth; } set lineWidth(v) { this.st.lineWidth = v; }
  get globalAlpha() { return this.st.globalAlpha; } set globalAlpha(v) { this.st.globalAlpha = v; }
  get font() { return this.st.font; } set font(v) { this.st.font = v; }
  get textAlign() { return this.st.textAlign; } set textAlign(v) { this.st.textAlign = v; }
  get textBaseline() { return this.st.textBaseline; } set textBaseline(v) { this.st.textBaseline = v; }
  setLineDash(d) { this.st.dash = [...d]; }
  getLineDash() { return [...this.st.dash]; }
  save() { this.stack.push({ ...this.st, m: [...this.st.m], dash: [...this.st.dash] }); this.onSave(); }
  restore() { if (!this.stack.length) return; this.st = this.stack.pop(); this.onRestore(); }
  setTransform(a, b, c, d, e, f) { this.st.m = [a, b, c, d, e, f]; }
  transform(a, b, c, d, e, f) {
    const [A, B, C, D, E, F] = this.st.m;
    this.st.m = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
  }
  translate(x, y) { this.transform(1, 0, 0, 1, x, y); }
  scale(x, y) { this.transform(x, 0, 0, y, 0, 0); }
  rotate(t) { const c = Math.cos(t), s = Math.sin(t); this.transform(c, s, -s, c, 0, 0); }
  tp(x, y) { const [a, b, c, d, e, f] = this.st.m; return [a * x + c * y + e, b * x + d * y + f]; }
  lineScale() { const [a, b, c, d] = this.st.m; return Math.sqrt(Math.abs(a * d - b * c)) || 1; }
  // ---- paths ----
  beginPath() { this.path = []; }
  moveTo(x, y) { this.path.push({ pts: [this.tp(x, y)], closed: false }); }
  lineTo(x, y) { if (!this.path.length) return this.moveTo(x, y); this.path.at(-1).pts.push(this.tp(x, y)); }
  closePath() { if (this.path.length) this.path.at(-1).closed = true; }
  rect(x, y, w, h) { this.path.push({ pts: [this.tp(x, y), this.tp(x + w, y), this.tp(x + w, y + h), this.tp(x, y + h)], closed: true }); }
  fill() { this.paint(this.path, 'fill'); }
  stroke() { this.paint(this.path, 'stroke'); }
  fillRect(x, y, w, h) { const p = this.path; this.path = []; this.rect(x, y, w, h); this.paint(this.path, 'fill'); this.path = p; }
  strokeRect(x, y, w, h) { const p = this.path; this.path = []; this.rect(x, y, w, h); this.paint(this.path, 'stroke'); this.path = p; }
  clearRect() {}
  clip() { this.pushClip(this.path); }
  measureText(t) { return { width: measure(String(t), this.st.font) }; }
  fillText(text, x, y) {
    text = String(text);
    const { size } = parseFont(this.st.font);
    const w = measure(text, this.st.font);
    const dx = this.st.textAlign === 'center' ? -w / 2 : (this.st.textAlign === 'right' || this.st.textAlign === 'end') ? -w : 0;
    this.emitText(text, x + dx, y + baselineShift(this.st.textBaseline, size), w);
  }
  // drawImage of real canvases is not supported; render.js uses drawRaster for bitmaps.
  drawImage() {}
}

// ---------------- SVG ----------------
const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class SVGContext extends VectorContext {
  constructor(w, h) {
    super(w, h);
    this.out = []; this.defs = []; this.openGroups = [0]; this.clipN = 0;
  }
  onSave() { this.openGroups.push(0); }
  onRestore() { const n = this.openGroups.pop() || 0; for (let i = 0; i < n; i++) this.out.push('</g>'); }
  d(path) { return path.map(sp => 'M' + sp.pts.map(([x, y]) => `${r2(x)} ${r2(y)}`).join('L') + (sp.closed ? 'Z' : '')).join(''); }
  paint(path, mode) {
    if (!path.length) return;
    const c = parseColor(mode === 'fill' ? this.st.fillStyle : this.st.strokeStyle);
    const a = c.a * this.st.globalAlpha;
    if (a <= 0) return;
    const col = `rgb(${c.r},${c.g},${c.b})`;
    if (mode === 'fill') {
      // compact output for axis-aligned single rectangles (dots)
      const sp = path[0];
      if (path.length === 1 && sp.closed && sp.pts.length === 4 && sp.pts[0][1] === sp.pts[1][1] && sp.pts[1][0] === sp.pts[2][0]) {
        const xs = sp.pts.map(p => p[0]), ys = sp.pts.map(p => p[1]);
        const x = Math.min(...xs), y = Math.min(...ys);
        this.out.push(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(Math.max(...xs) - x)}" height="${r2(Math.max(...ys) - y)}" fill="${col}"${a < 1 ? ` fill-opacity="${r2(a)}"` : ''}/>`);
        return;
      }
      this.out.push(`<path d="${this.d(path)}" fill="${col}"${a < 1 ? ` fill-opacity="${r2(a)}"` : ''}/>`);
    } else {
      const lw = this.st.lineWidth * this.lineScale();
      const dash = this.st.dash.length ? ` stroke-dasharray="${this.st.dash.map(v => r2(v * this.lineScale())).join(' ')}"` : '';
      this.out.push(`<path d="${this.d(path)}" fill="none" stroke="${col}" stroke-width="${r2(lw)}"${a < 1 ? ` stroke-opacity="${r2(a)}"` : ''}${dash} stroke-linejoin="round"/>`);
    }
  }
  pushClip(path) {
    const id = `c${++this.clipN}`;
    this.defs.push(`<clipPath id="${id}"><path d="${this.d(path)}"/></clipPath>`);
    this.out.push(`<g clip-path="url(#${id})">`);
    this.openGroups[this.openGroups.length - 1]++;
  }
  emitText(text, x, y) {
    const { size, bold } = parseFont(this.st.font);
    const c = parseColor(this.st.fillStyle);
    const [a, b, cc, d, e, f] = this.st.m;
    this.out.push(`<text transform="matrix(${[a, b, cc, d, e, f].map(r2).join(' ')})" x="${r2(x)}" y="${r2(y)}" font-family="Helvetica, Arial, sans-serif" font-size="${size}"${bold ? ' font-weight="bold"' : ''} fill="rgb(${c.r},${c.g},${c.b})"${c.a * this.st.globalAlpha < 1 ? ` fill-opacity="${r2(c.a * this.st.globalAlpha)}"` : ''}>${xmlEsc(text)}</text>`);
  }
  drawRaster(img, x, y, w, h, smooth) {
    const url = imageToPNGDataURL(img);
    if (!url) return;
    const [X, Y] = this.tp(x, y), s = this.lineScale();
    this.out.push(`<image x="${r2(X)}" y="${r2(Y)}" width="${r2(w * s)}" height="${r2(h * s)}" preserveAspectRatio="none"${smooth ? '' : ' style="image-rendering:pixelated" image-rendering="optimizeSpeed"'} href="${url}"/>`);
  }
  toString() {
    while (this.openGroups.length > 1) this.onRestore();
    const n = this.openGroups[0]; this.openGroups[0] = 0;
    for (let i = 0; i < n; i++) this.out.push('</g>');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">\n<defs>${this.defs.join('')}</defs>\n${this.out.join('\n')}\n</svg>\n`;
  }
}

function imageToPNGDataURL(img) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(img.width, img.height); id.data.set(img.data);
  ctx.putImageData(id, 0, 0);
  return c.toDataURL('image/png');
}

// ---------------- PDF ----------------
// Unicode -> WinAnsi (only what the plots use beyond Latin-1)
const WINANSI = { '…': 0x85, '–': 0x96, '—': 0x97, '•': 0x95, '™': 0x99, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '€': 0x80, '−': 0x2d };
const SUPERS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+' };

function winAnsi(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (WINANSI[ch]) out += String.fromCharCode(WINANSI[ch]);
    else if (code < 256) out += ch;
    else out += '?';
  }
  return out.replace(/[\\()]/g, m => '\\' + m);
}

export class PDFContext extends VectorContext {
  constructor(w, h) {
    super(w, h);
    this.ops = [];
    this.gstates = new Map(); // alpha -> name
    this.images = [];
  }
  onSave() { this.ops.push('q'); }
  onRestore() { this.ops.push('Q'); }
  Y(y) { return this.height - y; }
  pathOps(path) {
    return path.map(sp => sp.pts.map(([x, y], i) => `${r2(x)} ${r2(this.Y(y))} ${i ? 'l' : 'm'}`).join(' ') + (sp.closed ? ' h' : '')).join(' ');
  }
  alphaOp(a) {
    a = Math.round(a * 1000) / 1000;
    if (!this.gstates.has(a)) this.gstates.set(a, `GS${this.gstates.size + 1}`);
    return `/${this.gstates.get(a)} gs`;
  }
  rgb(c, op) { return `${r2(c.r / 255)} ${r2(c.g / 255)} ${r2(c.b / 255)} ${op}`; }
  paint(path, mode) {
    if (!path.length) return;
    const c = parseColor(mode === 'fill' ? this.st.fillStyle : this.st.strokeStyle);
    const a = c.a * this.st.globalAlpha;
    if (a <= 0) return;
    if (mode === 'fill') this.ops.push(`${this.alphaOp(a)} ${this.rgb(c, 'rg')} ${this.pathOps(path)} f`);
    else {
      const dash = this.st.dash.length ? `[${this.st.dash.map(v => r2(v * this.lineScale())).join(' ')}] 0 d` : '[] 0 d';
      this.ops.push(`${this.alphaOp(a)} ${this.rgb(c, 'RG')} ${r2(this.st.lineWidth * this.lineScale())} w 1 j ${dash} ${this.pathOps(path)} S`);
    }
  }
  pushClip(path) { if (path.length) this.ops.push(`${this.pathOps(path)} W n`); }
  emitText(text, x, y) {
    const { size, bold } = parseFont(this.st.font);
    const c = parseColor(this.st.fillStyle);
    const [a, b, cc, d, e, f] = this.st.m;
    const font = bold ? 'F2' : 'F1';
    // split into normal / superscript runs (10⁵ -> "10" + raised "5")
    const runs = [];
    for (const ch of text) {
      const sup = ch in SUPERS;
      const t = sup ? SUPERS[ch] : ch;
      if (runs.length && runs.at(-1).sup === sup) runs.at(-1).t += t; else runs.push({ sup, t });
    }
    let cx = x;
    const parts = [];
    for (const r of runs) {
      const sz = r.sup ? size * 0.7 : size;
      const ry = r.sup ? y - size * 0.38 : y;
      const fstr = `${bold ? 'bold ' : ''}${sz}px Helvetica, Arial, sans-serif`;
      // text space -> page: [a, -b, -c, d, e', H - f'] applied at (cx, ry) in canvas-local units
      const ex = a * cx + cc * ry + e, ey = b * cx + d * ry + f;
      parts.push(`/${font} ${r2(sz)} Tf ${r2(a)} ${r2(-b)} ${r2(-cc)} ${r2(d)} ${r2(ex)} ${r2(this.Y(ey))} Tm (${winAnsi(r.t)}) Tj`);
      cx += measure(r.t, fstr);
    }
    this.ops.push(`${this.alphaOp(c.a * this.st.globalAlpha)} ${this.rgb(c, 'rg')} BT ${parts.join(' ')} ET`);
  }
  drawRaster(img, x, y, w, h, smooth) {
    const n = this.images.length + 1;
    this.images.push({ img, smooth, name: `Im${n}` });
    const [X, Yt] = this.tp(x, y), s = this.lineScale();
    this.ops.push(`q ${r2(w * s)} 0 0 ${r2(h * s)} ${r2(X)} ${r2(this.Y(Yt + h * s))} cm /Im${n} Do Q`);
  }
  toBytes() {
    const enc = s => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
    const chunks = []; let len = 0; const offsets = [];
    const push = u => { chunks.push(u); len += u.length; };
    const obj = (id, body) => { offsets[id] = len; push(enc(`${id} 0 obj\n`)); for (const b of [].concat(body)) push(typeof b === 'string' ? enc(b) : b); push(enc('\nendobj\n')); };
    push(enc('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
    const content = enc(this.ops.join('\n'));
    // ids: 1 catalog, 2 pages, 3 page, 4 content, 5 F1, 6 F2, 7.. gstates, then images (+smask)
    let next = 7;
    const gsIds = [...this.gstates.entries()].map(([a, name]) => ({ a, name, id: next++ }));
    const imIds = this.images.map(im => ({ ...im, id: next++, smask: next++ }));
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    const res = `<< /Font << /F1 5 0 R /F2 6 0 R >> /ExtGState << ${gsIds.map(g => `/${g.name} ${g.id} 0 R`).join(' ')} >> /XObject << ${imIds.map(i => `/${i.name} ${i.id} 0 R`).join(' ')} >> >>`;
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${r2(this.width)} ${r2(this.height)}] /Contents 4 0 R /Resources ${res} >>`);
    obj(4, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    for (const g of gsIds) obj(g.id, `<< /Type /ExtGState /ca ${g.a} /CA ${g.a} >>`);
    for (const im of imIds) {
      const { width, height, data } = im.img;
      const rgb = new Uint8Array(width * height * 3), alpha = new Uint8Array(width * height);
      for (let i = 0; i < width * height; i++) { rgb[i * 3] = data[i * 4]; rgb[i * 3 + 1] = data[i * 4 + 1]; rgb[i * 3 + 2] = data[i * 4 + 2]; alpha[i] = data[i * 4 + 3]; }
      obj(im.id, [`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate ${im.smooth ? 'true' : 'false'} /SMask ${im.smask} 0 R /Length ${rgb.length} >>\nstream\n`, rgb, '\nendstream']);
      obj(im.smask, [`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Interpolate ${im.smooth ? 'true' : 'false'} /Length ${alpha.length} >>\nstream\n`, alpha, '\nendstream']);
    }
    const xref = len, n = next;
    let x = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (let i = 1; i < n; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    push(enc(x + `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
    const out = new Uint8Array(len); let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }
}

// draw(ctx) is called once; returns SVG text or PDF bytes.
export function renderSVG(w, h, draw) { const c = new SVGContext(w, h); draw(c); return c.toString(); }
export function renderPDF(w, h, draw) { const c = new PDFContext(w, h); draw(c); return c.toBytes(); }
