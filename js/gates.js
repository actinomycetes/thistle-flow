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

// Gate edges in display units, rounded like the stored event values (Float32) so that an event
// exactly on an edge is always treated the same way.
const f32 = Math.fround;
function unitRange(t, a, b) {
  if (a > b) [a, b] = [b, a];
  return [a === -Infinity ? -Infinity : f32(t.fwd(a)), b === Infinity ? Infinity : f32(t.fwd(b))];
}

// Events beyond the plot are drawn piled up on its axes, so gates treat them as lying just inside
// the axis: display units are clamped to [PILE_LO, PILE_HI] before testing. A gate edge dragged onto an
// axis is stored at -0.3 / 1.3 (outside this range), so it holds the whole pile, as drawn.
// NaN (missing) values are in no gate.
export const PILE_LO = -0.25, PILE_HI = 1.25;
const pile = v => (v < PILE_LO ? PILE_LO : v > PILE_HI ? PILE_HI : v);

// ---- per-sample gate adjustments ----
// A gate may carry overrides: { [sample.key]: geometry } (keyed by file name so they survive saving).
const GEOM_KEYS = { rect: ['x0', 'x1', 'y0', 'y1'], polygon: ['pts'], quad: ['cx', 'cy', 'quadMode', 'angles', 'offsets'], interval: ['x0', 'x1', 'level'], split: ['cx'] };
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

// ---- quadrant geometry ----
// A quadrant group has a centre (cx, cy) and four arms: up, right, down, left (clockwise).
//  standard: arms along the axes through the centre;
//  spider:   straight arms at independent angles (degrees, in display units, anticlockwise from +x);
//  offset:   staggered arms: the up/down arms run vertically at their own x (offsets.up / .down) and
//            the right/left arms horizontally at their own y (offsets.right / .left), each joined to
//            the centre by a step (values in data units).
// Each quadrant is the region between two neighbouring arms, closed along a frame that extends well
// past the axes (so piled-up off-scale events are included); the four regions tile the plane.
export const ARMS = ['up', 'right', 'down', 'left'];
export const QUAD_REGION_ARMS = { UR: ['up', 'right'], LR: ['right', 'down'], LL: ['down', 'left'], UL: ['left', 'up'] };
export const DEFAULT_ANGLES = { up: 90, right: 0, down: 270, left: 180 };
const B0 = -0.5, B1 = 1.5; // extended frame in display units
export const quadMode = g => g.quadMode || 'standard';

function rayToFrame([x, y], deg) {
  const dx = Math.cos(deg * Math.PI / 180), dy = Math.sin(deg * Math.PI / 180);
  let t = Infinity;
  if (dx > 1e-12) t = Math.min(t, (B1 - x) / dx); else if (dx < -1e-12) t = Math.min(t, (B0 - x) / dx);
  if (dy > 1e-12) t = Math.min(t, (B1 - y) / dy); else if (dy < -1e-12) t = Math.min(t, (B0 - y) / dy);
  return [x + dx * t, y + dy * t];
}

// Arms as polylines from the centre to the extended frame, in display units (0..1 = the plot).
export function quadArms(g, tx, ty) {
  const c = [tx.fwd(g.cx), ty.fwd(g.cy)];
  const m = quadMode(g);
  if (m === 'spider') {
    const a = { ...DEFAULT_ANGLES, ...(g.angles || {}) };
    return { c, arms: Object.fromEntries(ARMS.map(k => [k, [c, rayToFrame(c, a[k])]])) };
  }
  if (m === 'offset') {
    const o = g.offsets || {};
    const xu = tx.fwd(o.up ?? g.cx), xd = tx.fwd(o.down ?? g.cx), yr = ty.fwd(o.right ?? g.cy), yl = ty.fwd(o.left ?? g.cy);
    // each arm leaves the centre along its own direction until it is past the neighbouring arms' jogs,
    // then steps sideways to its own line: arms never cross, so the four regions always tile the plane
    const top = Math.max(c[1], yl, yr), bot = Math.min(c[1], yl, yr);
    const rgt = Math.max(c[0], xu, xd), lft = Math.min(c[0], xu, xd);
    return { c, arms: {
      up: [c, [c[0], top], [xu, top], [xu, B1]], down: [c, [c[0], bot], [xd, bot], [xd, B0]],
      right: [c, [rgt, c[1]], [rgt, yr], [B1, yr]], left: [c, [lft, c[1]], [lft, yl], [B0, yl]],
    } };
  }
  return { c, arms: { up: [c, [c[0], B1]], right: [c, [B1, c[1]]], down: [c, [c[0], B0]], left: [c, [B0, c[1]]] } };
}

// position along the frame, clockwise from the top-left corner (0..8)
function frameT([x, y]) {
  const e = 1e-9;
  if (Math.abs(y - B1) < e) return x - B0;
  if (Math.abs(x - B1) < e) return 2 + (B1 - y);
  if (Math.abs(y - B0) < e) return 4 + (B1 - x);
  return 6 + (y - B0);
}
const CORNERS = [[0, [B0, B1]], [2, [B1, B1]], [4, [B1, B0]], [6, [B0, B0]]];

