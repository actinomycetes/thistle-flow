// Compensation preview: a grid of small density plots, one for every pair of channels in the
// spillover matrix, redrawn live while the matrix is edited (before it is applied), plus a larger
// plot with axes for the selected matrix cell.
//
// The grid mirrors the matrix: the plot in row i (fluorochrome / source) and column j (detector)
// shows channel i on X against channel j on Y, the pair that matrix value i→j corrects.
// Cells single-stained for i should lie flat in j; a population sloping up means too little
// spillover is subtracted (raise the value), one bending down means too much (lower it).
import { makeTransform } from './transforms.js';
import { LUT, gaussianBlur, renderPlot, prepareCanvas, THEMES } from './render.js';
import { invertMatrix } from './model.js';
import { subsampleIdx } from './plotview.js';
import { h } from './ui.js';

// Compensated (or raw) values of the given channels for a subset of events, with any matrix.
export function compensateSubset(sample, names, matrix, idx, { raw = false } = {}) {
  const n = names.length, src = names.map(nm => sample.raw[sample.channelIndex(nm)]);
  const out = names.map(() => new Float32Array(idx.length));
  if (raw) { for (let j = 0; j < n; j++) for (let k = 0; k < idx.length; k++) out[j][k] = src[j][idx[k]]; return out; }
  const inv = invertMatrix(matrix);
  const row = new Float64Array(n);
  for (let k = 0; k < idx.length; k++) {
    const e = idx[k];
    for (let i = 0; i < n; i++) row[i] = src[i][e];
    for (let j = 0; j < n; j++) { let s = 0; for (let i = 0; i < n; i++) s += row[i] * inv[i][j]; out[j][k] = s; }
  }
  return out;
}

function hexRgb(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

// Small pseudocolour density plot of ux/uy (display units) on a size×size canvas.
function drawMini(canvas, ux, uy, size, theme, zero, selected) {
  const dpr = window.devicePixelRatio || 1, W = Math.round(size * dpr);
  canvas.width = W; canvas.height = W;
  canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  const nb = Math.max(8, Math.round(size));
  const grid = new Float32Array(nb * nb);
  const bin = v => { let b = Math.floor(v * nb); return !(b >= 0) ? 0 : b >= nb ? nb - 1 : b; };
  for (let k = 0; k < ux.length; k++) grid[(nb - 1 - bin(uy[k])) * nb + bin(ux[k])]++;
  const d = gaussianBlur(grid, nb, nb, 1.1);
  let max = 0; for (let i = 0; i < d.length; i++) if (d[i] > max) max = d[i];
  const lmax = Math.log1p(max) || 1;
  const img = ctx.createImageData(W, W), px = img.data;
  const bg = hexRgb(theme.bg);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const b = Math.min(nb - 1, Math.floor(y / W * nb)) * nb + Math.min(nb - 1, Math.floor(x / W * nb));
    const c = grid[b] > 0 ? LUT[Math.min(255, Math.round(Math.log1p(d[b]) / lmax * 255))] : bg;
    const o = (y * W + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // zero lines help to judge where the negative population should sit
  ctx.strokeStyle = theme.muted; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath();
  if (zero[0] > 0.01 && zero[0] < 0.99) { ctx.moveTo(zero[0] * size, 0); ctx.lineTo(zero[0] * size, size); }
  if (zero[1] > 0.01 && zero[1] < 0.99) { ctx.moveTo(0, (1 - zero[1]) * size); ctx.lineTo(size, (1 - zero[1]) * size); }
  ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = selected ? '#3b82f6' : theme.axis; ctx.lineWidth = selected ? 3 : 1;
  ctx.strokeRect(selected ? 1.5 : 0.5, selected ? 1.5 : 0.5, size - (selected ? 3 : 1), size - (selected ? 3 : 1));
}

// Two-layer dot plot: uncompensated events underneath, compensated on top (overlay mode).
export const OVERLAY_COLORS = { raw: { dark: '#94a3b8', light: '#111827' }, comp: { dark: '#22d3ee', light: '#06b6d4' } };
function drawMiniOverlay(canvas, layers, size, theme, zero, selected) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr);
  canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, size, size);
  const c = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  for (const { ux, uy, color, alpha } of layers) {
    ctx.fillStyle = color; ctx.globalAlpha = alpha;
    for (let k = 0; k < ux.length; k++) ctx.fillRect(c(ux[k]) * (size - 1), (1 - c(uy[k])) * (size - 1), 1, 1);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.muted; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath();
  if (zero[0] > 0.01 && zero[0] < 0.99) { ctx.moveTo(zero[0] * size, 0); ctx.lineTo(zero[0] * size, size); }
  if (zero[1] > 0.01 && zero[1] < 0.99) { ctx.moveTo(0, (1 - zero[1]) * size); ctx.lineTo(size, (1 - zero[1]) * size); }
  ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = selected ? '#3b82f6' : theme.axis; ctx.lineWidth = selected ? 3 : 1;
  ctx.strokeRect(selected ? 1.5 : 0.5, selected ? 1.5 : 0.5, size - (selected ? 3 : 1), size - (selected ? 3 : 1));
}

