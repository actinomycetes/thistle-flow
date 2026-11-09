// Sample data model: raw columns, compensation, transformed-value caches.
import { makeTransform } from './transforms.js';

let SAMPLE_ID = 0;

export function invertMatrix(m) {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) throw new Error('Spillover matrix is singular');
    [a[col], a[piv]] = [a[piv], a[col]];
    const p = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map(row => row.slice(n));
}

export class Sample {
  constructor(ds) {
    this.id = 's' + (++SAMPLE_ID);
    this.name = ds.name;
    this.fileName = ds.fileName;
    this.instrument = ds.instrument;
    this.version = ds.version;
    this.text = ds.text;
    this.params = ds.params;
    this.raw = ds.columns;
    this.events = ds.events;
    this.channelNames = ds.params.map(p => p.name);
    // Compensation: matrix as embedded in the file (may be edited by user)
    this.spill = ds.spill ? { names: ds.spill.names.map(n => this.resolveChannel(n)), matrix: ds.spill.matrix.map(r => [...r]) } : null;
    // Sony writes APPLY_COMPENSATION=FALSE when the matrix should not be applied by default
    const applyFlag = String(ds.text.APPLY_COMPENSATION ?? 'TRUE').toUpperCase() !== 'FALSE';
    this.compEnabled = !!this.spill && applyFlag && this.spillMissing().length === 0;
    this._comp = null;     // Map name -> Float32Array (compensated)
    this._unit = new Map(); // key -> Float32Array
    this.keywordsDisplayed = false;
  }

  channelIndex(name) { return this.channelNames.indexOf(name); }

  // Spillover keywords sometimes reference $PnS labels or differ in case; map them onto $PnN names.
  resolveChannel(n) {
    if (this.channelNames.includes(n)) return n;
    const t = n.trim().toLowerCase();
    const byName = this.params.find(p => p.name.trim().toLowerCase() === t);
    if (byName) return byName.name;
    const byLabel = this.params.filter(p => p.label && p.label.trim().toLowerCase() === t);
    if (byLabel.length === 1) return byLabel[0].name;
    return n;
  }
  spillMissing() { return this.spill ? this.spill.names.filter(n => !this.hasChannel(n)) : []; }
  hasChannel(name) { return this.channelNames.includes(name); }
  label(name) {
    const p = this.params[this.channelIndex(name)];
    return p && p.label && p.label !== p.name ? `${p.label} :: ${p.name}` : name;
  }

  invalidate() { this._comp = null; this._unit.clear(); }

  setSpill(spill) { this.spill = spill ? { names: spill.names.map(n => this.resolveChannel(n)), matrix: spill.matrix } : null; this.invalidate(); }
  setCompEnabled(on) { this.compEnabled = on; this.invalidate(); }

  _computeComp() {
    this._comp = new Map();
    if (!this.compEnabled || !this.spill) return;
    const { names, matrix } = this.spill;
    const idx = names.map(n => this.channelIndex(n));
    if (idx.some(i => i < 0)) {
      console.warn(`[${this.name}] spillover channels not all found; compensation disabled`, names);
      return;
    }
    const inv = invertMatrix(matrix);
    const n = names.length, N = this.events;
    const src = idx.map(i => this.raw[i]);
    const out = names.map(() => new Float32Array(N));
    const row = new Float64Array(n);
    for (let e = 0; e < N; e++) {
      for (let k = 0; k < n; k++) row[k] = src[k][e];
      for (let j = 0; j < n; j++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += row[k] * inv[k][j];
        out[j][e] = s;
      }
    }
    names.forEach((nm, j) => this._comp.set(nm, out[j]));
  }

  // Compensated (if enabled) data for a channel.
  column(name) {
    if (!this._comp) this._computeComp();
    if (this._comp.has(name)) return this._comp.get(name);
    const i = this.channelIndex(name);
    if (i < 0) return null;
    return this.raw[i];
  }

  isCompensated(name) {
    if (!this._comp) this._computeComp();
    return this._comp.has(name);
  }

  // Values transformed to display units [0,1] with the given transform config.
  unit(name, cfg) {
    const key = name + '|' + JSON.stringify(cfg);
    let u = this._unit.get(key);
    if (u) return u;
    const col = this.column(name);
    if (!col) return null;
    const t = makeTransform(cfg);
    u = new Float32Array(col.length);
    for (let i = 0; i < col.length; i++) u[i] = t.fwd(col[i]);
    // transforms are global per channel, so drop stale versions for this channel
    for (const k of this._unit.keys()) if (k.startsWith(name + '|')) this._unit.delete(k);
    this._unit.set(key, u);
    return u;
  }
}
