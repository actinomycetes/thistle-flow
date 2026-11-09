// Rendering of pseudocolor / density / contour / dot plots, histograms, overlays and gates.
// Works on a Canvas 2D context or on the canvas-compatible SVG/PDF contexts from vector.js.
import { makeTransform } from './transforms.js';

export const MARGIN = { l: 64, r: 14, t: 24, b: 48 };

export const THEMES = {
  light: { name: 'light', bg: '#ffffff', axis: '#444444', text: '#333333', title: '#222222', dot: '#222222', hist: '#4a5568', contour: '#1d2330', labelBg: 'rgba(255,255,255,0.85)', legendBg: 'rgba(255,255,255,0.85)', muted: '#888888' },
  dark: { name: 'dark', bg: '#161a21', axis: '#9aa3b2', text: '#cfd5df', title: '#e6e9ef', dot: '#d0d5de', hist: '#9aa8bd', contour: '#e6e9ef', labelBg: 'rgba(22,26,33,0.85)', legendBg: 'rgba(22,26,33,0.85)', muted: '#7d8696' },
};

// Plot kinds. 'density' was the pseudocolor kind in early workspaces.
export const PLOT_KINDS = [['pseudo', 'Pseudocolor'], ['smooth', 'Density'], ['contour', 'Contour'], ['dot', 'Dot']];
export const normalizeKind = k => (k === 'density' || !k ? 'pseudo' : k);

// FlowJo-like pseudocolor LUT: blue -> cyan -> green -> yellow -> red
const STOPS = [[0, [0, 0, 200]], [0.25, [0, 170, 255]], [0.5, [0, 210, 60]], [0.75, [255, 230, 0]], [1, [230, 0, 0]]];
export const LUT = (() => {
  const lut = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0; while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    const [t0, c0] = STOPS[k], [t1, c1] = STOPS[k + 1];
    const f = (t - t0) / (t1 - t0);
    lut.push(c0.map((c, j) => Math.round(c + (c1[j] - c) * f)));
  }
  return lut;
})();