export class CompPreview {
  // opts: { ws, sample, names, matrix (edited live by the caller), pop, maxEvents, view: 'edited'|'raw',
  //         overlay (uncompensated events drawn under the compensated ones),
  //         theme, onPick(i, j) }
  constructor(opts) {
    Object.assign(this, { maxEvents: 5000, view: 'edited', overlay: false, sel: null }, opts);
    const n = this.names.length;
    this.size = Math.max(54, Math.min(104, Math.floor(600 / Math.max(1, n))));
    this.cells = [];
    const label = nm => this.ws.channelLabel(nm);
    const grid = this.grid = h('div', { class: 'comp-grid', style: `grid-template-columns: auto repeat(${n}, ${this.size}px)` });
    grid.append(h('div', { class: 'comp-corner' }, h('span', {}, 'X: row'), h('span', {}, 'Y: column')));
    this.names.forEach(nm => grid.append(h('div', { class: 'comp-colhead', title: nm }, label(nm))));
    this.names.forEach((ri, i) => {
      grid.append(h('div', { class: 'comp-rowhead', title: ri }, label(ri)));
      this.cells.push(this.names.map((cj, j) => {
        if (i === j) { grid.append(h('div', { class: 'comp-diag', style: `width:${this.size}px;height:${this.size}px` }, label(ri))); return null; }
        const c = h('canvas', { class: 'comp-mini', 'data-i': i, 'data-j': j, title: `${label(ri)} (X) against ${label(cj)} (Y): spillover ${label(ri)} → ${label(cj)}` });
        c.addEventListener('click', () => { this.select(i, j); this.onPick?.(i, j); });
        grid.append(c);
        return c;
      }));
    });
    this.focus = h('canvas', { class: 'comp-focus' });
    this.focusInfo = h('div', { class: 'hint' });
    this.el = h('div', { class: 'comp-preview' }, h('div', { class: 'comp-grid-wrap' }, grid));
    this.focusEl = h('div', { class: 'comp-focus-wrap' }, this.focus, this.focusInfo);
    this.prepare();
  }

  // Size the small plots to the width available (call once the grid is on the page)
  fit(width) {
    const n = this.names.length, head = 116;
    const size = Math.max(46, Math.min(104, Math.floor((width - head) / n) - 3));
    if (size === this.size) return;
    this.size = size;
    this.grid.style.gridTemplateColumns = `auto repeat(${n}, ${size}px)`;
    for (const d of this.grid.querySelectorAll('.comp-diag')) { d.style.width = size + 'px'; d.style.height = size + 'px'; }
    if (this.u) this.cells.forEach((row, i) => row.forEach((c, j) => this._cell(i, j)));
  }

  // events to show (a subsample of the chosen population); recomputed when sample/population/limit change
  prepare() {
    this.uRaw = null;
    const pop = this.ws.engine.population(this.sample, this.pop && this.ws.engine.get(this.pop) ? this.pop : null);
    this.idx = subsampleIdx(pop.idx, this.maxEvents);
    this.popCount = pop.count;
    this.cfg = this.names.map(nm => this.ws.getCfg(nm));
    this.tf = this.cfg.map(c => makeTransform(c));
    this.zero = this.tf.map(t => t.fwd(0));
  }

