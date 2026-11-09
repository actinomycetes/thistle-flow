// Interactive canvas for a Layout figure.
// - Gate labels can be dragged (positions are kept per figure in f.labelPos, so arranging a
//   figure does not move the labels in the Gating plots).
// - On histogram overlays, range gates can be drawn and adjusted. Gates are shared by every
//   sample in the workspace, so one range gate sets the gate for all overlaid samples at once.
import { renderPlot, prepareCanvas, gateGeometry, MARGIN, THEMES } from './render.js';
import { makeTransform } from './transforms.js';

const FIG_HANDLE = 6;

export class FigureView {
  // makeSpec() returns a plot spec, or a string to show instead (e.g. "channel missing")
  constructor(app, f, canvas, makeSpec, { editable = false, onLabelDone } = {}) {
    Object.assign(this, { app, f, canvas, makeSpec, editable, onLabelDone });
    this.spec = null; this.L = null; this.drag = null; this.drawing = null;
    canvas._figView = this; // lets tests inspect what was drawn
    canvas.addEventListener('mousedown', e => this.onDown(e));
    canvas.addEventListener('mousemove', e => { if (!this.drag && !this.drawing) this.hover(e); });
    canvas.addEventListener('dblclick', e => this.onDbl(e));
    this._move = e => this.onMove(e);
    this._up = () => this.onUp();
  }