export const SERIES_COLORS = ['#d62728', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#7f7f7f', '#bcbd22', '#000000'];

export function layout(w, h) {
  const pw = w - MARGIN.l - MARGIN.r, ph = h - MARGIN.t - MARGIN.b;
  return {
    w, h, pw, ph,
    ux2px: u => MARGIN.l + u * pw,
    uy2px: u => MARGIN.t + (1 - u) * ph,
    px2ux: px => (px - MARGIN.l) / pw,
    px2uy: py => 1 - (py - MARGIN.t) / ph,
  };
}

export function hexToRgb(hex) {
  let s = hex.replace('#', '');
  if (s.length === 3) s = s.split('').map(c => c + c).join('');
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function prepareCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function makeImage(w, h) {
  if (typeof ImageData !== 'undefined') return new ImageData(w, h);
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

// Draw an RGBA bitmap scaled into a rectangle. Vector contexts embed it as an image.
function drawRaster(ctx, img, x, y, w, h, smooth) {
  if (ctx.drawRaster) return ctx.drawRaster(img, x, y, w, h, smooth);
  const off = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(img.width, img.height)
    : Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
  off.getContext('2d').putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = !!smooth;
  ctx.drawImage(off, x, y, w, h);
  ctx.restore();
}

/**
 * spec: {
 *   w, h, kind: 'pseudo'|'smooth'|'contour'|'dot'|'histogram', title, theme,
 *   x: {name, label, cfg}, y: {name, label, cfg} | null,
 *   series: [{ ux, uy, idx, fullIdx, color, label }], // idx = events drawn as dots; fullIdx = all (density/contours)
 *   hist: { mode: 'count'|'mode', smooth, offset: 0..1, fill, bins },
 *   contour: { step: 0.1, outliers: true },
 *   gates: [{ gate, text, selected, color }],     // render sets item.labelBox
 *   showLegend
 * }
 */
export function renderPlot(ctx, spec) {
  const T = spec.theme || THEMES.light;
  const L = layout(spec.w, spec.h);
  const kind = spec.kind === 'histogram' ? 'histogram' : normalizeKind(spec.kind);
  ctx.save();
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, spec.w, spec.h);
  ctx.save();
  ctx.beginPath(); ctx.rect(MARGIN.l, MARGIN.t, L.pw, L.ph); ctx.clip();
  if (kind === 'histogram') drawHistograms(ctx, L, spec, T);
  else if (spec.series.length === 1 && kind === 'pseudo') drawPseudo(ctx, L, spec.series[0]);
  else if (spec.series.length === 1 && kind === 'smooth') drawSmooth(ctx, L, spec.series[0]);
  else if (spec.series.length === 1 && kind === 'contour') drawContour(ctx, L, spec.series[0], spec.contour || {}, T);
  else drawDots(ctx, L, spec.series, T);
  ctx.restore();
  drawAxes(ctx, L, spec, T);
  if (spec.gates) for (const g of spec.gates) drawGate(ctx, L, spec, g, T);
  if (spec.showLegend && spec.series.length > 1) drawLegend(ctx, L, spec.series, T);
  if (spec.title) {
    ctx.fillStyle = T.title; ctx.font = '600 12px Helvetica, Arial, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(truncate(ctx, spec.title, spec.w - 12), 6, 5);
  }
  ctx.restore();
  return L;
}

function truncate(ctx, s, maxW) {
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 3 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

// ---- 2D binning helpers ----
function binGrid(s, nx, ny, idx = s.idx) {
  const grid = new Float32Array(nx * ny);
  const { ux, uy } = s;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    let gx = Math.floor(ux[i] * nx), gy = Math.floor(uy[i] * ny);
    if (!(gx >= 0)) gx = 0; else if (gx >= nx) gx = nx - 1; // pile off-scale events on the axes like FlowJo
    if (!(gy >= 0)) gy = 0; else if (gy >= ny) gy = ny - 1;
    grid[gy * nx + gx]++;
  }
  return grid;
}

export function gaussianBlur(g, nx, ny, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = []; let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); ks += v; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(g.length), out = new Float32Array(g.length);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let s = 0; for (let i = -r; i <= r; i++) { const xx = x + i; if (xx >= 0 && xx < nx) s += g[y * nx + xx] * k[i + r]; }
    tmp[y * nx + x] = s;
  }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let s = 0; for (let i = -r; i <= r; i++) { const yy = y + i; if (yy >= 0 && yy < ny) s += tmp[yy * nx + x] * k[i + r]; }
    out[y * nx + x] = s;
  }
  return out;
}

function box3(g, nx, ny) {
  const out = new Float32Array(g.length);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= ny) continue;
      for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= nx) continue;
        const wgt = dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
        s += g[yy * nx + xx] * wgt; n += wgt; } }
    out[y * nx + x] = s / n * 4; // keep isolated single events visible
  }
  return out;
}

function drawPseudo(ctx, L, s) {
  const cell = 2;
  const nx = Math.max(1, Math.floor(L.pw / cell)), ny = Math.max(1, Math.floor(L.ph / cell));
  const grid = binGrid(s, nx, ny);
  const sm = box3(grid, nx, ny);
  let max = 0; for (let i = 0; i < sm.length; i++) if (sm[i] > max) max = sm[i];
  const img = makeImage(nx, ny);
  const lmax = Math.log1p(max);
  for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++) {
    const v = sm[gy * nx + gx];
    if (grid[gy * nx + gx] <= 0 && v <= 0.34) continue;
    const c = LUT[Math.min(255, Math.max(0, Math.round((lmax > 0 ? Math.log1p(v) / lmax : 0) * 255)))];
    const o = ((ny - 1 - gy) * nx + gx) * 4;
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  }
  drawRaster(ctx, img, MARGIN.l, MARGIN.t, nx * cell, ny * cell, false);
}

// Smooth kernel-density shading
function drawSmooth(ctx, L, s) {
  const cell = 3;
  const nx = Math.max(1, Math.floor(L.pw / cell)), ny = Math.max(1, Math.floor(L.ph / cell));
  const d = gaussianBlur(binGrid(s, nx, ny, s.fullIdx || s.idx), nx, ny, 1.6); // shading uses every event
  let max = 0; for (let i = 0; i < d.length; i++) if (d[i] > max) max = d[i];
  const img = makeImage(nx, ny);
  for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++) {
    const t = max > 0 ? Math.sqrt(d[gy * nx + gx] / max) : 0;
    if (t < 0.03) continue;
    const c = LUT[Math.min(255, Math.round(t * 255))];
    const o = ((ny - 1 - gy) * nx + gx) * 4;
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
    img.data[o + 3] = Math.round(255 * Math.min(1, t * 4)); // fade out the sparse edge
  }
  drawRaster(ctx, img, MARGIN.l, MARGIN.t, nx * cell, ny * cell, true);
}

