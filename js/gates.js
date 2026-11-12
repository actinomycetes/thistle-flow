// Gate definitions, membership evaluation and population statistics.
import { makeTransform } from './transforms.js';

export const GATE_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#000075', '#808000'];

export function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function unitRange(t, a, b) {
  if (a > b) [a, b] = [b, a];
  return [a === -Infinity ? -Infinity : t.fwd(a), b === Infinity ? Infinity : t.fwd(b)];
}

// ---- per-sample gate adjustments ----
// A gate may carry overrides: { [sample.key]: geometry } (keyed by file name so they survive saving).
const GEOM_KEYS = { rect: ['x0', 'x1', 'y0', 'y1'], polygon: ['pts'], quad: ['cx', 'cy'], interval: ['x0', 'x1', 'level'], split: ['cx'] };
// Gates that come in linked groups (moved together): quadrants (4) and splits (left/right)
export const isGrouped = g => g.type === 'quad' || g.type === 'split';
export function pickGeom(g) {
  const out = {};
  for (const k of GEOM_KEYS[g.type] || []) if (g[k] !== undefined) out[k] = JSON.parse(JSON.stringify(g[k]));
  return out;
}
export const isCustom = (g, sample) => !!(sample && g.overrides && g.overrides[sample.key]);
// The gate as it applies to one sample (the global gate unless that sample has its own geometry)
export function gateFor(g, sample) { return isCustom(g, sample) ? { ...g, ...g.overrides[sample.key] } : g; }
export const customSampleKeys = g => Object.keys(g.overrides || {});

// Which channels a gate uses
export const isOneD = g => g.type === 'interval' || g.type === 'split'; // histogram gates
export function gateChannels(g) { return isOneD(g) ? [g.x] : [g.x, g.y]; }

export class GateEngine {
  constructor(getCfg) {
    this.getCfg = getCfg; // channel -> transform cfg
    this.gates = new Map();
    this.cache = new Map(); // sampleId -> Map(gateId -> {mask, idx})
  }

  invalidate(sampleId) { if (sampleId) this.cache.delete(sampleId); else this.cache.clear(); }

  list() { return [...this.gates.values()]; }
  children(parentId) { return this.list().filter(g => (g.parent ?? null) === (parentId ?? null)); }
  get(id) { return this.gates.get(id); }

  add(g) { this.gates.set(g.id, g); this.invalidate(); return g; }
  remove(id) {
    const g = this.gates.get(id);
    if (!g) return;
    const ids = [id];
    // remove whole quadrant group together
    if (isGrouped(g)) for (const o of this.list()) if (o.group === g.group && o.id !== id) ids.push(o.id);
    for (const gid of ids) {
      for (const c of this.children(gid)) this.remove(c.id);
      this.gates.delete(gid);
    }
    this.invalidate();
  }

  // Path from root to gate (array of gates)
  path(id) {
    const out = [];
    let g = this.gates.get(id);
    while (g) { out.unshift(g); g = g.parent ? this.gates.get(g.parent) : null; }
    return out;
  }
  fullName(id) { return id ? this.path(id).map(g => g.name).join('/') : 'All Events'; }

  canApply(sample, g) { return gateChannels(g).every(c => sample.hasChannel(c)); }

  _test(sample, g) {
    g = gateFor(g, sample);
    const N = sample.events;
    const out = new Uint8Array(N);
    if (!this.canApply(sample, g)) return out; // channels missing -> empty
    if (g.type === 'rect' || g.type === 'quad' || g.type === 'interval' || g.type === 'split') {
      let x0, x1, y0 = -Infinity, y1 = Infinity;
      if (g.type === 'rect') ({ x0, x1, y0, y1 } = g);
      else if (g.type === 'interval') ({ x0, x1 } = g);
      else if (g.type === 'split') { x0 = g.side === 'L' ? -Infinity : g.cx; x1 = g.side === 'L' ? g.cx : Infinity; }
      else {
        const right = g.q === 'UR' || g.q === 'LR', up = g.q === 'UR' || g.q === 'UL';
        x0 = right ? g.cx : -Infinity; x1 = right ? Infinity : g.cx;
        y0 = up ? g.cy : -Infinity; y1 = up ? Infinity : g.cy;
      }
      // Compare in unit space so that out-of-range events piled on axes behave consistently
      const tx = makeTransform(this.getCfg(g.x));
      const ux = sample.unit(g.x, this.getCfg(g.x));
      const [lox, hix] = unitRange(tx, x0, x1);
      if (isOneD(g)) {
        for (let i = 0; i < N; i++) { const v = ux[i]; out[i] = v >= lox && v < hix ? 1 : 0; }
        return out;
      }
      const ty = makeTransform(this.getCfg(g.y));
      const uy = sample.unit(g.y, this.getCfg(g.y));
      const [loy, hiy] = unitRange(ty, y0, y1);
      for (let i = 0; i < N; i++) {
        const vx = ux[i], vy = uy[i];
        out[i] = vx >= lox && vx < hix && vy >= loy && vy < hiy ? 1 : 0;
      }
      return out;
    }
    if (g.type === 'polygon') {
      const tx = makeTransform(this.getCfg(g.x)), ty = makeTransform(this.getCfg(g.y));
      const pts = g.pts.map(([x, y]) => [tx.fwd(x), ty.fwd(y)]);
      const ux = sample.unit(g.x, this.getCfg(g.x)), uy = sample.unit(g.y, this.getCfg(g.y));
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (const [x, y] of pts) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
      for (let i = 0; i < N; i++) {
        const x = ux[i], y = uy[i];
        if (x < minx || x > maxx || y < miny || y > maxy) continue;
        out[i] = pointInPolygon(x, y, pts) ? 1 : 0;
      }
      return out;
    }
    throw new Error('Unknown gate type ' + g.type);
  }

