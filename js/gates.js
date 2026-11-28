// Gate definitions, membership evaluation and population statistics.
import { makeTransform } from './transforms.js';

// Colour-blind-safe gate colours: Okabe–Ito hues (Okabe & Ito 2008), adjusted to mid brightness so the outline and the
// label (drawn in the gate colour) read at 3:1 or better on both the white and the dark plot background.
export const GATE_COLORS = ['#d55e00', '#3a8fc4', '#009e73', '#cc79a7', '#a87b00', '#0072b2', '#7f7f7f'];
export const COLOR_SCHEMES = {
  Default: GATE_COLORS,
  Bright: ['#4477aa', '#ee6677', '#228833', '#ccbb44', '#66ccee', '#aa3377', '#bbbbbb'],
  Vibrant: ['#0077bb', '#ee7733', '#009988', '#cc3311', '#33bbee', '#ee3377', '#bbbbbb'],
};
export function validPalette(colors) {
  return Array.isArray(colors) && colors.length === GATE_COLORS.length && colors.every(c => /^#[0-9a-f]{6}$/i.test(c));
}


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

// Events beyond the plot are drawn piled up on its axes. When a user drags a gate edge or
// polygon vertex onto an axis edge, plotview/figureview records an explicit `snap` flag alongside
// the stored coordinate (-0.3 / 1.3 display units):
//   - rect / interval: `snap: { x0?, x1?, y0?, y1? }` (-1 = low axis, 1 = high axis, or boolean true
//     meaning low axis for x0/y0 and high axis for x1/y1).
//   - polygon: `snap: [[sx, sy], ...]` per vertex (-1 = low axis, 0 = finite, 1 = high axis).
// Finite coordinates without a `snap` flag are always evaluated at their exact (unclamped) display
// positions so changing an axis scale never turns a finite gate into ±Infinity. Older workspaces
// saved before `snap` existed have no `snap` metadata, so any ambiguous legacy coordinate (such as
// one saved at 1.3 display units) is evaluated as a finite value unless re-snapped onto an axis.
// NaN (missing) values are in no gate.
export const PILE_LO = -0.25, PILE_HI = 1.25;
export function snapBound(v, flag, defaultSign = 0) {
  if (flag === -1 || (flag === true && defaultSign < 0)) return -Infinity;
  if (flag === 1 || (flag === true && defaultSign > 0)) return Infinity;
  return v;
}
const inRange = (v, lo, hi) => v >= lo && (hi === Infinity ? v <= Infinity : v < hi);

// ---- per-sample gate adjustments ----
// A gate may carry overrides: { [sample.key]: geometry } (keyed by file name so they survive saving).
const GEOM_KEYS = {
  rect: ['x0', 'x1', 'y0', 'y1', 'snap'],
  polygon: ['pts', 'snap'],
  quad: ['cx', 'cy', 'quadMode', 'angles', 'offsets'],
  interval: ['x0', 'x1', 'level', 'snap'],
  split: ['cx'],
};
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
//  angled:   straight arms at independent angles (degrees, in display units, anticlockwise from +x);
//  staggered: arms: the up/down arms run vertically at their own x (offsets.up / .down) and
//            the right/left arms horizontally at their own y (offsets.right / .left), each joined to
//            the centre by a step (values in data units).
// Each quadrant is the region between two neighbouring arms, closed along a frame that extends well
// past the axes (and any out-of-frame centre/offsets); the four regions tile the plane.
export const ARMS = ['up', 'right', 'down', 'left'];
export const QUAD_REGION_ARMS = { UR: ['up', 'right'], LR: ['right', 'down'], LL: ['down', 'left'], UL: ['left', 'up'] };
export const DEFAULT_ANGLES = { up: 90, right: 0, down: 270, left: 180 };
const B0 = -0.5, B1 = 1.5; // minimum extended frame in display units
// 'spider' and 'offset' are the names used before v0.15.2 (saved workspaces still use them)
const LEGACY_QMODE = { spider: 'angled', offset: 'staggered' };
export const quadMode = g => LEGACY_QMODE[g.quadMode] || g.quadMode || 'standard';

function frameBounds(xs, ys) {
  let b0 = B0, b1 = B1;
  for (const v of xs) if (Number.isFinite(v)) { b0 = Math.min(b0, v - 1); b1 = Math.max(b1, v + 1); }
  for (const v of ys) if (Number.isFinite(v)) { b0 = Math.min(b0, v - 1); b1 = Math.max(b1, v + 1); }
  return [b0, b1];
}

function rayToFrame([x, y], deg, b0 = B0, b1 = B1) {
  const dx = Math.cos(deg * Math.PI / 180), dy = Math.sin(deg * Math.PI / 180);
  let t = Infinity;
  if (dx > 1e-12) t = Math.min(t, (b1 - x) / dx); else if (dx < -1e-12) t = Math.min(t, (b0 - x) / dx);
  if (dy > 1e-12) t = Math.min(t, (b1 - y) / dy); else if (dy < -1e-12) t = Math.min(t, (b0 - y) / dy);
  return [x + dx * t, y + dy * t];
}

// Arms as polylines from the centre to the extended frame, in display units (0..1 = the plot).
export function quadArms(g, tx, ty) {
  const c = [tx.fwd(g.cx), ty.fwd(g.cy)];
  const m = quadMode(g);
  if (m === 'angled') {
    const [b0, b1] = frameBounds([c[0]], [c[1]]);
    const a = { ...DEFAULT_ANGLES, ...(g.angles || {}) };
    return { c, b0, b1, arms: Object.fromEntries(ARMS.map(k => [k, [c, rayToFrame(c, a[k], b0, b1)]])) };
  }
  if (m === 'staggered') {
    const o = g.offsets || {};
    const xu = tx.fwd(o.up ?? g.cx), xd = tx.fwd(o.down ?? g.cx), yr = ty.fwd(o.right ?? g.cy), yl = ty.fwd(o.left ?? g.cy);
    const [b0, b1] = frameBounds([c[0], xu, xd], [c[1], yr, yl]);
    // each arm leaves the centre along its own direction until it is past the neighbouring arms' jogs,
    // then steps sideways to its own line: arms never cross, so the four regions always tile the plane
    const top = Math.max(c[1], yl, yr), bot = Math.min(c[1], yl, yr);
    const rgt = Math.max(c[0], xu, xd), lft = Math.min(c[0], xu, xd);
    return { c, b0, b1, arms: {
      up: [c, [c[0], top], [xu, top], [xu, b1]], down: [c, [c[0], bot], [xd, bot], [xd, b0]],
      right: [c, [rgt, c[1]], [rgt, yr], [b1, yr]], left: [c, [lft, c[1]], [lft, yl], [b0, yl]],
    } };
  }
  const [b0, b1] = frameBounds([c[0]], [c[1]]);
  return { c, b0, b1, arms: { up: [c, [c[0], b1]], right: [c, [b1, c[1]]], down: [c, [c[0], b0]], left: [c, [b0, c[1]]] } };
}

// position along the frame [b0, b1]^2, clockwise from the top-left corner (0..4*(b1-b0))
function frameT([x, y], b0 = B0, b1 = B1) {
  const S = b1 - b0, e = 1e-9 * Math.max(1, S);
  if (Math.abs(y - b1) < e) return x - b0;
  if (Math.abs(x - b1) < e) return S + (b1 - y);
  if (Math.abs(y - b0) < e) return 2 * S + (b1 - x);
  return 3 * S + (y - b0);
}

// Polygon (display units) of one quadrant: arm A out, clockwise along the frame, arm B back.
export function quadRegion(armsObj, q) {
  const b0 = armsObj.b0 ?? B0, b1 = armsObj.b1 ?? B1;
  const S = b1 - b0, P = 4 * S;
  const corners = [[0, [b0, b1]], [S, [b1, b1]], [2 * S, [b1, b0]], [3 * S, [b0, b0]]];
  const [ka, kb] = QUAD_REGION_ARMS[q];
  const A = armsObj.arms[ka], B = armsObj.arms[kb];
  const ta = frameT(A.at(-1), b0, b1);
  let tb = frameT(B.at(-1), b0, b1);
  if (tb <= ta) tb += P;
  const walk = [];
  for (const add of [0, P]) for (const [t, pt] of corners) if (t + add > ta && t + add < tb) walk.push(pt);
  return [...A, ...walk, ...B.slice().reverse().slice(0, -1)];
}

const TAU = 2 * Math.PI;
const normAngle = r => ((r % TAU) + TAU) % TAU;

// Exact analytical classification for angled quadrants: half-open polar sectors [θ_k, θ_{k+1}),
// centre assigned deterministically to UR, NaN in no quadrant, ±Infinity handled natively by atan2.
function angledQuadMask(ux, uy, cx, cy, angles, q, out) {
  const a = { ...DEFAULT_ANGLES, ...(angles || {}) };
  const sectors = [
    { q: 'UR', s: normAngle(a.right * Math.PI / 180) },
    { q: 'UL', s: normAngle(a.up * Math.PI / 180) },
    { q: 'LL', s: normAngle(a.left * Math.PI / 180) },
    { q: 'LR', s: normAngle(a.down * Math.PI / 180) },
  ].sort((p, r) => p.s - r.s);
  const s0 = sectors[0].s, s1 = sectors[1].s, s2 = sectors[2].s, s3 = sectors[3].s;
  const q0 = sectors[0].q, q1 = sectors[1].q, q2 = sectors[2].q, q3 = sectors[3].q;
  for (let i = 0; i < out.length; i++) {
    const x = ux[i], y = uy[i];
    if (x !== x || y !== y) continue; // NaN: in no quadrant
    let hit;
    if (x === cx && y === cy) {
      hit = 'UR';
    } else {
      const ang = normAngle(Math.atan2(y - cy, x - cx));
      if (ang >= s3 || ang < s0) hit = q3;
      else if (ang >= s2) hit = q2;
      else if (ang >= s1) hit = q1;
      else hit = q0;
    }
    out[i] = hit === q ? 1 : 0;
  }
  return out;
}

// Exact analytical classification for staggered quadrants: every finite and ±Infinity point
// lands in exactly one quadrant, regardless of axis scale or out-of-frame offsets.
function staggeredQuadMask(ux, uy, cx, cy, xu, xd, yr, yl, q, out) {
  const top = Math.max(cy, yl, yr), bot = Math.min(cy, yl, yr);
  const rgt = Math.max(cx, xu, xd), lft = Math.min(cx, xu, xd);
  for (let i = 0; i < out.length; i++) {
    const x = ux[i], y = uy[i];
    if (x !== x || y !== y) continue; // NaN: in no quadrant
    let hit;
    if (y >= top) hit = x >= xu ? 'UR' : 'UL';
    else if (y < bot) hit = x >= xd ? 'LR' : 'LL';
    else if (x >= rgt) hit = y >= yr ? 'UR' : 'LR';
    else if (x < lft) hit = y >= yl ? 'UL' : 'LL';
    else hit = x >= cx ? (y >= cy ? 'UR' : 'LR') : (y >= cy ? 'UL' : 'LL');
    out[i] = hit === q ? 1 : 0;
  }
  return out;
}

// Handles for reshaping (display units): one on each arm (angled: along the arm; staggered: on its outer part)
export function quadHandles(g, tx, ty) {
  const { c, arms } = quadArms(g, tx, ty);
  const m = quadMode(g);
  if (m === 'standard') return {};
  const clip = v => Math.min(0.97, Math.max(0.03, v));
  const out = {};
  for (const k of ARMS) {
    const a = arms[k];
    if (m === 'angled') {
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

function polygonMask(ux, uy, pts, out, snap = null) {
  const sp = Array.isArray(snap) && snap.length === pts.length ? snap : null;
  let snapLoX = false, snapHiX = false, snapLoY = false, snapHiY = false;
  let finMinX = Infinity, finMaxX = -Infinity, finMinY = Infinity, finMaxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const sx = sp ? sp[i]?.[0] || 0 : 0;
    const sy = sp ? sp[i]?.[1] || 0 : 0;
    const [x, y] = pts[i];
    if (sx < 0) snapLoX = true; else if (sx > 0) snapHiX = true;
    else { if (x < finMinX) finMinX = x; if (x > finMaxX) finMaxX = x; }
    if (sy < 0) snapLoY = true; else if (sy > 0) snapHiY = true;
    else { if (y < finMinY) finMinY = y; if (y > finMaxY) finMaxY = y; }
  }
  const hasSnap = snapLoX || snapHiX || snapLoY || snapHiY;
  const loX = Math.min(PILE_LO, Number.isFinite(finMinX) ? finMinX - 0.25 : PILE_LO);
  const hiX = Math.max(PILE_HI, Number.isFinite(finMaxX) ? finMaxX + 0.25 : PILE_HI);
  const loY = Math.min(PILE_LO, Number.isFinite(finMinY) ? finMinY - 0.25 : PILE_LO);
  const hiY = Math.max(PILE_HI, Number.isFinite(finMaxY) ? finMaxY + 0.25 : PILE_HI);
  const effPts = hasSnap ? pts.map(([x, y], i) => [
    sp[i]?.[0] < 0 ? loX - 0.05 : sp[i]?.[0] > 0 ? hiX + 0.05 : x,
    sp[i]?.[1] < 0 ? loY - 0.05 : sp[i]?.[1] > 0 ? hiY + 0.05 : y,
  ]) : pts;
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const [x, y] of effPts) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  for (let i = 0; i < out.length; i++) {
    const rx = ux[i], ry = uy[i];
    if (rx !== rx || ry !== ry) continue; // NaN: in no gate
    const x = snapLoX && rx < loX ? loX : snapHiX && rx > hiX ? hiX : rx;
    const y = snapLoY && ry < loY ? loY : snapHiY && ry > hiY ? hiY : ry;
    if (x < minx || x > maxx || y < miny || y > maxy) continue;
    out[i] = pointInPolygon(x, y, effPts) ? 1 : 0;
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
    const out = [], visited = new Set();
    let g = this.gates.get(id);
    while (g && !visited.has(g.id)) {
      visited.add(g.id);
      out.unshift(g);
      g = g.parent ? this.gates.get(g.parent) : null;
    }
    return out;
  }
  fullName(id) { return id ? this.path(id).map(g => g.name).join('/') : 'All Events'; }

  canApply(sample, g) { return gateChannels(g).every(c => sample.hasChannel(c)); }
  // Channels a population needs that the sample does not have (its own gate or any gate above it).
  // [] = the population can be evaluated; otherwise it is NOT measured for this sample (blank, never 0).
  missingChannels(sample, gateId) {
    const out = [];
    for (const g of gateId ? this.path(gateId) : []) for (const c of gateChannels(gateFor(g, sample))) if (!sample.hasChannel(c) && !out.includes(c)) out.push(c);
    return out;
  }

  _test(sample, g) {
    g = gateFor(g, sample);
    const N = sample.events;
    const out = new Uint8Array(N);
    if (!this.canApply(sample, g)) return out; // channels missing -> empty
    if (g.type === 'quad' && quadMode(g) !== 'standard') {
      const cfgX = this.getCfg(g.x), cfgY = this.getCfg(g.y);
      const tx = makeTransform(cfgX), ty = makeTransform(cfgY);
      const ux = sample.unit(g.x, cfgX), uy = sample.unit(g.y, cfgY);
      const cx = f32(tx.fwd(g.cx)), cy = f32(ty.fwd(g.cy));
      if (quadMode(g) === 'angled') return angledQuadMask(ux, uy, cx, cy, g.angles, g.q, out);
      const o = g.offsets || {};
      const xu = f32(tx.fwd(o.up ?? g.cx)), xd = f32(tx.fwd(o.down ?? g.cx));
      const yr = f32(ty.fwd(o.right ?? g.cy)), yl = f32(ty.fwd(o.left ?? g.cy));
      return staggeredQuadMask(ux, uy, cx, cy, xu, xd, yr, yl, g.q, out);
    }
    if (g.type === 'rect' || g.type === 'quad' || g.type === 'interval' || g.type === 'split') {
      let x0, x1, y0 = -Infinity, y1 = Infinity;
      const sp = g.snap && typeof g.snap === 'object' ? g.snap : null;
      if (g.type === 'rect') {
        x0 = snapBound(g.x0, sp?.x0, -1); x1 = snapBound(g.x1, sp?.x1, 1);
        y0 = snapBound(g.y0, sp?.y0, -1); y1 = snapBound(g.y1, sp?.y1, 1);
      } else if (g.type === 'interval') {
        x0 = snapBound(g.x0, sp?.x0, -1); x1 = snapBound(g.x1, sp?.x1, 1);
      } else if (g.type === 'split') { x0 = g.side === 'L' ? -Infinity : g.cx; x1 = g.side === 'L' ? g.cx : Infinity; }
      else {
        const right = g.q === 'UR' || g.q === 'LR', up = g.q === 'UR' || g.q === 'UL';
        x0 = right ? g.cx : -Infinity; x1 = right ? Infinity : g.cx;
        y0 = up ? g.cy : -Infinity; y1 = up ? Infinity : g.cy;
      }
      const cfgX = this.getCfg(g.x);
      const tx = makeTransform(cfgX);
      const ux = sample.unit(g.x, cfgX);
      const [lox, hix] = unitRange(tx, x0, x1);
      if (isOneD(g)) {
        for (let i = 0; i < N; i++) out[i] = inRange(ux[i], lox, hix) ? 1 : 0;
        return out;
      }
      const cfgY = this.getCfg(g.y);
      const ty = makeTransform(cfgY);
      const uy = sample.unit(g.y, cfgY);
      const [loy, hiy] = unitRange(ty, y0, y1);
      for (let i = 0; i < N; i++) out[i] = inRange(ux[i], lox, hix) && inRange(uy[i], loy, hiy) ? 1 : 0;
      return out;
    }
    if (g.type === 'polygon') {
      const cfgX = this.getCfg(g.x), cfgY = this.getCfg(g.y);
      const tx = makeTransform(cfgX), ty = makeTransform(cfgY);
      const pts = g.pts.map(([x, y]) => [f32(tx.fwd(x)), f32(ty.fwd(y))]);
      return polygonMask(sample.unit(g.x, cfgX), sample.unit(g.y, cfgY), pts, out, g.snap);
    }
    throw new Error('Unknown gate type ' + g.type);
  }

  // Returns { mask: Uint8Array|null (null = all), idx: Uint32Array, count }
  population(sample, gateId, _vis = null) {
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
      if (!g || (_vis && _vis.has(gateId))) {
        return { mask: new Uint8Array(sample.events), idx: new Uint32Array(0), count: 0 };
      }
      const vis = _vis || new Set();
      vis.add(gateId);
      const parent = this.population(sample, g.parent, vis);
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
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : NaN;
  vals.sort();
  const median = quantileSorted(vals, 0.5);
  const p16 = quantileSorted(vals, 0.15866), p84 = quantileSorted(vals, 0.84134);
  const rsd = n > 1 ? (p84 - p16) / 2 : NaN;
  return {
    n, mean, median, sd,
    gmean: logN ? Math.exp(logSum / logN) : NaN, gmeanN: logN,
    cv: n > 1 && mean !== 0 ? 100 * sd / Math.abs(mean) : NaN,
    rsd,
    rcv: n > 1 && median !== 0 ? 100 * rsd / Math.abs(median) : NaN,
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

// Count and percentages of a population. available: false (with the missing channels named and NaN values) when
// the population cannot be evaluated for this sample, so callers show a blank instead of a measured 0.
export function populationStats(engine, sample, gateId) {
  const missing = engine.missingChannels(sample, gateId);
  if (missing.length) return { available: false, missing, count: NaN, pctParent: NaN, pctTotal: NaN };
  const pop = engine.population(sample, gateId);
  const g = gateId ? engine.get(gateId) : null;
  const parent = g ? engine.population(sample, g.parent) : pop;
  return {
    available: true, missing,
    count: pop.count,
    pctParent: parent.count ? 100 * pop.count / parent.count : NaN,
    pctTotal: sample.events ? 100 * pop.count / sample.events : NaN,
  };
}

// One wording everywhere a population cannot be measured because a channel is missing:
// "no CD3 in this sample", "no CD3 or CD4 in this sample" (or "in <sample name>" where several samples are listed).
export const orList = a => (a.length > 1 ? a.slice(0, -1).join(', ') + ' or ' + a.at(-1) : a[0] || '');
export const missingPhrase = (channels, where = 'this sample') => `no ${orList(channels)} in ${where}`;

// One Statistics-table value: a population statistic (ch = null) or a per-channel statistic. NaN = blank
// (not measured: the population or the channel is not in this sample, or nothing to compute).
// cache: optional Map shared across one sample's columns.
export function statValue(engine, sample, pid, stat, ch = null, cache = null) {
  if (!ch) return (pid ? populationStats(engine, sample, pid) : { count: sample.events, pctTotal: 100, pctParent: NaN })[stat];
  if (!sample.hasChannel(ch) || engine.missingChannels(sample, pid).length) return NaN;
  const key = (pid || '') + '|' + ch;
  let cs = cache?.get(key);
  if (!cs) { cs = channelStats(sample.column(ch), engine.population(sample, pid).idx); cache?.set(key, cs); }
  return cs[stat];
}

// Few decimals for display, but a small non-zero value keeps two significant figures (0.003, not 0.00).
const fixedOrSmall = (v, d) => v !== 0 && Math.abs(v) < 10 ** -d
  ? v.toFixed(Math.min(20, 1 - Math.floor(Math.log10(Math.abs(v))))).replace(/0+$/, '')
  : v.toFixed(d);
// On-screen text of a statistic (rounded for reading). Blank when not measured.
export function formatStat(v, stat) {
  if (!Number.isFinite(v)) return '';
  if (stat === 'count') return String(v);
  if (/pct|cv/i.test(stat)) return fixedOrSmall(v, 2);
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toPrecision(4);
}
// Text of a statistic for CSV, Copy, Open in Thistle Plot and the table's data-v: full precision, blank when not measured.
export const exportStat = v => Number.isFinite(v) ? String(v) : '';
// Percent label on plots and in the gate tree
export const fmtPct = v => (Number.isFinite(v) ? (v >= 10 ? v.toFixed(1) : fixedOrSmall(v, 2)) + '%' : '–');
