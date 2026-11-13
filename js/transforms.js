// Axis transforms. Each transform maps data value -> display unit in [0,1] (approximately) and back.


// Logicle (biexponential) display scale, written from its published mathematical definition
// (Parks, Roederer & Moore, Cytometry A 2006; parameterisation of Moore & Parks, Cytometry A 2012):
//   T = top of scale (data value at display 1), M = decades of the full scale, W = decades of the
//   near-linear zone, A = extra decades below zero.
// With w = W/(M+A), x2 = A/(M+A), x1 = x2 + w (display position of 0), x0 = x2 + 2w and
// b = (M+A)·ln 10, the data value at display position y >= x1 is the biexponential
//   B(y) = a·e^{b·y} − c·e^{−d·y} + f,
// where d solves 2·ln(d/b) + w·(b + d) = 0, c/a = e^{x0·(b+d)}, B(x1) = 0 and B(1) = T.
// Below x1 the scale is mirrored: B(x1 − s) = −B(x1 + s).
// Numerics (independent of any reference code): d by bisection on log d; B evaluated around x1 with
// expm1 (no cancellation near zero); data → display by a bracketed Newton/bisection search.
export class Logicle {
  constructor(T = 262144, W = 0.5, M = 4.5, A = 0) {
    if (!(T > 0)) throw new Error('Logicle T must be > 0');
    if (!(W >= 0)) throw new Error('Logicle W must be >= 0');
    if (!(M > 0)) throw new Error('Logicle M must be > 0');
    // out-of-range settings are brought into range; `adjusted` tells the caller (the UI warns)
    this.adjusted = false;
    if (W * 2 > M) { W = M / 2; this.adjusted = true; }
    if (-A > W || A + W > M - W) { A = 0; this.adjusted = true; }
    Object.assign(this, { T, W, M, A });
    const w = W / (M + A), x2 = A / (M + A), x1 = x2 + w, x0 = x2 + 2 * w, b = (M + A) * Math.LN10;
    const d = Logicle.solveD(b, w);
    const ca = Math.exp(x0 * (b + d));                 // c / a
    const g = Math.exp(b * x1) - ca * Math.exp(-d * x1); // −f / a (so that B(x1) = 0)
    const a = T / (Math.exp(b) - ca * Math.exp(-d) - g);
    // B(x1 + t) = P·expm1(b·t) − Q·expm1(−d·t)
    const P = a * Math.exp(b * x1), Q = a * ca * Math.exp(-d * x1);
    Object.assign(this, { w, x0, x1, x2, b, d, P, Q });
  }

  // root of 2·ln(d/b) + w·(b + d) = 0 in (0, b]
  static solveD(b, w) {
    if (w === 0) return b;
    const f = ld => 2 * (ld - Math.log(b)) + w * (b + Math.exp(ld));
    let lo = Math.log(b) - 200, hi = Math.log(b); // f(lo) < 0 <= f(hi)
    for (let i = 0; i < 200 && hi - lo > 1e-15 * Math.max(1, Math.abs(hi)); i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) < 0) lo = mid; else hi = mid;
    }
    return Math.exp((lo + hi) / 2);
  }

  // data value at offset t >= 0 above the zero point, and its derivative
  _B(t) { return this.P * Math.expm1(this.b * t) - this.Q * Math.expm1(-this.d * t); }
  _dB(t) { return this.P * this.b * Math.exp(this.b * t) + this.Q * this.d * Math.exp(-this.d * t); }

  // data -> display [0, 1] (beyond 0..1 for values outside the scale)
  scale(value) {
    if (value !== value) return NaN;
    if (value === Infinity) return Infinity;
    if (value === -Infinity) return -Infinity;
    if (value === 0) return this.x1;
    const v = Math.abs(value);
    // bracket t in [lo, hi] with B(lo) <= v <= B(hi); B is increasing
    let lo = 0, hi = Math.max(1e-6, Math.log1p(v / this.P) / this.b);
    while (this._B(hi) < v) { lo = hi; hi *= 2; }
    let t = Math.min(hi, Math.max(lo, v / this._dB(0) < hi ? v / this._dB(0) : (lo + hi) / 2));
    for (let i = 0; i < 100; i++) {
      const r = this._B(t) - v;
      if (r > 0) hi = t; else lo = t;
      let next = t - r / this._dB(t);
      if (!(next > lo && next < hi)) next = (lo + hi) / 2; // keep Newton inside the bracket
      if (Math.abs(next - t) <= 1e-15 * Math.max(1, t)) { t = next; break; }
      t = next;
    }
    return value < 0 ? this.x1 - t : this.x1 + t;
  }

  // display -> data
  inverse(y) {
    if (y !== y) return NaN;
    const t = y - this.x1;
    return t < 0 ? -this._B(-t) : this._B(t);
  }
}