// Polygon (display units) of one quadrant: arm A out, clockwise along the frame, arm B back.
export function quadRegion(armsObj, q) {
  const [ka, kb] = QUAD_REGION_ARMS[q];
  const A = armsObj.arms[ka], B = armsObj.arms[kb];
  const ta = frameT(A.at(-1));
  let tb = frameT(B.at(-1));
  if (tb <= ta) tb += 8;
  const walk = [];
  for (const add of [0, 8]) for (const [t, pt] of CORNERS) if (t + add > ta && t + add < tb) walk.push(pt);
  return [...A, ...walk, ...B.slice().reverse().slice(0, -1)];
}

// Handles for reshaping (display units): one on each arm (spider: along the arm; offset: on its outer part)
export function quadHandles(g, tx, ty) {
  const { c, arms } = quadArms(g, tx, ty);
  const m = quadMode(g);
  if (m === 'standard') return {};
  const clip = v => Math.min(0.97, Math.max(0.03, v));
  const out = {};
  for (const k of ARMS) {
    const a = arms[k];
    if (m === 'spider') {
      const deg = { ...DEFAULT_ANGLES, ...(g.angles || {}) }[k] * Math.PI / 180;
      out[k] = [clip(c[0] + 0.28 * Math.cos(deg)), clip(c[1] + 0.28 * Math.sin(deg))];
    } else {
      const [p, q] = [a.at(-2), a.at(-1)]; // the outer segment
      out[k] = [clip((p[0] + clip(q[0])) / 2), clip((p[1] + clip(q[1])) / 2)];
    }
  }
  return out;
}

// Which channels a gate uses
export const isOneD = g => g.type === 'interval' || g.type === 'split'; // histogram gates
export function gateChannels(g) { return isOneD(g) ? [g.x] : [g.x, g.y]; }

function polygonMask(ux, uy, pts, out) {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const [x, y] of pts) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
  for (let i = 0; i < out.length; i++) {
    const x = pile(ux[i]), y = pile(uy[i]);
    if (x !== x || y !== y) continue; // NaN: in no gate
    if (x < minx || x > maxx || y < miny || y > maxy) continue;
    out[i] = pointInPolygon(x, y, pts) ? 1 : 0;
  }
  return out;
}

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
    if (g.type === 'quad' && quadMode(g) !== 'standard') {
      const tx = makeTransform(this.getCfg(g.x)), ty = makeTransform(this.getCfg(g.y));
      const pts = quadRegion(quadArms(g, tx, ty), g.q);
      return polygonMask(sample.unit(g.x, this.getCfg(g.x)), sample.unit(g.y, this.getCfg(g.y)), pts, out);
    }
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
        for (let i = 0; i < N; i++) { const v = pile(ux[i]); out[i] = v >= lox && v < hix ? 1 : 0; }
        return out;
      }
      const ty = makeTransform(this.getCfg(g.y));
      const uy = sample.unit(g.y, this.getCfg(g.y));
      const [loy, hiy] = unitRange(ty, y0, y1);
      for (let i = 0; i < N; i++) {
        const vx = pile(ux[i]), vy = pile(uy[i]);
        out[i] = vx >= lox && vx < hix && vy >= loy && vy < hiy ? 1 : 0;
      }
      return out;
    }
    if (g.type === 'polygon') {
      const tx = makeTransform(this.getCfg(g.x)), ty = makeTransform(this.getCfg(g.y));
      const pts = g.pts.map(([x, y]) => [f32(tx.fwd(x)), f32(ty.fwd(y))]);
      return polygonMask(sample.unit(g.x, this.getCfg(g.x)), sample.unit(g.y, this.getCfg(g.y)), pts, out);
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
  // non-finite values (NaN, ±Infinity) are left out of every statistic; n = values used
  const all = new Float64Array(idx.length);
  let n = 0, sum = 0, logSum = 0, logN = 0;
  for (let i = 0; i < idx.length; i++) {
    const v = col[idx[i]];
    if (!Number.isFinite(v)) continue;
    all[n++] = v; sum += v;
    if (v > 0) { logSum += Math.log(v); logN++; } // geometric mean: positive values only (logN of n)
  }
  if (!n) return { n: 0, mean: NaN, median: NaN, gmean: NaN, gmeanN: 0, sd: NaN, cv: NaN, rcv: NaN, rsd: NaN, min: NaN, max: NaN, p5: NaN, p95: NaN };
  const vals = all.subarray(0, n);
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = vals[i] - mean; ss += d * d; }
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  vals.sort();
  const median = quantileSorted(vals, 0.5);
  const p16 = quantileSorted(vals, 0.15866), p84 = quantileSorted(vals, 0.84134);
  const rsd = (p84 - p16) / 2;
  return {
    n, mean, median, sd,
    gmean: logN ? Math.exp(logSum / logN) : NaN, gmeanN: logN,
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
  { key: 'gmean', label: 'Geo. Mean (values > 0)', perChannel: true },
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