  // Returns { mask: Uint8Array|null (null = all), idx: Uint32Array, count }
  population(sample, gateId) {
    let sc = this.cache.get(sample.id);
    if (!sc) { sc = new Map(); this.cache.set(sample.id, sc); }
    const key = gateId || '__root';
    if (sc.has(key)) return sc.get(key);
    let res;
    if (!gateId) {
      const idx = new Uint32Array(sample.events);
      for (let i = 0; i < idx.length; i++) idx[i] = i;
      res = { mask: null, idx, count: sample.events };
    } else {
      const g = this.gates.get(gateId);
      const parent = this.population(sample, g.parent);
      const own = this._test(sample, g);
      if (parent.mask) for (let i = 0; i < own.length; i++) own[i] &= parent.mask[i];
      let count = 0;
      for (let i = 0; i < own.length; i++) count += own[i];
      const idx = new Uint32Array(count);
      for (let i = 0, k = 0; i < own.length; i++) if (own[i]) idx[k++] = i;
      res = { mask: own, idx, count };
    }
    sc.set(key, res);
    return res;
  }

  toJSON() { return this.list(); }
  load(arr) { this.gates.clear(); for (const g of arr) this.gates.set(g.id, g); this.invalidate(); }
}

// ---------- statistics ----------
function quantileSorted(s, q) {
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function channelStats(col, idx) {
  const n = idx.length;
  if (!n) return { mean: NaN, median: NaN, gmean: NaN, sd: NaN, cv: NaN, rcv: NaN, rsd: NaN, min: NaN, max: NaN };
  const vals = new Float32Array(n);
  let sum = 0, logSum = 0, logN = 0;
  for (let i = 0; i < n; i++) {
    const v = col[idx[i]];
    vals[i] = v; sum += v;
    if (v > 0) { logSum += Math.log(v); logN++; }
  }
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = vals[i] - mean; ss += d * d; }
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  vals.sort();
  const median = quantileSorted(vals, 0.5);
  const p16 = quantileSorted(vals, 0.15866), p84 = quantileSorted(vals, 0.84134);
  const rsd = (p84 - p16) / 2;
  return {
    mean, median, sd,
    gmean: logN ? Math.exp(logSum / logN) : NaN,
    cv: mean !== 0 ? 100 * sd / Math.abs(mean) : NaN,
    rsd,
    rcv: median !== 0 ? 100 * rsd / Math.abs(median) : NaN,
    min: vals[0], max: vals[n - 1],
    p5: quantileSorted(vals, 0.05), p95: quantileSorted(vals, 0.95),
  };
}

export const STAT_DEFS = [
  { key: 'count', label: 'Count', perChannel: false },
  { key: 'pctParent', label: '% Parent', perChannel: false },
  { key: 'pctTotal', label: '% Total', perChannel: false },
  { key: 'median', label: 'Median (MFI)', perChannel: true },
  { key: 'mean', label: 'Mean', perChannel: true },
  { key: 'gmean', label: 'Geo. Mean', perChannel: true },
  { key: 'sd', label: 'SD', perChannel: true },
  { key: 'cv', label: 'CV %', perChannel: true },
  { key: 'rsd', label: 'Robust SD', perChannel: true },
  { key: 'rcv', label: 'Robust CV %', perChannel: true },
];

export function populationStats(engine, sample, gateId) {
  const pop = engine.population(sample, gateId);
  const g = gateId ? engine.get(gateId) : null;
  const parent = g ? engine.population(sample, g.parent) : pop;
  return {
    count: pop.count,
    pctParent: parent.count ? 100 * pop.count / parent.count : NaN,
    pctTotal: sample.events ? 100 * pop.count / sample.events : NaN,
  };
}
