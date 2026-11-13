// Interactive plot (gating) component.
import { renderPlot, prepareCanvas, gateGeometry, MARGIN, THEMES, SERIES_COLORS, normalizeKind } from './render.js';
import { makeTransform } from './transforms.js';
import { trackDrag } from './ui.js';
import { densityGrid, autoGatePolygon } from './autogate.js';
import { populationStats, pointInPolygon, gateFor, isCustom, isOneD, quadArms, quadRegion, quadMode, ARMS, DEFAULT_ANGLES } from './gates.js';

export const fmtPct = v => (Number.isFinite(v) ? (v >= 10 ? v.toFixed(1) : v.toFixed(2)) + '%' : '–');

// Short marker name for a channel ("CD4" rather than "PE-A")
export function shortLabel(sample, ch) {
  const p = sample?.params[sample.channelIndex(ch)];
  return (p && p.label) || ch;
}

export const PLOT_SIZES = { S: [300, 280], M: [370, 340], L: [470, 430], XL: [580, 530] };
export const EVENT_LIMITS = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 0]; // 0 = all

// Deterministic subsample: each event has a fixed pseudo-random rank (a hash of its index); a plot
// shows the `max` events of its population with the lowest ranks, so the same events are shown every
// time and the events shown for a population and its parent largely coincide.
function hash32(i) {
  let h = (i + 0x9e3779b9) | 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
const subCache = new WeakMap();
export function subsampleIdx(idx, max) {
  max = Math.floor(max);
  if (!max || idx.length <= max) return idx;
  let m = subCache.get(idx);
  if (!m) { m = new Map(); subCache.set(idx, m); }
  if (m.has(max)) return m.get(max);
  // exactly `max` events: those with the smallest hash values (a fixed pseudo-random choice, so
  // the same events are shown every time), kept in their original order
  let f = 1.08, cand;
  for (;;) {
    const thr = Math.min(1, (max / idx.length) * f) * 4294967296;
    cand = [];
    for (let k = 0; k < idx.length; k++) { const hv = hash32(idx[k]); if (hv < thr) cand.push([hv, idx[k]]); }
    if (cand.length >= max) break;
    f *= 1.5;
  }
  if (cand.length > max) { cand.sort((a, b) => a[0] - b[0]); cand.length = max; }
  const arr = Uint32Array.from(cand.map(c => c[1])).sort();
  m.set(max, arr);
  return arr;
}

// Quadrants are labelled Q1-Q4 in plots (Q1 upper left, then clockwise) so the % stays visible;
// the full names are in the gate tree and statistics.
export const QUAD_NUM = { UL: 'Q1', UR: 'Q2', LR: 'Q3', LL: 'Q4' };
export const plotGateName = g => (g.type === 'quad' && QUAD_NUM[g.q]) || g.name;

// A plot's zoom is stored in data values ({ x: [lo, hi], y: [lo, hi] | null }) so it survives scale
// changes; the renderer needs it in scale units.
export function zoomUnits(ws, def) {
  const z = def.zoom;
  if (!z) return null;
  const tx = makeTransform(ws.getCfg(def.x)), ty = def.y ? makeTransform(ws.getCfg(def.y)) : null;
  const u = (t, r) => (r && t ? r.map(v => t.fwd(v)).sort((a, b) => a - b) : null);
  const out = { x: u(tx, z.x), y: def.y ? u(ty, z.y) : null };
  return out.x || out.y ? out : null;
}

// Colour of a sample in a quick overlay (same in the plots and the sample list)
export const overlayColor = i => SERIES_COLORS[i % SERIES_COLORS.length];

export function buildSpec(ws, sample, def, w, h, opts = {}) {
  if (opts.overlay && opts.overlay.length > 1) return buildOverlaySpec(ws, opts.overlay, def, w, h, opts);
  const x = def.x, y = def.y || null;
  if (!sample || !x || !sample.hasChannel(x) || (y && !sample.hasChannel(y))) return null;
  const eng = ws.engine;
  const popId = def.pop && eng.get(def.pop) ? def.pop : null;
  const pop = eng.population(sample, popId);
  const cfgX = ws.getCfg(x), cfgY = y ? ws.getCfg(y) : null;
  const isHist = !y;
  const theme = opts.theme || THEMES.light;
  const max = isHist ? 0 : (def.maxEvents ?? ws.displayMax ?? 0);
  const idx = isHist ? pop.idx : subsampleIdx(pop.idx, max);
  const kind = isHist ? 'histogram' : normalizeKind(def.kind);
  const series = [{ ux: sample.unit(x, cfgX), uy: y ? sample.unit(y, cfgY) : null, idx, fullIdx: pop.idx, color: isHist ? theme.hist : null }];
  const sel = opts.selectedGate ? eng.get(opts.selectedGate) : null;
  const gates = opts.noGates ? [] : eng.children(popId)
    .filter(g => !opts.onlyGates || opts.onlyGates.has(g.id))
    .filter(g => (isHist ? isOneD(g) && g.x === x : !isOneD(g) && g.x === x && g.y === y))
    .map(g => {
      const st = populationStats(eng, sample, g.id);
      const custom = isCustom(g, sample); // this sample has its own version of the gate
      const mark = custom ? '✎' : '';
      return {
        gate: gateFor(g, sample), color: g.color, custom,
        text: opts.compactLabels ? `${mark}${fmtPct(st.pctParent)}` : `${plotGateName(g)}${mark}  ${fmtPct(st.pctParent)}`,
        selected: !!sel && (sel.id === g.id || (g.group && sel.group === g.group)),
      };
    });
  const popName = popId ? eng.get(popId).name : 'All Events';
  const shown = idx.length < pop.count && kind !== 'smooth' ? ` · showing ${idx.length.toLocaleString()}` : '';
  return {
    w, h, theme, kind,
    // the counts go in titleTail so a long name is shortened, never the numbers
    title: opts.title ?? `${sample.name} · ${popName}`,
    titleTail: opts.title ? '' : ` (${pop.count.toLocaleString()}${shown})${def.zoom ? ' · zoomed' : ''}`,
    zoom: zoomUnits(ws, def),
    x: { name: x, label: sample.label(x), cfg: cfgX },
    y: y ? { name: y, label: sample.label(y), cfg: cfgY } : null,
    series, gates,
    hist: { mode: 'count', smooth: def.smooth !== false, fill: true },
    contour: { step: def.contourStep || 0.1, outliers: def.outliers !== false },
    dotSize: def.dotSize,
  };
}

// Quick overlay of several samples in a gating plot: one coloured series per sample
// (dots for 2-D plots, histograms normalised to mode); gate labels list every sample's %.
function buildOverlaySpec(ws, samples, def, w, h, opts) {
  const x = def.x, y = def.y || null;
  const isHist = !y;
  const eng = ws.engine;
  const popId = def.pop && eng.get(def.pop) ? def.pop : null;
  const list = samples.map((s, i) => ({ s, color: overlayColor(i) })).filter(({ s }) => x && s.hasChannel(x) && (!y || s.hasChannel(y)));
  if (!list.length) return null;
  const cfgX = ws.getCfg(x), cfgY = y ? ws.getCfg(y) : null;
  const max = isHist ? 0 : (def.maxEvents ?? ws.displayMax ?? 0);
  const name = s => s.name.replace(/\.fcs$/i, '');
  const series = list.map(({ s, color }) => {
    const pop = eng.population(s, popId);
    return { ux: s.unit(x, cfgX), uy: y ? s.unit(y, cfgY) : null, idx: isHist ? pop.idx : subsampleIdx(pop.idx, max), fullIdx: pop.idx, color, label: name(s) };
  });
  const sel = opts.selectedGate ? eng.get(opts.selectedGate) : null;
  const gates = opts.noGates ? [] : eng.children(popId)
    .filter(g => (isHist ? isOneD(g) && g.x === x : !isOneD(g) && g.x === x && g.y === y))
    .map(g => ({
      gate: g, color: g.color, text: plotGateName(g),
      lines: [{ text: plotGateName(g), color: g.color }, ...list.map(({ s, color }) => ({ text: `${name(s)}${isCustom(g, s) ? ' ✎' : ''}  ${fmtPct(populationStats(eng, s, g.id).pctParent)}`, color }))],
      selected: !!sel && (sel.id === g.id || (g.group && sel.group === g.group)),
    }));
  const first = list[0].s;
  return {
    w, h, theme: opts.theme || THEMES.light, kind: isHist ? 'histogram' : 'dot',
    title: opts.title ?? `Overlay of ${list.length} samples · ${popId ? eng.get(popId).name : 'All Events'}${def.zoom ? ' · zoomed' : ''}`,
    zoom: zoomUnits(ws, def),
    x: { name: x, label: first.label(x), cfg: cfgX },
    y: y ? { name: y, label: first.label(y), cfg: cfgY } : null,
    series, gates, labels: { mode: 'inside' },
    hist: { mode: 'mode', smooth: def.smooth !== false, fill: true },
    dotSize: def.dotSize,
  };
}

const HANDLE = 6;

// Angle (degrees) for a spider arm dragged towards `want`, kept between its clockwise neighbour `cw`
// and anticlockwise neighbour `acw` (5° clear of each); beyond either end it stops at the nearer end.
export function clampArmAngle(want, cw, acw) {
  const norm = v => ((v % 360) + 360) % 360;
  const span = norm(acw - cw) || 360, rel = norm(want - cw);
  const r = rel > span ? (rel - span < 360 - rel ? span - 5 : 5) : Math.min(span - 5, Math.max(5, rel));
  return norm(cw + r);
}

function distToPolyline(px, py, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return best;
}

export class PlotView {
  constructor(app, def, canvas) {
    Object.assign(this, { app, def, canvas });
    this.drawing = null; this.drag = null; this.spec = null; this.L = null;
    canvas.addEventListener('mousedown', e => this.onDown(e));
    canvas.addEventListener('dblclick', e => this.onDbl(e));
    this._move = e => this.onMove(e);
    this._up = e => this.onUp(e);
    canvas.addEventListener('mousemove', e => { if (!this.drag && !this.drawing) this.hover(e); else if (this.drawing?.type === 'polygon') this.onMove(e); });
    canvas.addEventListener('mouseleave', () => { if (this.preview) { this.preview = null; this.quickDraw(); } });
    canvas.addEventListener('contextmenu', e => { if (this.drawing) { e.preventDefault(); this.drawing = null; this.draw(); } });
  }

  get w() { return (PLOT_SIZES[this.def.size] || PLOT_SIZES.M)[0]; }
  get h() { return (PLOT_SIZES[this.def.size] || PLOT_SIZES.M)[1]; }
  sample() { return this.app.activeSample(); }

  draw() {
    const s = this.sample();
    const theme = THEMES[this.app.theme] || THEMES.light;
    this.spec = buildSpec(this.app.ws, s, this.def, this.w, this.h, { theme, selectedGate: this.app.ws.selectedGate, overlay: this.app.overlaySamples() });
    const ctx = prepareCanvas(this.canvas, this.w, this.h);
    if (!this.spec) {
      ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, this.w, this.h);
      ctx.fillStyle = theme.muted; ctx.font = '12px system-ui'; ctx.textAlign = 'center';
      const missing = s ? [this.def.x, this.def.y].filter(c => c && !s.hasChannel(c)) : [];
      ctx.fillText(s ? `${missing.join(', ')} not in ${s.name}` : 'No sample loaded', this.w / 2, this.h / 2 - 8);
      if (s) ctx.fillText('(different instrument/panel?) Pick axes above.', this.w / 2, this.h / 2 + 10);
      this.L = null;
      return;
    }
    this.L = renderPlot(ctx, this.spec);
    this.bg = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.drawInProgress(ctx);
  }

  // Fast redraw while drawing a new gate: reuse the rendered plot bitmap.
  quickDraw() {
    if (!this.bg) return this.draw();
    const ctx = this.canvas.getContext('2d');
    ctx.putImageData(this.bg, 0, 0);
    this.drawInProgress(ctx);
  }

  // Where a Quadrant, Split or Range gate would go, following the cursor before clicking
  previewType() {
    const t = this.app.tool, hist = this.def && !this.def.y;
    return ((t === 'quad' || t === 'auto') && !hist) || ((t === 'split' || t === 'interval') && hist) ? t : null;
  }

  drawPreview(ctx) {
    const p = this.preview, L = this.L;
    if (!p || !L || p.type !== this.previewType()) return;
    const [x, y] = [L.ux2px(p.u[0]), L.uy2px(p.u[1])];
    ctx.save();
    ctx.beginPath(); ctx.rect(MARGIN.l, MARGIN.t, L.pw, L.ph); ctx.clip();
    ctx.strokeStyle = this.app.theme === 'dark' ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.7)';
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (p.type === 'auto') {
      if (p.poly) { p.poly.forEach(([u, v], i) => (i ? ctx.lineTo(L.ux2px(u), L.uy2px(v)) : ctx.moveTo(L.ux2px(u), L.uy2px(v)))); ctx.closePath(); }
      else { ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); }
    } else if (p.type === 'quad') { ctx.moveTo(x, MARGIN.t); ctx.lineTo(x, MARGIN.t + L.ph); ctx.moveTo(MARGIN.l, y); ctx.lineTo(MARGIN.l + L.pw, y); }
    else if (p.type === 'split') { ctx.moveTo(x, MARGIN.t); ctx.lineTo(x, MARGIN.t + L.ph); }
    else { ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8); ctx.moveTo(x, y); ctx.lineTo(x + 14, y); } // range: its start
    ctx.stroke();
    ctx.restore();
  }

  drawInProgress(ctx) {
    const d = this.drawing;
    if (!d) return this.drawPreview(ctx);
    const L = this.L;
    ctx.save();
    ctx.strokeStyle = this.app.theme === 'dark' ? '#fff' : '#000'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.3;
    if (d.type === 'polygon') {
      ctx.beginPath();
      d.pts.forEach(([u, v], i) => (i ? ctx.lineTo(L.ux2px(u), L.uy2px(v)) : ctx.moveTo(L.ux2px(u), L.uy2px(v))));
      if (d.cur) ctx.lineTo(L.ux2px(d.cur[0]), L.uy2px(d.cur[1]));
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      d.pts.forEach(([u, v]) => ctx.fillRect(L.ux2px(u) - 2.5, L.uy2px(v) - 2.5, 5, 5));
    } else if (d.type === 'rect' && d.cur) {
      const [a, b] = [d.start, d.cur];
      ctx.strokeRect(L.ux2px(a[0]), L.uy2px(a[1]), L.ux2px(b[0]) - L.ux2px(a[0]), L.uy2px(b[1]) - L.uy2px(a[1]));
    } else if (d.type === 'ellipse' && d.cur) {
      const pts = ellipsePts(d.start, d.cur);
      ctx.beginPath(); pts.forEach(([u, v], i) => (i ? ctx.lineTo(L.ux2px(u), L.uy2px(v)) : ctx.moveTo(L.ux2px(u), L.uy2px(v)))); ctx.closePath(); ctx.stroke();
    } else if (d.type === 'zoom' && d.cur) {
      ctx.setLineDash([3, 3]);
      ctx.fillStyle = 'rgba(59,130,246,0.15)';
      const x0 = L.ux2px(d.start[0]), x1 = L.ux2px(d.cur[0]);
      const y0 = this.def.y ? L.uy2px(d.start[1]) : MARGIN.t, y1 = this.def.y ? L.uy2px(d.cur[1]) : MARGIN.t + L.ph;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0); ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    } else if (d.type === 'interval' && d.cur) {
      const y = L.uy2px(d.start[1]), x0 = L.ux2px(d.start[0]), x1 = L.ux2px(d.cur[0]);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y);
      ctx.moveTo(x0, y - 8); ctx.lineTo(x0, y + 8); ctx.moveTo(x1, y - 8); ctx.lineTo(x1, y + 8); ctx.stroke();
    }
    ctx.restore();
  }

  evtUnit(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    return { px, py, u: this.L ? [this.L.px2ux(px), this.L.px2uy(py)] : [0, 0] };
  }

  inPlot(px, py) { return px >= MARGIN.l && px <= MARGIN.l + this.L.pw && py >= MARGIN.t && py <= MARGIN.t + this.L.ph; }

  // Which axis (if any) a point is on: below the plot = X, left of it = Y
  axisAt(px, py) {
    if (!this.L) return null;
    if (py > MARGIN.t + this.L.ph + 2 && px >= MARGIN.l && px <= MARGIN.l + this.L.pw) return 'x';
    if (px < MARGIN.l - 2 && py >= MARGIN.t && py <= MARGIN.t + this.L.ph) return 'y';
    return null;
  }

  // ---- hit testing on existing gates ----
  hitTest(px, py) {
    if (!this.spec) return null;
    const clampX = x => Math.min(MARGIN.l + this.L.pw, Math.max(MARGIN.l, x));
    const clampY = y => Math.min(MARGIN.t + this.L.ph, Math.max(MARGIN.t, y));
    const items = [...this.spec.gates].sort((a, b) => b.selected - a.selected);
    // labels first: they sit on top
    for (const it of items) {
      const b = it.labelBox;
      if (b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return { gate: it.gate, mode: 'label', box: b };
    }
    for (const it of items) {
      const geo = gateGeometry(this.L, this.spec, it.gate);
      if (geo.kind === 'poly') {
        for (let i = 0; i < geo.pts.length; i++) {
          const [x, y] = geo.pts[i];
          if (Math.abs(clampX(x) - px) <= HANDLE && Math.abs(clampY(y) - py) <= HANDLE) return { gate: it.gate, mode: 'vertex', index: i };
        }
      } else if (geo.kind === 'split') {
        if (Math.abs(geo.cx - px) <= HANDLE && this.inPlot(px, py)) return { gate: it.gate, mode: 'split' };
      } else if (geo.kind === 'quad') {
        if (Math.abs(geo.cx - px) <= HANDLE + 2 && Math.abs(geo.cy - py) <= HANDLE + 2) return { gate: it.gate, mode: 'quad' };
        if (it.selected) for (const k in geo.handles) {
          const [hx, hy] = geo.handles[k];
          if (Math.hypot(hx - px, hy - py) <= HANDLE + 1) return { gate: it.gate, mode: 'arm', arm: k };
        }
      } else if (geo.kind === 'interval') {
        if (Math.abs(clampX(geo.x0) - px) <= HANDLE && Math.abs(geo.y - py) <= 10) return { gate: it.gate, mode: 'iv0' };
        if (Math.abs(clampX(geo.x1) - px) <= HANDLE && Math.abs(geo.y - py) <= 10) return { gate: it.gate, mode: 'iv1' };
      }
    }
    for (const it of items) {
      const geo = gateGeometry(this.L, this.spec, it.gate);
      if (geo.kind === 'poly' && pointInPolygon(px, py, geo.pts)) return { gate: it.gate, mode: 'move' };
      if (geo.kind === 'interval' && px >= Math.min(geo.x0, geo.x1) && px <= Math.max(geo.x0, geo.x1) && Math.abs(py - geo.y) <= 8) return { gate: it.gate, mode: 'move' };
      if (geo.kind === 'quad' && this.inPlot(px, py) && Object.values(geo.arms).some(a => distToPolyline(px, py, a) <= 4)) return { gate: it.gate, mode: 'quad' };
    }
    for (const it of items) { // clicking on one side of a split selects that side
      const g = it.gate; if (g.type !== 'split' || !this.inPlot(px, py)) continue;
      const geo = gateGeometry(this.L, this.spec, g);
      if ((px < geo.cx) === (g.side === 'L')) return { gate: g, mode: 'select' };
    }
    for (const it of items) {
      const g = it.gate; if (g.type !== 'quad') continue;
      if (!this.inPlot(px, py)) continue;
      const tx = makeTransform(this.spec.x.cfg), ty = makeTransform(this.spec.y.cfg);
      if (pointInPolygon(this.L.px2ux(px), this.L.px2uy(py), quadRegion(quadArms(g, tx, ty), g.q))) return { gate: g, mode: 'select' };
    }
    return null;
  }

  hover(e) {
    if (!this.L) return;
    const { px, py } = this.evtUnit(e);
    if (this.axisAt(px, py)) { this.canvas.style.cursor = 'pointer'; this.canvas.title = 'Click for this axis: channel and scale'; return; }
    this.canvas.title = '';
    if (this.app.tool !== 'select') {
      this.canvas.style.cursor = 'crosshair';
      const t = this.previewType();
      const prev = this.preview;
      this.preview = t && this.inPlot(px, py) ? { type: t, u: this.evtUnit(e).u } : null;
      if (this.preview?.type === 'auto') { // outline of the population under the cursor (once per frame)
        this.preview.tight = e.shiftKey;
        if (!this._autoRaf) this._autoRaf = requestAnimationFrame(() => {
          this._autoRaf = null;
          const p = this.preview; if (p?.type !== 'auto') return;
          p.poly = this.autoPoly(p.u, p.tight); this.quickDraw();
        });
        return;
      }
      if (this.preview || prev) this.quickDraw();
      return;
    }
    const h = this.hitTest(px, py);
    this.canvas.style.cursor = !h ? 'default' : h.mode === 'move' || h.mode === 'label' ? 'move' : h.mode === 'split' ? 'ew-resize' : h.mode === 'select' ? 'pointer' : h.mode === 'arm' ? 'grab' : 'crosshair';
  }

  onDown(e) {
    if (e.button !== 0) return;
    if (!this.spec) { this.app.plotClicked(this.def.id, e); return; }
    const { px, py, u } = this.evtUnit(e);
    const axis = this.axisAt(px, py);
    if (axis && !this.drawing) { this.app.plotClicked(this.def.id, e, { keepSelection: true }); this.app.axisMenu(this.def, axis, e.clientX, e.clientY); return; }
    const tool = this.app.tool;
    const isHist = !this.def.y;
    this.preview = null;
    if (tool === 'select') {
      const h = this.hitTest(px, py);
      if (!h) { this.app.plotClicked(this.def.id, e); this.app.selectGate(null); return; }
      this.app.plotClicked(this.def.id, e, { keepSelection: true });
      this.app.selectGate(h.gate.id, { quiet: true });
      if (h.mode === 'select') { this.app.redrawAll(); return; }
      this.drag = { ...h, orig: JSON.parse(JSON.stringify(h.gate)), start: u, startPx: [px, py], moved: false };
      this.draw();
      this._stopDrag = trackDrag(this._move, this._up);
      return;
    }
    this.app.plotClicked(this.def.id, e, { keepSelection: true });
    if (!this.inPlot(px, py)) return;
    if (tool === 'zoom') {
      this.drawing = { type: 'zoom', start: u, cur: null };
    } else if (tool === 'split') {
      if (!isHist) return this.app.toast('Split gates are drawn on histograms. Set Y to “Histogram”.');
      this.app.createSplit(this.def, this.toData(u)[0]);
      return;
    } else if (tool === 'interval') {
      if (!isHist) return this.app.toast('Range gates are drawn on histograms. Set Y to “Histogram”.');
      this.drawing = { type: 'interval', start: u, cur: null };
    } else if (isHist) {
      return this.app.toast('Use the Range or Split tool on histograms.');
    } else if (tool === 'quad') {
      this.app.createQuadrant(this.def, this.toData(u));
      return;
    } else if (tool === 'auto') {
      const poly = this.autoPoly(u, e.shiftKey);
      if (!poly) return this.app.toast('No population found here: click inside a cluster of events.');
      this.app.createGate(this.def, { type: 'polygon', pts: poly.map(p => this.toData(p)) });
      return;
    } else if (tool === 'polygon') {
      if (!this.drawing) this.drawing = { type: 'polygon', pts: [] };
      const pts = this.drawing.pts;
      if (pts.length >= 3) {
        const [fx, fy] = [this.L.ux2px(pts[0][0]), this.L.uy2px(pts[0][1])];
        if (Math.hypot(fx - px, fy - py) < 8) return this.finishPolygon();
      }
      pts.push(snapUnit(u));
      this.quickDraw();
      return;
    } else if (tool === 'rect' || tool === 'ellipse') {
      this.drawing = { type: tool, start: u, cur: null };
    }
    this._stopDrag = trackDrag(this._move, this._up);
  }

  onMove(e) {
    const { px, py, u } = this.evtUnit(e);
    if (this.drawing) { this.drawing.cur = u; this.quickDraw(); return; }
    if (!this.drag) return;
    const d = this.drag;
    if (Math.abs(px - d.startPx[0]) + Math.abs(py - d.startPx[1]) > 2) d.moved = true;
    if (!d.moved) return;
    const base = this.app.ws.engine.get(d.gate.id);
    const perSample = this.app.gateEditMode === 'sample' && this.sample();
    if (d.mode === 'label') {
      const g = base;
      // keep the grab offset; store the label centre in plot units
      const cxp = d.box.cx + (px - d.startPx[0]), cyp = d.box.cy + (py - d.startPx[1]);
      g.labelPos = [Math.min(1, Math.max(0, this.L.px2ux(cxp))), Math.min(1, Math.max(0, this.L.px2uy(cyp)))];
      this.draw();
      return;
    }
    const g = JSON.parse(JSON.stringify(d.orig)); // effective gate for this sample at drag start
    const du = [u[0] - d.start[0], u[1] - d.start[1]];
    const tx = makeTransform(this.app.ws.getCfg(g.x));
    const ty = g.y ? makeTransform(this.app.ws.getCfg(g.y)) : null;
    const o = d.orig;
    const mvX = v => tx.inv(tx.fwd(v) + du[0]);
    const mvY = v => ty.inv(ty.fwd(v) + du[1]);
    const mvLabel = () => { if (o.labelPos && !perSample) base.labelPos = [o.labelPos[0] + du[0], o.labelPos[1] + du[1]].map(v => Math.min(1, Math.max(0, v))); };
    if (g.type === 'polygon') {
      if (d.mode === 'vertex') { const s = snapUnit(u); g.pts[d.index] = [tx.inv(s[0]), ty.inv(s[1])]; }
      else { g.pts = o.pts.map(([x, y]) => [mvX(x), mvY(y)]); mvLabel(); }
    } else if (g.type === 'rect') {
      if (d.mode === 'vertex') {
        const s = snapUnit(u);
        const [vx, vy] = [tx.inv(s[0]), ty.inv(s[1])];
        if (d.index === 0 || d.index === 3) g.x0 = vx; else g.x1 = vx;
        if (d.index === 0 || d.index === 1) g.y0 = vy; else g.y1 = vy;
      } else { g.x0 = mvX(o.x0); g.x1 = mvX(o.x1); g.y0 = mvY(o.y0); g.y1 = mvY(o.y1); mvLabel(); }
    } else if (g.type === 'split') {
      g.cx = tx.inv(u[0]);
    } else if (g.type === 'quad') {
      const m = quadMode(o);
      if (d.mode === 'arm' && m === 'spider') {
        // turn one arm, keeping it between its neighbours so the four quadrants stay in order
        const c = [tx.fwd(o.cx), ty.fwd(o.cy)];
        const a = { ...DEFAULT_ANGLES, ...(o.angles || {}) }, i = ARMS.indexOf(d.arm);
        const cw = a[ARMS[(i + 1) % 4]], acw = a[ARMS[(i + 3) % 4]];
        const want = Math.atan2(u[1] - c[1], u[0] - c[0]) * 180 / Math.PI;
        g.angles = { ...a, [d.arm]: Math.round(clampArmAngle(want, cw, acw) * 10) / 10 };
      } else if (d.mode === 'arm' && m === 'offset') {
        const off = { up: o.cx, down: o.cx, right: o.cy, left: o.cy, ...(o.offsets || {}) };
        const s = snapUnit(u);
        off[d.arm] = d.arm === 'up' || d.arm === 'down' ? tx.inv(s[0]) : ty.inv(s[1]);
        g.offsets = off;
      } else {
        // move by the drag (the quadrant may have been grabbed by an arm, far from its centre)
        g.cx = mvX(o.cx); g.cy = mvY(o.cy);
        if (m === 'offset' && o.offsets) { // the staggered arms move with the centre
          const [dx, dy] = du;
          const ox = v => tx.inv(tx.fwd(v) + dx), oy = v => ty.inv(ty.fwd(v) + dy);
          const f = o.offsets;
          g.offsets = { up: ox(f.up ?? o.cx), down: ox(f.down ?? o.cx), right: oy(f.right ?? o.cy), left: oy(f.left ?? o.cy) };
        }
      }
    } else if (g.type === 'interval') {
      if (d.mode === 'iv0') g.x0 = tx.inv(snapUnit(u)[0]);
      else if (d.mode === 'iv1') g.x1 = tx.inv(snapUnit(u)[0]);
      else { g.x0 = mvX(o.x0); g.x1 = mvX(o.x1); g.level = Math.min(0.97, Math.max(0.05, (o.level ?? 0.85) + du[1])); mvLabel(); }
    }
    this.app.setGateGeometry(base, g, perSample || null);
    this.app.gateChanged(base, { live: true });
    this.draw();
  }

  onUp() {
    this._stopDrag?.(); this._stopDrag = null;
    if (this.drawing && this.drawing.type !== 'polygon') {
      const d = this.drawing; this.drawing = null;
      if (!d.cur) { this.draw(); return; }
      if (d.type === 'zoom') {
        const [ux0, ux1] = [d.start[0], d.cur[0]].sort((p, q) => p - q), [uy0, uy1] = [d.start[1], d.cur[1]].sort((p, q) => p - q);
        const L = this.L, minW = 6 / L.pw * (L.px2ux(MARGIN.l + L.pw) - L.px2ux(MARGIN.l)), minH = 6 / L.ph * (L.px2uy(MARGIN.t) - L.px2uy(MARGIN.t + L.ph));
        if (ux1 - ux0 < minW || (this.def.y && uy1 - uy0 < minH)) { this.draw(); return; } // a click, not a box
        const tx = makeTransform(this.app.ws.getCfg(this.def.x)), ty = this.def.y ? makeTransform(this.app.ws.getCfg(this.def.y)) : null;
        this.app.zoomPlot(this.def, { x: [tx.inv(ux0), tx.inv(ux1)], y: ty ? [ty.inv(uy0), ty.inv(uy1)] : null });
        return;
      }
      const a = snapUnit(d.start), b = snapUnit(d.cur);
      if (Math.abs(a[0] - b[0]) < 0.01 && (d.type === 'interval' || Math.abs(a[1] - b[1]) < 0.01)) { this.draw(); return; }
      if (d.type === 'rect') {
        const [x0, y0] = this.toData([Math.min(a[0], b[0]), Math.min(a[1], b[1])]);
        const [x1, y1] = this.toData([Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
        this.app.createGate(this.def, { type: 'rect', x0, x1, y0, y1 });
      } else if (d.type === 'ellipse') {
        const pts = ellipsePts(d.start, d.cur).map(p => this.toData(p));
        this.app.createGate(this.def, { type: 'polygon', shape: 'ellipse', pts });
      } else if (d.type === 'interval') {
        const tx = makeTransform(this.app.ws.getCfg(this.def.x));
        this.app.createGate(this.def, { type: 'interval', x0: tx.inv(Math.min(a[0], b[0])), x1: tx.inv(Math.max(a[0], b[0])), level: Math.min(0.95, Math.max(0.05, d.start[1])) });
      }
      return;
    }
    if (this.drag) {
      const { moved, mode } = this.drag; this.drag = null;
      if (moved && mode === 'label') this.app.redrawAll();
      else if (moved) this.app.gateChanged(this.app.ws.engine.get(this.app.ws.selectedGate));
      else this.app.redrawAll();
    }
  }

  onDbl(e) {
    if (this.drawing?.type === 'polygon') {
      this.drawing.pts.pop(); // dblclick produced a duplicate point
      return this.finishPolygon();
    }
    if (this.app.tool === 'zoom') { // double-click while zooming = Reset zoom (whole axis range)
      if (this.def.zoom) this.app.resetZoom(this.def);
      return;
    }
    if (this.app.tool !== 'select' || !this.spec) return;
    const { px, py } = this.evtUnit(e);
    const h = this.hitTest(px, py);
    if (h && h.mode === 'label') this.app.renameGate(h.gate);
    else if (h) this.app.drillDown(h.gate, this.def);
  }

  finishPolygon() {
    const pts = this.drawing.pts.filter((p, i, arr) => i === 0 || Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1]) > 1e-4);
    this.drawing = null;
    if (pts.length < 3) { this.draw(); return; }
    this.app.createGate(this.def, { type: 'polygon', pts: pts.map(p => this.toData(p)) });
  }

  // Auto gate around the population at u (display units); tight = closer to the core
  autoPoly(u, tight = false) {
    const s = this.spec?.series?.[0];
    if (!s || !s.uy || this.spec.series.length !== 1) return null;
    const z = this.spec.zoom || {}, box = { x: z.x || [0, 1], y: z.y || [0, 1] };
    const key = [s.ux, s.uy, s.fullIdx || s.idx, box.x.join(), box.y.join()];
    if (!this._dens || this._densKey.some((k, i) => k !== key[i])) { this._dens = densityGrid(s.ux, s.uy, s.fullIdx || s.idx, box); this._densKey = key; }
    return autoGatePolygon(this._dens, u, { level: tight ? 0.25 : 0.08 });
  }

  cancel() { if (this.drawing || this.preview) { this.drawing = null; this.preview = null; this.draw(); } }

  toData([ux, uy]) {
    const tx = makeTransform(this.app.ws.getCfg(this.def.x));
    const ty = this.def.y ? makeTransform(this.app.ws.getCfg(this.def.y)) : null;
    return [tx.inv(ux), ty ? ty.inv(uy) : 0];
  }
}

// Points dragged onto/over the axis edge extend the gate well beyond it so piled-up off-scale events are included.
function snapUnit([u, v]) {
  const s = x => (x <= 0.003 ? -0.3 : x >= 0.997 ? 1.3 : x);
  return [s(u), s(v)];
}

function ellipsePts(a, b, n = 48) {
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, rx = Math.abs(a[0] - b[0]) / 2, ry = Math.abs(a[1] - b[1]) / 2;
  return Array.from({ length: n }, (_, i) => { const t = (i / n) * 2 * Math.PI; return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]; });
}
