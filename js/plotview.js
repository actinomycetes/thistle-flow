// Interactive plot (gating) component.
import { renderPlot, prepareCanvas, layout, gateGeometry, MARGIN } from './render.js';
import { makeTransform } from './transforms.js';
import { populationStats, pointInPolygon } from './gates.js';

export const fmtPct = v => (Number.isFinite(v) ? (v >= 10 ? v.toFixed(1) : v.toFixed(2)) + '%' : '–');

// Short marker name for a channel ("CD4" rather than "PE-A")
export function shortLabel(sample, ch) {
  const p = sample?.params[sample.channelIndex(ch)];
  return (p && p.label) || ch;
}

export function buildSpec(app, sample, def, w, h, opts = {}) {
  const x = def.x, y = def.y || null;
  if (!sample || !x || !sample.hasChannel(x) || (y && !sample.hasChannel(y))) return null;
  const eng = app.engine;
  const pop = eng.population(sample, def.pop || null);
  const cfgX = app.getCfg(x), cfgY = y ? app.getCfg(y) : null;
  const isHist = !y;
  const series = [{ ux: sample.unit(x, cfgX), uy: y ? sample.unit(y, cfgY) : null, idx: pop.idx, color: isHist ? '#4a5568' : '#222' }];
  const sel = app.selectedGate ? eng.get(app.selectedGate) : null;
  const gates = opts.noGates ? [] : eng.children(def.pop || null)
    .filter(g => (isHist ? g.type === 'interval' && g.x === x : g.type !== 'interval' && g.x === x && g.y === y))
    .map(g => {
      const st = populationStats(eng, sample, g.id);
      return {
        gate: g, color: g.color,
        text: opts.compactLabels ? fmtPct(st.pctParent) : `${g.name}  ${fmtPct(st.pctParent)}`,
        selected: !!sel && (sel.id === g.id || (g.group && sel.group === g.group)),
      };
    });
  const popName = def.pop ? eng.get(def.pop)?.name : 'All Events';
  return {
    w, h, kind: isHist ? 'histogram' : (def.kind || 'density'),
    title: opts.title ?? `${sample.name} · ${popName} (${pop.count.toLocaleString()})`,
    x: { name: x, label: sample.label(x), cfg: cfgX },
    y: y ? { name: y, label: sample.label(y), cfg: cfgY } : null,
    series, gates,
    hist: { mode: 'count', smooth: def.smooth !== false, fill: true },
  };
}

const HANDLE = 6;

export class PlotView {
  constructor(app, def, canvas, w, h) {
    Object.assign(this, { app, def, canvas, w, h });
    this.drawing = null; this.drag = null; this.spec = null; this.L = null;
    canvas.addEventListener('mousedown', e => this.onDown(e));
    canvas.addEventListener('dblclick', e => this.onDbl(e));
    this._move = e => this.onMove(e);
    this._up = e => this.onUp(e);
    canvas.addEventListener('mousemove', e => { if (!this.drag && !this.drawing) this.hover(e); else if (this.drawing?.type === 'polygon') this.onMove(e); });
    canvas.addEventListener('contextmenu', e => { if (this.drawing) { e.preventDefault(); this.drawing = null; this.draw(); } });
  }

  sample() { return this.app.activeSample(); }