// Fast logicle via lookup table + linear interpolation (used for bulk event transforms).
class FastLogicle {
  constructor(T, W, M, A, bins = 8192) {
    this.L = new Logicle(T, W, M, A);
    this.bins = bins;
    this.lut = new Float64Array(bins + 1);
    for (let i = 0; i <= bins; i++) this.lut[i] = this.L.inverse(i / bins);
  }
  scale(v) {
    const lut = this.lut, n = this.bins;
    if (!(v > lut[0]) || v >= lut[n]) return this.L.scale(v); // outside table range
    let lo = 0, hi = n;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (lut[mid] <= v) lo = mid; else hi = mid; }
    const t = (v - lut[lo]) / (lut[hi] - lut[lo]);
    return (lo + t) / n;
  }
  inverse(s) { return this.L.inverse(s); }
}

// What is wrong with a scale setting (a message for the user), or null if it can be used as it is.
export function scaleProblem(cfg) {
  const fin = k => Number.isFinite(cfg[k]);
  if (cfg.kind === 'linear' || cfg.kind === 'log' || cfg.kind === 'arcsinh') {
    if (!fin('min') || !fin('max')) return 'Minimum and maximum must be numbers.';
    if (!(cfg.max > cfg.min)) return 'The maximum must be larger than the minimum.';
    if (cfg.kind === 'log' && !(cfg.min > 0)) return 'A log scale needs a minimum above 0.';
    if (cfg.kind === 'arcsinh' && !(cfg.cofactor > 0)) return 'The cofactor must be larger than 0.';
  }
  if (cfg.kind === 'logicle') {
    if (!['T', 'W', 'M', 'A'].every(fin)) return 'T, W, M and A must all be numbers.';
    if (!(cfg.T > 0)) return 'T (top of scale) must be larger than 0.';
    if (!(cfg.M > 0)) return 'M (decades) must be larger than 0.';
    if (cfg.W < 0) return 'W must be 0 or more.';
    if (2 * cfg.W > cfg.M) return `W can be at most M/2 (${cfg.M / 2}).`;
    if (-cfg.A > cfg.W || cfg.A + cfg.W > cfg.M - cfg.W) return `A must be between −W and M − 2W (${-cfg.W} to ${+(cfg.M - 2 * cfg.W).toFixed(3)}).`;
  }
  return null;
}