  draw() {
    const f = this.f, theme = THEMES[this.app.theme] || THEMES.light;
    const spec = this.makeSpec();
    const ctx = prepareCanvas(this.canvas, f.w, f.h);
    if (!spec || typeof spec === 'string') {
      this.spec = null; this.L = null;
      ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, f.w, f.h);
      ctx.fillStyle = theme.muted; ctx.font = '12px system-ui'; ctx.fillText(spec || 'Nothing to show', 16, 28);
      return;
    }
    this.spec = spec;
    this.L = renderPlot(ctx, spec);
    this.bg = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  }

  drawingRange() { return this.editable && this.app.figDrawing === this.f.id; }

  evt(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    return { px, py, u: this.L ? [this.L.px2ux(px), this.L.px2uy(py)] : [0, 0] };
  }
  inPlot(px, py) { return this.L && px >= MARGIN.l && px <= MARGIN.l + this.L.pw && py >= MARGIN.t && py <= MARGIN.t + this.L.ph; }

  hitTest(px, py) {
    if (!this.spec) return null;
    const inBox = b => b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
    // sample labels and the legend can be dragged when they are drawn inside the plot
    if ((this.spec.labels?.mode || 'inside') === 'inside') {
      for (const b of this.spec._labelBoxes || []) if (inBox(b)) return { mode: 'slabel', box: b, si: this.spec.series[b.i].si };
      if (inBox(this.spec._legendBox)) return { mode: 'legend', box: this.spec._legendBox };
    }
    for (const it of this.spec.gates || []) {
      const b = it.labelBox;
      if (b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return { item: it, mode: 'label' };
    }
    if (!this.editable) return null;
    const clampX = x => Math.min(MARGIN.l + this.L.pw, Math.max(MARGIN.l, x));
    for (const it of this.spec.gates || []) {
      const geo = gateGeometry(this.L, this.spec, it.gate);
      if (!geo || geo.kind !== 'interval') continue;
      if (Math.abs(clampX(geo.x0) - px) <= FIG_HANDLE && Math.abs(geo.y - py) <= 10) return { item: it, mode: 'iv0' };
      if (Math.abs(clampX(geo.x1) - px) <= FIG_HANDLE && Math.abs(geo.y - py) <= 10) return { item: it, mode: 'iv1' };
      if (px >= Math.min(geo.x0, geo.x1) && px <= Math.max(geo.x0, geo.x1) && Math.abs(py - geo.y) <= 8) return { item: it, mode: 'move' };
    }
    return null;
  }

  hover(e) {
    const { px, py } = this.evt(e);
    if (this.drawingRange()) { this.canvas.style.cursor = this.inPlot(px, py) ? 'crosshair' : 'default'; return; }
    const hit = this.hitTest(px, py);
    this.canvas.style.cursor = !hit ? 'default' : ['label', 'slabel', 'legend', 'move'].includes(hit.mode) ? 'move' : 'ew-resize';
  }

  onDown(e) {
    if (e.button !== 0 || !this.spec) return;
    const { px, py, u } = this.evt(e);
    if (this.drawingRange()) {
      if (!this.inPlot(px, py)) return;
      this.drawing = { start: u, cur: null };
    } else {
      const hit = this.hitTest(px, py);
      if (!hit) { if (this.app.ws.selectedGate) { this.app.selectGate(null, { quiet: true }); this.draw(); } return; }
      if (hit.mode === 'slabel' || hit.mode === 'legend') {
        this.drag = { ...hit, startPx: [px, py], moved: false };
        window.addEventListener('mousemove', this._move); window.addEventListener('mouseup', this._up);
        return;
      }
      const g = hit.item.gate;
      this.app.selectGate(g.id, { quiet: true });
      this.drag = { ...hit, gate: g, orig: JSON.parse(JSON.stringify(g)), start: u, startPx: [px, py], moved: false };
      this.draw();
    }
    window.addEventListener('mousemove', this._move); window.addEventListener('mouseup', this._up);
  }

  onMove(e) {
    const { px, py, u } = this.evt(e);
    if (this.drawing) {
      this.drawing.cur = u;
      const ctx = this.canvas.getContext('2d');
      ctx.putImageData(this.bg, 0, 0);
      ctx.save();
      ctx.strokeStyle = this.app.theme === 'dark' ? '#fff' : '#000'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.3;
      const y = this.L.uy2px(this.drawing.start[1]);
      ctx.beginPath(); ctx.moveTo(this.L.ux2px(this.drawing.start[0]), y); ctx.lineTo(this.L.ux2px(u[0]), y); ctx.stroke();
      ctx.restore();
      return;
    }
    const d = this.drag; if (!d) return;
    if (Math.abs(px - d.startPx[0]) + Math.abs(py - d.startPx[1]) > 2) d.moved = true;
    if (!d.moved) return;
    if (d.mode === 'slabel' || d.mode === 'legend') {
      const p = [Math.min(1, Math.max(0, this.L.px2ux(d.box.cx + px - d.startPx[0]))), Math.min(1, Math.max(0, this.L.px2uy(d.box.cy + py - d.startPx[1])))];
      if (d.mode === 'legend') this.f.legendPos = p; else this.f.series[d.si].labelPos = p;
      this.draw();
      return;
    }
    if (d.mode === 'label') {
      const b = d.item.labelBox;
      const cx = b.cx + (px - d.startPx[0]), cy = b.cy + (py - d.startPx[1]);
      this.f.labelPos = { ...(this.f.labelPos || {}), [d.gate.id]: [Math.min(1, Math.max(0, this.L.px2ux(cx))), Math.min(1, Math.max(0, this.L.px2uy(cy)))] };
      d.item.labelBox = b; // keep the grab reference while redrawing
      this.draw();
      d.item = this.spec.gates.find(it => it.gate.id === d.gate.id) || d.item;
      d.item.labelBox = b;
      return;
    }
    const g = this.app.ws.engine.get(d.gate.id);
    const tx = makeTransform(this.app.ws.getCfg(g.x));
    const snap = v => (v <= 0.003 ? -0.3 : v >= 0.997 ? 1.3 : v);
    const du = [u[0] - d.start[0], u[1] - d.start[1]];
    if (d.mode === 'iv0') g.x0 = tx.inv(snap(u[0]));
    else if (d.mode === 'iv1') g.x1 = tx.inv(snap(u[0]));
    else {
      g.x0 = tx.inv(tx.fwd(d.orig.x0) + du[0]); g.x1 = tx.inv(tx.fwd(d.orig.x1) + du[0]);
      g.level = Math.min(0.97, Math.max(0.05, (d.orig.level ?? 0.85) + du[1]));
    }
    this.app.gateChanged(g, { live: true });
    this.draw();
  }

  onUp() {
    window.removeEventListener('mousemove', this._move); window.removeEventListener('mouseup', this._up);
    if (this.drawing) {
      const { start, cur } = this.drawing; this.drawing = null;
      if (!cur || Math.abs(cur[0] - start[0]) < 0.01) { this.draw(); return; }
      const tx = makeTransform(this.app.ws.getCfg(this.f.x));
      const snap = v => (v <= 0.003 ? -0.3 : v >= 0.997 ? 1.3 : v);
      const a = snap(Math.min(start[0], cur[0])), b = snap(Math.max(start[0], cur[0]));
      this.app.createFigureGate(this.f, { x0: tx.inv(a), x1: tx.inv(b), level: Math.min(0.95, Math.max(0.05, start[1])) });
      return;
    }
    const d = this.drag; this.drag = null;
    if (!d) return;
    if (d.mode === 'label' || d.mode === 'slabel' || d.mode === 'legend') { if (d.moved && this.onLabelDone) this.onLabelDone(); return; }
    if (d.moved) this.app.gateChanged(this.app.ws.engine.get(d.gate.id));
  }

  onDbl(e) {
    const { px, py } = this.evt(e);
    const hit = this.hitTest(px, py);
    if (hit?.item) this.app.renameGate(hit.item.gate);
  }
}