// Equal-probability contour levels: each successive line encloses `step` less of the events.
export function contourLevels(grid, density, step) {
  const n = grid.length;
  const order = Array.from({ length: n }, (_, i) => i).filter(i => grid[i] > 0).sort((a, b) => density[a] - density[b]);
  let total = 0; for (const i of order) total += grid[i];
  const levels = [];
  let cum = 0, k = 1;
  for (const i of order) {
    cum += grid[i];
    while (k * step < 1 - 1e-9 && cum / total >= k * step) {
      if (!levels.length || density[i] > levels.at(-1) * 1.0001) levels.push(density[i]);
      k++;
    }
  }
  return levels;
}

// Marching squares over a padded grid. Returns segments [x1,y1,x2,y2] in unit coordinates.
export function marchingSquares(d, nx, ny, level) {
  const W = nx + 2, H = ny + 2;
  const P = new Float32Array(W * H);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) P[(y + 1) * W + x + 1] = d[y * nx + x];
  const ux = i => (i - 0.5) / nx, uy = j => (j - 0.5) / ny;
  const segs = [];
  const lerp = (a, b) => (level - a) / (b - a);
  for (let j = 0; j < H - 1; j++) for (let i = 0; i < W - 1; i++) {
    const a = P[j * W + i], b = P[j * W + i + 1], c = P[(j + 1) * W + i + 1], e = P[(j + 1) * W + i];
    const code = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (e >= level ? 8 : 0);
    if (code === 0 || code === 15) continue;
    const bottom = [ux(i + lerp(a, b)), uy(j)], right = [ux(i + 1), uy(j + lerp(b, c))];
    const top = [ux(i + lerp(e, c)), uy(j + 1)], left = [ux(i), uy(j + lerp(a, e))];
    const add = (p, q) => segs.push([p[0], p[1], q[0], q[1]]);
    switch (code) {
      case 1: case 14: add(left, bottom); break;
      case 2: case 13: add(bottom, right); break;
      case 3: case 12: add(left, right); break;
      case 4: case 11: add(top, right); break;
      case 6: case 9: add(bottom, top); break;
      case 7: case 8: add(left, top); break;
      case 5: add(left, top); add(bottom, right); break;
      case 10: add(left, bottom); add(top, right); break;
    }
  }
  return segs;
}

function drawContour(ctx, L, s, opt, T) {
  const cell = 3;
  const nx = Math.max(4, Math.floor(L.pw / cell)), ny = Math.max(4, Math.floor(L.ph / cell));
  const grid = binGrid(s, nx, ny, s.fullIdx || s.idx); // contour levels use every event; only outlier dots are thinned
  const d = gaussianBlur(grid, nx, ny, 1.6);
  const levels = contourLevels(grid, d, opt.step || 0.1);
  if (opt.outliers !== false && levels.length) {
    // events outside the outermost contour are drawn as dots
    ctx.fillStyle = T.dot;
    const { ux, uy, idx } = s, lo = levels[0];
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      let gx = Math.floor(ux[i] * nx), gy = Math.floor(uy[i] * ny);
      gx = Math.min(nx - 1, Math.max(0, gx || 0)); gy = Math.min(ny - 1, Math.max(0, gy || 0));
      if (d[gy * nx + gx] >= lo) continue;
      ctx.fillRect(L.ux2px(Math.min(1, Math.max(0, ux[i]))) - 0.6, L.uy2px(Math.min(1, Math.max(0, uy[i]))) - 0.6, 1.3, 1.3);
    }
  }
  ctx.strokeStyle = T.contour; ctx.lineWidth = 0.9;
  for (const lv of levels) {
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of marchingSquares(d, nx, ny, lv)) { ctx.moveTo(L.ux2px(x1), L.uy2px(y1)); ctx.lineTo(L.ux2px(x2), L.uy2px(y2)); }
    ctx.stroke();
  }
}