  draw() {
    const s = this.sample();
    this.spec = buildSpec(this.app, s, this.def, this.w, this.h);
    const ctx = prepareCanvas(this.canvas, this.w, this.h);
    if (!this.spec) {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, this.w, this.h);
      ctx.fillStyle = '#888'; ctx.font = '12px system-ui'; ctx.textAlign = 'center';
      const missing = s ? [this.def.x, this.def.y].filter(c => c && !s.hasChannel(c)) : [];
      ctx.fillText(s ? `${missing.join(', ')} not in ${s.name}` : 'No sample loaded', this.w / 2, this.h / 2 - 8);
      if (s) ctx.fillText('(different instrument/panel?) Pick axes above.', this.w / 2, this.h / 2 + 10);
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
    ctx.strokeStyle = '#000'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.3;
    if (d.type === 'polygon') {
      ctx.beginPath();
      d.pts.forEach(([u, v], i) => (i ? ctx.lineTo(L.ux2px(u), L.uy2px(v)) : ctx.moveTo(L.ux2px(u), L.uy2px(v))));
      if (d.cur) ctx.lineTo(L.ux2px(d.cur[0]), L.uy2px(d.cur[1]));
      ctx.stroke();
      ctx.fillStyle = '#000';
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
    return { px, py, u: [this.L.px2ux(px), this.L.px2uy(py)] };
  }

  inPlot(px, py) { return px >= MARGIN.l && px <= MARGIN.l + this.L.pw && py >= MARGIN.t && py <= MARGIN.t + this.L.ph; }

  // ---- hit testing on existing gates ----
  hitTest(px, py) {
    if (!this.spec) return null;
    const clampX = x => Math.min(MARGIN.l + this.L.pw, Math.max(MARGIN.l, x));
    const clampY = y => Math.min(MARGIN.t + this.L.ph, Math.max(MARGIN.t, y));
    const items = [...this.spec.gates].sort((a, b) => b.selected - a.selected);
    // handles first
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
    // Clicking inside a quadrant region selects that quadrant
    for (const it of items) {
      const g = it.gate; if (g.type !== 'quad') continue;
      const geo = gateGeometry(this.L, this.spec, g);
      const q = (py < geo.cy ? 'U' : 'L') + (px < geo.cx ? 'L' : 'R');
      if (q === g.q) return { gate: g, mode: 'select' };
    }
    return null;
  }

  hover(e) {
    if (!this.L || this.app.tool !== 'select') return;
    const { px, py } = this.evtUnit(e);
    const h = this.hitTest(px, py);
    this.canvas.style.cursor = !h ? 'default' : h.mode === 'move' ? 'move' : h.mode === 'select' ? 'pointer' : 'crosshair';
  }

  onDown(e) {
    if (!this.spec || e.button !== 0) return;
    this.app.focusPlot(this.def.id);
    const { px, py, u } = this.evtUnit(e);
    const tool = this.app.tool;
    const isHist = !this.def.y;
    if (tool === 'select') {
      const h = this.hitTest(px, py);
      if (!h) { this.app.selectGate(null); return; }
      this.app.selectGate(h.gate.id, { quiet: true });
      if (h.mode === 'select') { this.app.redrawAll(); return; }
      this.drag = { ...h, orig: JSON.parse(JSON.stringify(h.gate)), start: u, moved: false };
      this.draw();
      window.addEventListener('mousemove', this._move); window.addEventListener('mouseup', this._up);
      return;
    }
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
    const { u } = this.evtUnit(e);
    if (this.drawing) {
      this.drawing.cur = u;
      this.quickDraw();
      return;
    }
    if (!this.drag) return;
    const d = this.drag;
    const du = [u[0] - d.start[0], u[1] - d.start[1]];
    if (Math.abs(du[0]) + Math.abs(du[1]) > 0.002) d.moved = true;
    const g = this.app.engine.get(d.gate.id);
    const tx = makeTransform(this.app.getCfg(g.x));
    const ty = g.y ? makeTransform(this.app.getCfg(g.y)) : null;
    const o = d.orig;
    const mvX = v => tx.inv(tx.fwd(v) + du[0]);
    const mvY = v => ty.inv(ty.fwd(v) + du[1]);
    if (g.type === 'polygon') {
      if (d.mode === 'vertex') {
        const s = snapUnit(u);
        g.pts[d.index] = [tx.inv(s[0]), ty.inv(s[1])];
      } else g.pts = o.pts.map(([x, y]) => [mvX(x), mvY(y)]);
    } else if (g.type === 'rect') {
      if (d.mode === 'vertex') {
        const s = snapUnit(u);
        const [vx, vy] = [tx.inv(s[0]), ty.inv(s[1])];
        // vertices: 0=(x0,y0) 1=(x1,y0) 2=(x1,y1) 3=(x0,y1)
        if (d.index === 0 || d.index === 3) g.x0 = vx; else g.x1 = vx;
        if (d.index === 0 || d.index === 1) g.y0 = vy; else g.y1 = vy;
      } else { g.x0 = mvX(o.x0); g.x1 = mvX(o.x1); g.y0 = mvY(o.y0); g.y1 = mvY(o.y1); }
    } else if (g.type === 'quad') {
      const cx = tx.inv(u[0]), cy = ty.inv(u[1]);
      for (const q of this.app.engine.list()) if (q.group === g.group) { q.cx = cx; q.cy = cy; }
    } else if (g.type === 'interval') {
      if (d.mode === 'iv0') g.x0 = tx.inv(snapUnit(u)[0]);
      else if (d.mode === 'iv1') g.x1 = tx.inv(snapUnit(u)[0]);
      else { g.x0 = mvX(o.x0); g.x1 = mvX(o.x1); g.level = Math.min(0.97, Math.max(0.05, (o.level ?? 0.85) + du[1])); }
    }
    this.app.gateChanged(g, { live: true });
    this.draw();
  }

  onUp(e) {
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
        const tx = makeTransform(this.app.getCfg(this.def.x));
        this.app.createGate(this.def, { type: 'interval', x0: tx.inv(Math.min(a[0], b[0])), x1: tx.inv(Math.max(a[0], b[0])), level: Math.min(0.95, Math.max(0.05, d.start[1])) });
      }
      return;
    }
    if (this.drag) {
      const moved = this.drag.moved; this.drag = null;
      if (moved) this.app.gateChanged(this.app.engine.get(this.app.selectedGate));
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
    if (h) this.app.drillDown(h.gate, this.def);
  }

  finishPolygon() {
    const pts = this.drawing.pts.filter((p, i, arr) => i === 0 || Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1]) > 1e-4);
    this.drawing = null;
    if (pts.length < 3) { this.draw(); return; }
    this.app.createGate(this.def, { type: 'polygon', pts: pts.map(p => this.toData(p)) });
  }

  cancel() { if (this.drawing) { this.drawing = null; this.draw(); } }

  toData([ux, uy]) {
    const tx = makeTransform(this.app.getCfg(this.def.x));
    const ty = this.def.y ? makeTransform(this.app.getCfg(this.def.y)) : null;
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

