// Axis transforms. Each transform maps data value -> display unit in [0,1] (approximately) and back.
// Logicle implementation follows Moore & Parks (Cytometry A 2012) reference implementation.

const LN10 = Math.LN10;
const EPS = 2.220446049250313e-16;
const TAYLOR_LENGTH = 16;

export class Logicle {
  constructor(T = 262144, W = 0.5, M = 4.5, A = 0) {
    if (T <= 0) throw new Error('Logicle T must be > 0');
    if (W < 0) throw new Error('Logicle W must be >= 0');
    if (W * 2 > M) W = M / 2;
    if (-A > W || A + W > M - W) A = 0;
    Object.assign(this, { T, W, M, A });
    const w = W / (M + A);
    const x2 = A / (M + A);
    const x1 = x2 + w;
    const x0 = x2 + 2 * w;
    const b = (M + A) * LN10;
    const d = Logicle.solve(b, w);
    const c_a = Math.exp(x0 * (b + d));
    const mf_a = Math.exp(b * x1) - c_a / Math.exp(d * x1);
    const a = T / ((Math.exp(b) - mf_a) - c_a / Math.exp(d));
    const c = c_a * a;
    const f = -mf_a * a;
    Object.assign(this, { w, x0, x1, x2, a, b, c, d, f });
    this.xTaylor = x1 + w / 4;
    let posCoef = a * Math.exp(b * x1);
    let negCoef = -c / Math.exp(d * x1);
    this.taylor = new Float64Array(TAYLOR_LENGTH);
    for (let i = 0; i < TAYLOR_LENGTH; i++) {
      posCoef *= b / (i + 1);
      negCoef *= -d / (i + 1);
      this.taylor[i] = posCoef + negCoef;
    }
    this.taylor[1] = 0;
  }

  static solve(b, w) {
    if (w === 0) return b;
    const tolerance = 2 * b * EPS;
    let dLo = 0, dHi = b;
    let d = (dLo + dHi) / 2;
    const fB = -2 * Math.log(b) + w * b;
    let f = 2 * Math.log(d) + w * d + fB;
    let lastF = NaN;
    for (let i = 1; i < 40; i++) {
      const df = 2 / d + w;
      let delta;
      if (((d - dHi) * df - f) * ((d - dLo) * df - f) >= 0 || Math.abs(1.9 * f) > Math.abs(lastF * df)) {
        delta = (dHi - dLo) / 2;
        d = dLo + delta;
        if (d === dLo) return d;
      } else {
        delta = f / df;
        const t = d;
        d -= delta;
        if (d === t) return d;
      }
      if (Math.abs(delta) < tolerance) return d;
      f = 2 * Math.log(d) + w * d + fB;
      if (f === 0 || f === lastF) return d;
      lastF = f;
      if (f < 0) dLo = d; else dHi = d;
    }
    return d;
  }

  series(scale) {
    const x = scale - this.x1;
    const t = this.taylor;
    let sum = t[TAYLOR_LENGTH - 1] * x;
    for (let i = TAYLOR_LENGTH - 2; i >= 2; i--) sum = (sum + t[i]) * x;
    return (sum * x + t[0]) * x;
  }

  // data -> scale [0,1]
  scale(value) {
    if (value === 0) return this.x1;
    const negative = value < 0;
    if (negative) value = -value;
    let x = value < this.f ? this.x1 + value / this.taylor[0] : Math.log(value / this.a) / this.b;
    let tolerance = 3 * EPS;
    if (x > 1) tolerance = 3 * x * EPS;
    for (let i = 0; i < 20; i++) {
      const ae2bx = this.a * Math.exp(this.b * x);
      const ce2mdx = this.c / Math.exp(this.d * x);
      const y = x < this.xTaylor ? this.series(x) - value : (ae2bx + this.f) - (ce2mdx + value);
      const abe2bx = this.b * ae2bx;
      const cde2mdx = this.d * ce2mdx;
      const dy = abe2bx + cde2mdx;
      const ddy = this.b * abe2bx - this.d * cde2mdx;
      const delta = y / (dy * (1 - y * ddy / (2 * dy * dy)));
      x -= delta;
      if (Math.abs(delta) < tolerance) break;
    }
    return negative ? 2 * this.x1 - x : x;
  }

  // scale -> data
  inverse(scale) {
    const negative = scale < this.x1;
    if (negative) scale = 2 * this.x1 - scale;
    const v = scale < this.xTaylor ? this.series(scale)
      : (this.a * Math.exp(this.b * scale) + this.f) - this.c / Math.exp(this.d * scale);
    return negative ? -v : v;
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
      fwd: v => (v > 0 ? (Math.log10(v) - lmin) / lspan : -0.02),
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