function drawDots(ctx, L, series, T) {
  series.forEach(s => {
    const { ux, uy, idx } = s;
    ctx.fillStyle = s.color || T.dot;
    if (series.length > 1) ctx.globalAlpha = 0.6;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const x = Math.min(1, Math.max(0, ux[i] || 0)), y = Math.min(1, Math.max(0, uy[i] || 0));
      ctx.fillRect(L.ux2px(x) - 0.6, L.uy2px(y) - 0.6, 1.3, 1.3);
    }
    ctx.globalAlpha = 1;
  });
}

export function histogramCounts(ux, idx, bins) {
  const h = new Float64Array(bins);
  for (let k = 0; k < idx.length; k++) {
    const u = ux[idx[k]];
    if (!(u >= 0 && u < 1)) continue;
    h[Math.floor(u * bins)]++;
  }
  return h;
}

function smoothHist(h) {
  const k = [1, 4, 6, 4, 1];
  const out = new Float64Array(h.length);
  for (let i = 0; i < h.length; i++) {
    let s = 0, n = 0;
    for (let j = -2; j <= 2; j++) { const ii = i + j; if (ii < 0 || ii >= h.length) continue; s += h[ii] * k[j + 2]; n += k[j + 2]; }
    out[i] = s / n;
  }
  return out;
}

// Histogram offsets: 0 = overlaid, 0.5 = half offset (peaks overlap by half a band), 1 = full offset (no overlap)
export const HIST_OFFSETS = [[0, 'Overlay'], [0.25, 'Quarter offset'], [0.5, 'Half offset'], [1, 'Full offset']];

function drawHistograms(ctx, L, spec, T) {
  const opt = spec.hist || {};
  const bins = opt.bins || 256;
  const n = spec.series.length;
  const offset = n > 1 ? (opt.offset || 0) : 0;
  const hs = spec.series.map(s => {
    let h = histogramCounts(s.ux, s.idx, bins);
    if (opt.smooth) h = smoothHist(h);
    return h;
  });
  let globalMax = 0; hs.forEach(h => h.forEach(v => { if (v > globalMax) globalMax = v; }));
  spec._histMax = globalMax;
  const bandH = n > 1 && offset > 0 ? 1 / (1 + offset * (n - 1)) : 1;
  for (let si = n - 1; si >= 0; si--) {
    const h = hs[si], s = spec.series[si];
    let max = opt.mode === 'mode' ? Math.max(...h) : globalMax;
    if (!max) max = 1;
    const base = si * offset * bandH;
    ctx.beginPath();
    ctx.moveTo(L.ux2px(0), L.uy2px(base));
    for (let b = 0; b < bins; b++) {
      const y = base + (h[b] / max) * bandH * 0.95;
      ctx.lineTo(L.ux2px(b / bins), L.uy2px(y));
      ctx.lineTo(L.ux2px((b + 1) / bins), L.uy2px(y));
    }
    ctx.lineTo(L.ux2px(1), L.uy2px(base));
    ctx.closePath();
    const color = s.color || T.hist;
    if (opt.fill !== false) {
      const [r, g, b] = hexToRgb(color);
      ctx.fillStyle = n > 1 && offset === 0 ? `rgba(${r},${g},${b},0.25)` : `rgba(${r},${g},${b},0.55)`;
      ctx.fill();
    }
    ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.stroke();
    if (n > 1 && offset > 0 && s.label) {
      ctx.fillStyle = color; ctx.font = '11px Helvetica, Arial, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText(s.label, L.ux2px(1) - 4, L.uy2px(base + bandH * Math.min(0.35, 0.9)));
    }
  }
}