  // Redraw everything with the current matrix (batched to one redraw per frame while typing).
  update() {
    if (this._raf) return;
    const run = () => { this._raf = null; this._draw(); };
    this._raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 0);
  }
  updateNow() { if (this._raf) { cancelAnimationFrame?.(this._raf); this._raf = null; } this._draw(); }

  get overlaying() { return this.overlay && this.view !== 'raw'; }

  _units(vals) { return vals.map((col, j) => { const t = this.tf[j], u = new Float32Array(col.length); for (let k = 0; k < col.length; k++) u[k] = t.fwd(col[k]); return u; }); }

  _draw() {
    try { this.u = this._units(compensateSubset(this.sample, this.names, this.matrix, this.idx, { raw: this.view === 'raw' })); } catch (err) {
      // e.g. a value typed that makes the matrix singular: keep the last good plots and say why
      this.focusInfo.textContent = 'This matrix cannot be inverted (two rows are proportional, or a diagonal value is 0), so it cannot be previewed or applied.';
      return;
    }
    // uncompensated values do not depend on the matrix: computed once per sample/population
    if (this.overlaying && (!this.uRaw || this._rawIdx !== this.idx)) {
      this.uRaw = this._units(compensateSubset(this.sample, this.names, this.matrix, this.idx, { raw: true }));
      this._rawIdx = this.idx;
    }
    this.cells.forEach((row, i) => row.forEach((c, j) => this._cell(i, j)));
    this._drawFocus();
  }

  _cell(i, j) {
    const c = this.cells[i]?.[j];
    if (!c || !this.u) return;
    const theme = this.theme || THEMES.dark, sel = !!this.sel && this.sel[0] === i && this.sel[1] === j;
    if (!this.overlaying) return drawMini(c, this.u[i], this.u[j], this.size, theme, [this.zero[i], this.zero[j]], sel);
    const mode = theme.name === 'dark' ? 'dark' : 'light';
    drawMiniOverlay(c, [
      { ux: this.uRaw[i], uy: this.uRaw[j], color: OVERLAY_COLORS.raw[mode], alpha: 0.55 },
      { ux: this.u[i], uy: this.u[j], color: OVERLAY_COLORS.comp[mode], alpha: 0.8 },
    ], this.size, theme, [this.zero[i], this.zero[j]], sel);
  }

  select(i, j) {
    const prev = this.sel; this.sel = [i, j];
    for (const [a, b] of [prev, this.sel].filter(Boolean)) this._cell(a, b);
    this._drawFocus();
  }

  _drawFocus() {
    if (!this.u) return;
    const [i, j] = this.sel || [0, 1 % this.names.length];
    const theme = this.theme || THEMES.dark;
    const idx = new Int32Array(this.idx.length).map((_, k) => k);
    const lab = nm => this.ws.channelLabel(nm);
    const spec = {
      w: 300, h: 280, theme, kind: 'pseudo',
      title: `${lab(this.names[i])} → ${lab(this.names[j])}${this.view === 'raw' ? ' (uncompensated)' : ''}`,
      x: { name: this.names[i], label: lab(this.names[i]), cfg: this.cfg[i] },
      y: { name: this.names[j], label: lab(this.names[j]), cfg: this.cfg[j] },
      series: [{ ux: this.u[i], uy: this.u[j], idx, fullIdx: idx }], gates: [],
    };
    if (this.overlaying) {
      const mode = theme.name === 'dark' ? 'dark' : 'light';
      Object.assign(spec, { kind: 'dot', dotSize: 1.2, labels: { mode: 'inside' }, series: [
        { ux: this.uRaw[i], uy: this.uRaw[j], idx, color: OVERLAY_COLORS.raw[mode], label: 'Uncompensated' },
        { ux: this.u[i], uy: this.u[j], idx, color: OVERLAY_COLORS.comp[mode], label: 'Compensated' },
      ] });
    }
    const ctx = prepareCanvas(this.focus, spec.w, spec.h);
    renderPlot(ctx, spec);
    const v = this.matrix[i][j];
    this.focusInfo.textContent = `Value ${lab(this.names[i])} → ${lab(this.names[j])}: ${+v.toFixed(5)} (${+(v * 100).toFixed(3)}%). `
      + `${this.idx.length.toLocaleString()} of ${this.popCount.toLocaleString()} events shown.`;
  }
}
