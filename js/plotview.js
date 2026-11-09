// Interactive plot (gating) component.
import { renderPlot, prepareCanvas, gateGeometry, MARGIN, THEMES, normalizeKind } from './render.js';
import { makeTransform } from './transforms.js';
import { populationStats, pointInPolygon } from './gates.js';

export const fmtPct = v => (Number.isFinite(v) ? (v >= 10 ? v.toFixed(1) : v.toFixed(2)) + '%' : '–');

// Short marker name for a channel ("CD4" rather than "PE-A")
export function shortLabel(sample, ch) {
  const p = sample?.params[sample.channelIndex(ch)];
  return (p && p.label) || ch;
}

export const PLOT_SIZES = { S: [300, 280], M: [370, 340], L: [470, 430], XL: [580, 530] };
export const EVENT_LIMITS = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 0]; // 0 = all

// Deterministic subsample: an event is shown if its hash falls below a threshold, so a child
// population always displays a subset of the events shown for its parent.
function hash32(i) {
  let h = (i + 0x9e3779b9) | 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
const subCache = new WeakMap();
export function subsampleIdx(idx, max) {
  if (!max || idx.length <= max) return idx;
  let m = subCache.get(idx);
  if (!m) { m = new Map(); subCache.set(idx, m); }
  if (m.has(max)) return m.get(max);
  const thr = (max / idx.length) * 4294967296;
  const out = [];
  for (let k = 0; k < idx.length; k++) if (hash32(idx[k]) < thr) out.push(idx[k]);
  const arr = Uint32Array.from(out);
  m.set(max, arr);
  return arr;
}

export function buildSpec(ws, sample, def, w, h, opts = {}) {
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
    .filter(g => (isHist ? g.type === 'interval' && g.x === x : g.type !== 'interval' && g.x === x && g.y === y))
    .map(g => {
      const st = populationStats(eng, sample, g.id);
      return {
        gate: g, color: g.color,
        text: opts.compactLabels ? fmtPct(st.pctParent) : `${g.name}  ${fmtPct(st.pctParent)}`,
        selected: !!sel && (sel.id === g.id || (g.group && sel.group === g.group)),
      };
    });
  const popName = popId ? eng.get(popId).name : 'All Events';
  const shown = idx.length < pop.count && kind !== 'smooth' ? ` · showing ${idx.length.toLocaleString()}` : '';
  return {
    w, h, theme, kind,
    title: opts.title ?? `${sample.name} · ${popName} (${pop.count.toLocaleString()}${shown})`,
    x: { name: x, label: sample.label(x), cfg: cfgX },
    y: y ? { name: y, label: sample.label(y), cfg: cfgY } : null,
    series, gates,
    hist: { mode: 'count', smooth: def.smooth !== false, fill: true },
    contour: { step: def.contourStep || 0.1, outliers: def.outliers !== false },
    dotSize: def.dotSize,
  };
}

const HANDLE = 6;

export class PlotView {
  constructor(app, def, canvas) {
    Object.assign(this, { app, def, canvas });
    this.drawing = null; this.drag = null; this.spec = null; this.L = null;
    canvas.addEventListener('mousedown', e => this.onDown(e));
    canvas.addEventListener('dblclick', e => this.onDbl(e));
    this._move = e => this.onMove(e);
    this._up = e => this.onUp(e);
    canvas.addEventListener('mousemove', e => { if (!this.drag && !this.drawing) this.hover(e); else if (this.drawing?.type === 'polygon') this.onMove(e); });
    canvas.addEventListener('contextmenu', e => { if (this.drawing) { e.preventDefault(); this.drawing = null; this.draw(); } });
  }

  get w() { return (PLOT_SIZES[this.def.size] || PLOT_SIZES.M)[0]; }
  get h() { return (PLOT_SIZES[this.def.size] || PLOT_SIZES.M)[1]; }
  sample() { return this.app.activeSample(); }

  draw() {
    const s = this.sample();
    const theme = THEMES[this.app.theme] || THEMES.light;
    this.spec = buildSpec(this.app.ws, s, this.def, this.w, this.h, { theme, selectedGate: this.app.ws.selectedGate });
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

  drawInProgress(ctx) {
    const d = this.drawing; if (!d) return;
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
    } else if (d.type === 'interval' && d.cur) {
      const y = L.uy2px(d.start[1]);
      ctx.beginPath(); ctx.moveTo(L.ux2px(d.start[0]), y); ctx.lineTo(L.ux2px(d.cur[0]), y); ctx.stroke();
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
      } else if (geo.kind === 'quad') {
        if (Math.abs(geo.cx - px) <= HANDLE + 2 && Math.abs(geo.cy - py) <= HANDLE + 2) return { gate: it.gate, mode: 'quad' };
      } else if (geo.kind === 'interval') {
        if (Math.abs(clampX(geo.x0) - px) <= HANDLE && Math.abs(geo.y - py) <= 10) return { gate: it.gate, mode: 'iv0' };
        if (Math.abs(clampX(geo.x1) - px) <= HANDLE && Math.abs(geo.y - py) <= 10) return { gate: it.gate, mode: 'iv1' };
      }
    }
    for (const it of items) {
      const geo = gateGeometry(this.L, this.spec, it.gate);
      if (geo.kind === 'poly' && pointInPolygon(px, py, geo.pts)) return { gate: it.gate, mode: 'move' };
      if (geo.kind === 'interval' && px >= Math.min(geo.x0, geo.x1) && px <= Math.max(geo.x0, geo.x1) && Math.abs(py - geo.y) <= 8) return { gate: it.gate, mode: 'move' };
      if (geo.kind === 'quad' && (Math.abs(geo.cx - px) <= 4 || Math.abs(geo.cy - py) <= 4)) return { gate: it.gate, mode: 'quad' };
    }
    for (const it of items) {
      const g = it.gate; if (g.type !== 'quad') continue;
      const geo = gateGeometry(this.L, this.spec, g);
      const q = (py < geo.cy ? 'U' : 'L') + (px < geo.cx ? 'L' : 'R');
      if (q === g.q && this.inPlot(px, py)) return { gate: g, mode: 'select' };
    }
    return null;
  }

  hover(e) {
    if (!this.L) return;
    const { px, py } = this.evtUnit(e);
    if (this.axisAt(px, py)) { this.canvas.style.cursor = 'pointer'; this.canvas.title = 'Click for this axis: channel and scale'; return; }
    this.canvas.title = '';
    if (this.app.tool !== 'select') { this.canvas.style.cursor = 'crosshair'; return; }
    const h = this.hitTest(px, py);
    this.canvas.style.cursor = !h ? 'default' : h.mode === 'move' || h.mode === 'label' ? 'move' : h.mode === 'select' ? 'pointer' : 'crosshair';
  }

  onDown(e) {
    if (e.button !== 0) return;
    if (!this.spec) { this.app.plotClicked(this.def.id, e); return; }
    const { px, py, u } = this.evtUnit(e);
    const axis = this.axisAt(px, py);
    if (axis && !this.drawing) { this.app.plotClicked(this.def.id, e, { keepSelection: true }); this.app.axisMenu(this.def, axis, e.clientX, e.clientY); return; }
    const tool = this.app.tool;
    const isHist = !this.def.y;
    if (tool === 'select') {
      const h = this.hitTest(px, py);
      if (!h) { this.app.plotClicked(this.def.id, e); this.app.selectGate(null); return; }
      this.app.plotClicked(this.def.id, e, { keepSelection: true });
      this.app.selectGate(h.gate.id, { quiet: true });
      if (h.mode === 'select') { this.app.redrawAll(); return; }
      this.drag = { ...h, orig: JSON.parse(JSON.stringify(h.gate)), start: u, startPx: [px, py], moved: false };
      this.draw();
      window.addEventListener('mousemove', this._move); window.addEventListener('mouseup', this._up);
      return;
    }
    this.app.plotClicked(this.def.id, e, { keepSelection: true });
    if (!this.inPlot(px, py)) return;
    if (tool === 'interval') {
      if (!isHist) return this.app.toast('Range gates are drawn on histograms. Set Y to “Histogram”.');
      this.drawing = { type: 'interval', start: u, cur: null };
    } else if (isHist) {
      return this.app.toast('Use the Range tool on histograms.');
    } else if (tool === 'quad') {
      this.app.createQuadrant(this.def, this.toData(u));
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
    window.addEventListener('mousemove', this._move); window.addEventListener('mouseup', this._up);
  }

  onMove(e) {
    const { px, py, u } = this.evtUnit(e);
    if (this.drawing) { this.drawing.cur = u; this.quickDraw(); return; }
    if (!this.drag) return;
    const d = this.drag;
    if (Math.abs(px - d.startPx[0]) + Math.abs(py - d.startPx[1]) > 2) d.moved = true;
    if (!d.moved) return;
    const g = this.app.ws.engine.get(d.gate.id);
    if (d.mode === 'label') {
      // keep the grab offset; store the label centre in plot units
      const cxp = d.box.cx + (px - d.startPx[0]), cyp = d.box.cy + (py - d.startPx[1]);
      g.labelPos = [Math.min(1, Math.max(0, this.L.px2ux(cxp))), Math.min(1, Math.max(0, this.L.px2uy(cyp)))];
      this.draw();
      return;
    }
    const du = [u[0] - d.start[0], u[1] - d.start[1]];
    const tx = makeTransform(this.app.ws.getCfg(g.x));
    const ty = g.y ? makeTransform(this.app.ws.getCfg(g.y)) : null;
    const o = d.orig;
    const mvX = v => tx.inv(tx.fwd(v) + du[0]);
    const mvY = v => ty.inv(ty.fwd(v) + du[1]);
    const mvLabel = () => { if (o.labelPos) g.labelPos = [o.labelPos[0] + du[0], o.labelPos[1] + du[1]].map(v => Math.min(1, Math.max(0, v))); };
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
    } else if (g.type === 'quad') {
      const cx = tx.inv(u[0]), cy = ty.inv(u[1]);
      for (const q of this.app.ws.engine.list()) if (q.group === g.group) { q.cx = cx; q.cy = cy; }
    } else if (g.type === 'interval') {
      if (d.mode === 'iv0') g.x0 = tx.inv(snapUnit(u)[0]);
      else if (d.mode === 'iv1') g.x1 = tx.inv(snapUnit(u)[0]);
      else { g.x0 = mvX(o.x0); g.x1 = mvX(o.x1); g.level = Math.min(0.97, Math.max(0.05, (o.level ?? 0.85) + du[1])); mvLabel(); }
    }
    this.app.gateChanged(g, { live: true });
    this.draw();
  }

  onUp() {
    window.removeEventListener('mousemove', this._move); window.removeEventListener('mouseup', this._up);
    if (this.drawing && this.drawing.type !== 'polygon') {
      const d = this.drawing; this.drawing = null;
      if (!d.cur) { this.draw(); return; }
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

  cancel() { if (this.drawing) { this.drawing = null; this.draw(); } }

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