function drawAxes(ctx, L, spec, T) {
  ctx.strokeStyle = T.axis; ctx.lineWidth = 1;
  ctx.strokeRect(MARGIN.l + 0.5, MARGIN.t + 0.5, L.pw, L.ph);
  ctx.font = '10px Helvetica, Arial, sans-serif'; ctx.fillStyle = T.text;
  const tx = makeTransform(spec.x.cfg);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const t of tx.ticks()) {
    const u = tx.fwd(t.v); if (u < -0.001 || u > 1.001) continue;
    const px = Math.round(L.ux2px(u)) + 0.5;
    ctx.beginPath(); ctx.moveTo(px, MARGIN.t + L.ph); ctx.lineTo(px, MARGIN.t + L.ph + (t.major ? 6 : 3)); ctx.stroke();
    if (t.label) ctx.fillText(t.label, px, MARGIN.t + L.ph + 8);
  }
  ctx.font = '600 11px Helvetica, Arial, sans-serif';
  ctx.fillText(truncate(ctx, spec.x.label, L.pw), MARGIN.l + L.pw / 2, spec.h - 16);
  ctx.font = '10px Helvetica, Arial, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  if (spec.kind === 'histogram') {
    const isMode = spec.hist?.mode === 'mode';
    const max = spec._histMax || 1;
    const ticks = isMode ? [0, 20, 40, 60, 80, 100].map(v => ({ v, u: v / 100 * 0.95, label: String(v) }))
      : niceCountTicks(max).map(v => ({ v, u: v / max * 0.95, label: v >= 1000 ? (v / 1000) + 'K' : String(v) }));
    const showTicks = !(spec.series.length > 1 && (spec.hist?.offset || 0) > 0);
    if (showTicks) for (const t of ticks) {
      if (t.u > 1) continue;
      const py = Math.round(L.uy2px(t.u)) + 0.5;
      ctx.beginPath(); ctx.moveTo(MARGIN.l - 5, py); ctx.lineTo(MARGIN.l, py); ctx.stroke();
      ctx.fillText(t.label, MARGIN.l - 7, py);
    }
    drawYLabel(ctx, L, isMode ? 'Normalized to Mode' : 'Count', T);
  } else {
    const ty = makeTransform(spec.y.cfg);
    for (const t of ty.ticks()) {
      const u = ty.fwd(t.v); if (u < -0.001 || u > 1.001) continue;
      const py = Math.round(L.uy2px(u)) + 0.5;
      ctx.beginPath(); ctx.moveTo(MARGIN.l - (t.major ? 6 : 3), py); ctx.lineTo(MARGIN.l, py); ctx.stroke();
      if (t.label) ctx.fillText(t.label, MARGIN.l - 8, py);
    }
    drawYLabel(ctx, L, spec.y.label, T);
  }
}

function drawYLabel(ctx, L, text, T) {
  ctx.save();
  ctx.translate(13, MARGIN.t + L.ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.font = '600 11px Helvetica, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = T.text;
  ctx.fillText(truncate(ctx, text, L.ph), 0, 0);
  ctx.restore();
}

function niceCountTicks(max) {
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => max / s <= 5) || mag * 10;
  const out = []; for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}

function drawLegend(ctx, L, series, T) {
  ctx.font = '11px Helvetica, Arial, sans-serif';
  const lineH = 15;
  const w = Math.min(L.pw * 0.6, Math.max(...series.map(s => ctx.measureText(s.label || '').width)) + 26);
  const x = MARGIN.l + L.pw - w - 6, y = MARGIN.t + 6;
  ctx.fillStyle = T.legendBg; ctx.fillRect(x, y, w, series.length * lineH + 6);
  series.forEach((s, i) => {
    ctx.fillStyle = s.color; ctx.fillRect(x + 6, y + 6 + i * lineH, 10, 10);
    ctx.fillStyle = T.text; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(truncate(ctx, s.label || '', w - 26), x + 20, y + 4 + i * lineH);
  });
}

// ---- gates ----
export function gateGeometry(L, spec, g) {
  const tx = makeTransform(spec.x.cfg);
  const X = v => L.ux2px(v === -Infinity ? -0.05 : v === Infinity ? 1.05 : tx.fwd(v));
  if (g.type === 'interval') {
    const lvl = g.level ?? 0.85;
    return { kind: 'interval', x0: X(g.x0), x1: X(g.x1), y: L.uy2px(lvl) };
  }
  const ty = makeTransform(spec.y.cfg);
  const Y = v => L.uy2px(v === -Infinity ? -0.05 : v === Infinity ? 1.05 : ty.fwd(v));
  if (g.type === 'rect') return { kind: 'poly', pts: [[X(g.x0), Y(g.y0)], [X(g.x1), Y(g.y0)], [X(g.x1), Y(g.y1)], [X(g.x0), Y(g.y1)]] };
  if (g.type === 'polygon') return { kind: 'poly', pts: g.pts.map(([x, y]) => [X(x), Y(y)]) };
  if (g.type === 'quad') return { kind: 'quad', cx: X(g.cx), cy: Y(g.cy) };
  return null;
}

