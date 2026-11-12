// Automatic gate: click on a population and get a polygon around it.
//
// 1. Events (display units, within the visible range) are binned on a grid and smoothed.
// 2. From the clicked bin we climb to the population's density peak.
// 3. The population is grown from the peak, highest density first, down to a fraction of the
//    peak density. A neighbouring population is not entered: when the growing region meets the
//    slope of another peak, that peak is merged only if it is a small bump on this population
//    (low prominence) and never if it is higher than this population's own peak.
// 4. The outline of the region is traced (marching squares) and simplified to a polygon.
import { gaussianBlur, marchingSquares } from './render.js';
import { pointInPolygon } from './gates.js';

const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

// Density grid of events inside the view box [x0,x1]×[y0,y1] (display units).
export function densityGrid(ux, uy, idx, box = { x: [0, 1], y: [0, 1] }, n = 128, sigma = 1.6) {
  const [x0, x1] = box.x, [y0, y1] = box.y;
  const grid = new Float32Array(n * n);
  const step = Math.max(1, Math.floor(idx.length / 300000)); // plenty for a density estimate
  for (let k = 0; k < idx.length; k += step) {
    const i = idx[k];
    const fx = (ux[i] - x0) / (x1 - x0), fy = (uy[i] - y0) / (y1 - y0);
    // events piled up off scale (on the axes) would form false peaks: leave them out
    if (!(fx > 0 && fx < 1 && fy > 0 && fy < 1)) continue;
    grid[Math.floor(fy * n) * n + Math.floor(fx * n)]++;
  }
  return { d: gaussianBlur(grid, n, n, sigma), n, box };
}

// Peak reached by steepest ascent from every bin (memoised)
function basins(d, n) {
  const up = new Int32Array(n * n).fill(-1), root = new Int32Array(n * n).fill(-1);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const b = y * n + x; let best = b, bv = d[b];
    for (const [dx, dy] of N8) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      const v = d[yy * n + xx];
      if (v > bv) { bv = v; best = yy * n + xx; }
    }
    up[b] = best;
  }
  const find = b => { const path = []; while (root[b] < 0 && up[b] !== b) { path.push(b); b = up[b]; } const r = root[b] >= 0 ? root[b] : b; root[b] = r; for (const p of path) root[p] = r; return r; };
  for (let b = 0; b < n * n; b++) find(b);
  return root;
}

class MaxHeap {
  constructor(d) { this.d = d; this.a = []; }
  push(b) { const a = this.a, d = this.d; a.push(b); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (d[a[p]] >= d[a[i]]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a, d = this.d, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && d[a[l]] > d[a[m]]) m = l; if (r < a.length && d[a[r]] > d[a[m]]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
  get size() { return this.a.length; }
}

// Mask (1 = in the population) grown from the clicked point. level: fraction of the peak density
// where the gate edge goes (smaller = looser gate). Returns null if there is nothing there.
export function populationMask(dens, click, { level = 0.08, prominence = 0.35 } = {}) {
  const { d, n, box } = dens;
  const fx = (click[0] - box.x[0]) / (box.x[1] - box.x[0]), fy = (click[1] - box.y[0]) / (box.y[1] - box.y[0]);
  if (!(fx >= 0 && fx < 1 && fy >= 0 && fy < 1)) return null;
  const root = basins(d, n);
  const peak = root[Math.floor(fy * n) * n + Math.floor(fx * n)];
  const P = d[peak];
  if (!(P > 0)) return null;
  const T = level * P;
  if (d[Math.floor(fy * n) * n + Math.floor(fx * n)] < T * 0.5) return null; // clicked on empty space
  const mask = new Uint8Array(n * n), seen = new Uint8Array(n * n);
  const ok = new Map([[peak, true]]); // basin peak -> part of this population?
  const heap = new MaxHeap(d);
  heap.push(peak); seen[peak] = 1;
  while (heap.size) {
    const b = heap.pop();
    mask[b] = 1;
    const x = b % n, y = (b - x) / n;
    for (const [dx, dy] of N8) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      const nb = yy * n + xx;
      if (seen[nb] || d[nb] < T) continue;
      const r = root[nb];
      if (!ok.has(r)) {
        // first contact with another peak's slope: d[nb] is (about) the saddle between the two
        const Q = d[r];
        ok.set(r, Q <= P && (Q - d[nb]) < prominence * Q);
      }
      if (!ok.get(r)) continue;
      seen[nb] = 1; heap.push(nb);
    }
  }
  return mask;
}

// Join marching-squares segments into closed loops
function loops(segs) {
  const key = (x, y) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
  const ends = new Map();
  segs.forEach((s, i) => { for (const k of [key(s[0], s[1]), key(s[2], s[3])]) { if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); } });
  const used = new Uint8Array(segs.length), out = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const pts = [[segs[i][0], segs[i][1]], [segs[i][2], segs[i][3]]];
    for (;;) {
      const [lx, ly] = pts.at(-1);
      const next = (ends.get(key(lx, ly)) || []).find(j => !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      const s = segs[next];
      pts.push(key(s[0], s[1]) === key(lx, ly) ? [s[2], s[3]] : [s[0], s[1]]);
    }
    out.push(pts);
  }
  return out;
}

function simplify(pts, tol) { // Douglas-Peucker on a closed loop
  const dp = (a, b, out) => {
    let best = -1, bi = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) { const v = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L; if (v > best) { best = v; bi = i; } }
    if (best > tol) { dp(a, bi, out); dp(bi, b, out); } else out.push(pts[a]);
  };
  // split the loop at its two farthest points
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) { const v = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (v > fd) { fd = v; far = i; } }
  const out = [];
  dp(0, far, out); dp(far, pts.length - 1, out);
  return out;
}

const area = pts => { let a = 0; for (let i = 0; i < pts.length; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length]; a += x0 * y1 - x1 * y0; } return Math.abs(a / 2); };

// Polygon (display units) around the population under `click`, or null.
export function autoGatePolygon(dens, click, opts = {}) {
  const mask = populationMask(dens, click, opts);
  if (!mask) return null;
  const { n, box } = dens;
  // a lightly smoothed mask gives a rounded outline; pad it so the outline closes at the edges
  const m = gaussianBlur(Float32Array.from(mask), n, n, 0.8);
  const toBox = ([fx, fy]) => [box.x[0] + fx * (box.x[1] - box.x[0]), box.y[0] + fy * (box.y[1] - box.y[0])];
  const cands = loops(marchingSquares(m, n, n, 0.35)).filter(l => l.length > 4);
  if (!cands.length) return null;
  const fx = (click[0] - box.x[0]) / (box.x[1] - box.x[0]), fy = (click[1] - box.y[0]) / (box.y[1] - box.y[0]);
  const inside = cands.filter(l => pointInPolygon(fx, fy, l));
  const best = (inside.length ? inside : cands).sort((a, b) => area(b) - area(a))[0];
  let poly = simplify(best, 0.6 / n);
  if (poly.length > 80) poly = simplify(best, 1.5 / n);
  if (poly.length < 3) return null;
  return poly.map(toBox);
}