// Build a transform object { kind, fwd(v)->unit, inv(u)->v, ticks() } from settings.
export function makeTransform(cfg) {
  const kind = cfg.kind || 'linear';
  if (kind === 'linear') {
    const min = cfg.min ?? 0, max = cfg.max ?? 262144;
    const span = (max - min) || 1;
    return {
      kind, cfg,
      fwd: v => (v - min) / span,
      inv: u => min + u * span,
      ticks: () => linearTicks(min, max),
    };
  }
  if (kind === 'log') {
    const min = Math.max(cfg.min ?? 1, 1e-3), max = cfg.max ?? 262144;
    const lmin = Math.log10(min), lspan = Math.log10(max) - lmin;
    return {
      kind, cfg,
      // values at or below 0 cannot be shown on a log scale: they, and tiny positive values, pile up
      // just below the axis, never below a larger value (so gates stay consistent)
      fwd: v => (v > 0 ? Math.max(-0.02, (Math.log10(v) - lmin) / lspan) : -0.02),
      inv: u => Math.pow(10, lmin + u * lspan),
      ticks: () => logTicks(min, max),
    };
  }
  if (kind === 'arcsinh') {
    const cof = cfg.cofactor || 150;
    const max = cfg.max ?? 262144;
    const min = cfg.min ?? -1000;
    const smin = Math.asinh(min / cof), smax = Math.asinh(max / cof), span = smax - smin;
    return {
      kind, cfg,
      fwd: v => (Math.asinh(v / cof) - smin) / span,
      inv: u => cof * Math.sinh(smin + u * span),
      ticks: () => biexTicks(min, max),
    };
  }
  if (kind === 'logicle') {
    const T = cfg.T ?? 262144, W = cfg.W ?? 0.5, M = cfg.M ?? 4.5, A = cfg.A ?? 0;
    const L = new FastLogicle(T, W, M, A);
    const lo = L.inverse(0);
    return {
      kind, cfg,
      fwd: v => L.scale(v),
      inv: u => L.inverse(u),
      ticks: () => biexTicks(lo, T),
    };
  }
  throw new Error('Unknown transform ' + kind);
}

function linearTicks(min, max) {
  const span = max - min;
  const raw = span / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= 6) || mag * 10;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push({ v, label: fmtNum(v), major: true });
  return ticks;
}

function logTicks(min, max) {
  const ticks = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    for (let m = 1; m < 10; m++) {
      const v = m * Math.pow(10, e);
      if (v < min || v > max) continue;
      ticks.push({ v, label: m === 1 ? sup10(e) : '', major: m === 1 });
    }
  }
  return ticks;
}

function biexTicks(min, max) {
  const ticks = [{ v: 0, label: '0', major: true }];
  for (let e = 1; e <= 7; e++) {
    for (let m = 1; m < 10; m++) {
      const v = m * Math.pow(10, e);
      if (v <= max) ticks.push({ v, label: m === 1 && e >= 2 ? sup10(e) : '', major: m === 1 && e >= 2 });
      if (-v >= min) ticks.push({ v: -v, label: m === 1 && e >= 2 ? '-' + sup10(e) : '', major: m === 1 && e >= 2 });
    }
  }
  return ticks;
}

const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
function sup10(e) { return '10' + String(e).split('').map(c => SUP[c]).join(''); }

export function fmtNum(v) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5) return (v / 1000).toFixed(0) + 'K';
  if (a >= 1e3) return (v / 1000).toFixed(a >= 1e4 ? 0 : 1) + 'K';
  if (a >= 1) return String(+v.toFixed(2));
  return v.toPrecision(2);
}

// Default transform for a channel based on its name.
export function defaultTransformFor(name, range) {
  const n = name.toUpperCase();
  const max = range && range > 1 ? range : 262144;
  if (/TIME/.test(n)) return { kind: 'linear', min: 0, max, auto: true };
  if (/^(FSC|SSC|BSC|FS|SS)/.test(n) || /(FSC|SSC)/.test(n)) return { kind: 'linear', min: 0, max, auto: true };
  if (/WIDTH|-W$/.test(n)) return { kind: 'linear', min: 0, max, auto: true };
  // Log-amplified legacy channels (e.g. FACSCalibur FL1-H with $PnE=4,1) span 1..10^4
  if (range && range <= 1024 * 64 && /LOG/.test(n)) return { kind: 'log', min: 1, max: 10000, auto: true };
  // Fluorescence: biexponential by default, with the top of scale at the instrument range.
  const T = Math.max(max, 1000);
  const M = Math.max(4.5, Math.log10(T) + 0.05);
  return { kind: 'logicle', T, W: 0.5, M: +M.toFixed(2), A: 0, auto: true };
}