const LABEL_FONT = '600 11px Helvetica, Arial, sans-serif';

function drawGate(ctx, L, spec, item, T) {
  const { gate: g, text, selected } = item;
  const geo = gateGeometry(L, spec, g);
  if (!geo) return;
  const color = item.color || '#000';
  const cx = x => Math.min(MARGIN.l + L.pw - 2, Math.max(MARGIN.l + 2, x));
  const cy = y => Math.min(MARGIN.t + L.ph - 2, Math.max(MARGIN.t + 2, y));
  ctx.save();
  ctx.font = LABEL_FONT;
  const tw = ctx.measureText(text).width;
  let def; // default label centre
  ctx.save();
  ctx.beginPath(); ctx.rect(MARGIN.l - 1, MARGIN.t - 1, L.pw + 2, L.ph + 2); ctx.clip();
  ctx.lineWidth = selected ? 2.2 : 1.4;
  ctx.strokeStyle = color;
  if (geo.kind === 'poly') {
    ctx.beginPath();
    geo.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath(); ctx.stroke();
    if (selected) { ctx.fillStyle = color; for (const [x, y] of geo.pts) ctx.fillRect(cx(x) - 3, cy(y) - 3, 6, 6); }
    let top = geo.pts[0]; for (const p of geo.pts) if (p[1] < top[1]) top = p;
    const xs = geo.pts.map(p => cx(p[0]));
    def = [(Math.min(...xs) + Math.max(...xs)) / 2, top[1] - 10];
  } else if (geo.kind === 'quad') {
    ctx.beginPath();
    ctx.moveTo(geo.cx, MARGIN.t); ctx.lineTo(geo.cx, MARGIN.t + L.ph);
    ctx.moveTo(MARGIN.l, geo.cy); ctx.lineTo(MARGIN.l + L.pw, geo.cy);
    ctx.stroke();
    if (selected) { ctx.fillStyle = color; ctx.fillRect(geo.cx - 4, geo.cy - 4, 8, 8); }
    const left = MARGIN.l + 6 + tw / 2, right = MARGIN.l + L.pw - 6 - tw / 2, top = MARGIN.t + 11, bottom = MARGIN.t + L.ph - 11;
    def = { UL: [left, top], UR: [right, top], LL: [left, bottom], LR: [right, bottom] }[g.q];
  } else if (geo.kind === 'interval') {
    ctx.beginPath();
    ctx.moveTo(geo.x0, geo.y - 8); ctx.lineTo(geo.x0, geo.y + 8);
    ctx.moveTo(geo.x1, geo.y - 8); ctx.lineTo(geo.x1, geo.y + 8);
    ctx.moveTo(geo.x0, geo.y); ctx.lineTo(geo.x1, geo.y);
    ctx.stroke();
    if (selected) { ctx.fillStyle = color; ctx.fillRect(cx(geo.x0) - 3, geo.y - 3, 6, 6); ctx.fillRect(cx(geo.x1) - 3, geo.y - 3, 6, 6); }
    def = [(cx(geo.x0) + cx(geo.x1)) / 2, geo.y - 14];
  }
  ctx.restore();
  // Label: user-dragged position (stored in plot units) or the default, kept inside the plot
  let [lx, ly] = g.labelPos ? [L.ux2px(g.labelPos[0]), L.uy2px(g.labelPos[1])] : def;
  lx = Math.min(MARGIN.l + L.pw - tw / 2 - 4, Math.max(MARGIN.l + tw / 2 + 4, lx));
  ly = Math.min(MARGIN.t + L.ph - 9, Math.max(MARGIN.t + 9, ly));
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = T.labelBg; ctx.fillRect(lx - tw / 2 - 3, ly - 8, tw + 6, 16);
  ctx.fillStyle = color; ctx.fillText(text, lx, ly);
  item.labelBox = { x: lx - tw / 2 - 3, y: ly - 8, w: tw + 6, h: 16, cx: lx, cy: ly };
  ctx.restore();
}
