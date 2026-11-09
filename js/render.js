// Canvas rendering of dot / density / contour-free pseudocolor plots, histograms, overlays and gates.
import { makeTransform } from './transforms.js';

export const MARGIN = { l: 64, r: 14, t: 24, b: 48 };

// FlowJo-like pseudocolor LUT: blue -> cyan -> green -> yellow -> red
const STOPS = [[0, [0, 0, 200]], [0.25, [0, 170, 255]], [0.5, [0, 210, 60]], [0.75, [255, 230, 0]], [1, [230, 0, 0]]];
export const LUT = (() => {
  const lut = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0; while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    const [t0, c0] = STOPS[k], [t1, c1] = STOPS[k + 1];
    const f = (t - t0) / (t1 - t0);
    lut.push(c0.map((c, j) => Math.round(c + (c1[j] - c) * f)));
  }
  return lut;
})();

export const SERIES_COLORS = ['#d62728', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#7f7f7f', '#bcbd22', '#000000'];

export function layout(w, h) {
  const pw = w - MARGIN.l - MARGIN.r, ph = h - MARGIN.t - MARGIN.b;
  return {
    w, h, pw, ph,
    ux2px: u => MARGIN.l + u * pw,
    uy2px: u => MARGIN.t + (1 - u) * ph,
    px2ux: px => (px - MARGIN.l) / pw,
    px2uy: py => 1 - (py - MARGIN.t) / ph,
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function prepareCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/**
 * spec: {
 *   w, h, kind: 'density'|'dot'|'histogram', title,
 *   x: {name, label, cfg}, y: {name, label, cfg} | null,
 *   series: [{ ux, uy, idx, color, label }],
 *   hist: { mode: 'count'|'mode', smooth: bool, offset: 0..1, fill: bool, bins },
 *   gates: [{ gate, text, selected, color }]
 *   showLegend
 * }
 */
export function renderPlot(ctx, spec) {
  const L = layout(spec.w, spec.h);
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, spec.w, spec.h);
  // clip plot area for data
  ctx.save();
  ctx.beginPath(); ctx.rect(MARGIN.l, MARGIN.t, L.pw, L.ph); ctx.clip();
  if (spec.kind === 'histogram') drawHistograms(ctx, L, spec);
  else if (spec.kind === 'density' && spec.series.length === 1) drawDensity(ctx, L, spec.series[0], spec.density || {});
  else drawDots(ctx, L, spec.series, spec.kind === 'density');
  ctx.restore();
  drawAxes(ctx, L, spec);
  if (spec.gates) for (const g of spec.gates) drawGate(ctx, L, spec, g);
  if (spec.showLegend && spec.series.length > 1) drawLegend(ctx, L, spec.series);
  if (spec.title) {
    ctx.fillStyle = '#222'; ctx.font = '600 12px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(truncate(ctx, spec.title, spec.w - 12), 6, 5);
  }
  ctx.restore();
  return L;
}

function truncate(ctx, s, maxW) {
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 3 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

function drawDensity(ctx, L, s, opts) {
  const cell = 2;
  const nx = Math.max(1, Math.floor(L.pw / cell)), ny = Math.max(1, Math.floor(L.ph / cell));
  const grid = new Float32Array(nx * ny);
  const { ux, uy, idx } = s;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    let gx = Math.floor(ux[i] * nx), gy = Math.floor(uy[i] * ny);
    if (gx < 0) gx = 0; else if (gx >= nx) gx = nx - 1; // pile off-scale events on axes like FlowJo
    if (gy < 0) gy = 0; else if (gy >= ny) gy = ny - 1;
    grid[gy * nx + gx]++;
  }
  // light smoothing (3x3 box)
  const sm = opts.smooth === false ? grid : blur(grid, nx, ny);
  let max = 0; for (let i = 0; i < sm.length; i++) if (sm[i] > max) max = sm[i];
  const img = ctx.createImageData(nx, ny);
  const lmax = Math.log1p(max);
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const raw = grid[gy * nx + gx];
      if (raw <= 0 && sm[gy * nx + gx] <= 0.34) continue;
      const v = sm[gy * nx + gx];
      const t = lmax > 0 ? Math.log1p(v) / lmax : 0;
      const c = LUT[Math.min(255, Math.max(0, Math.round(t * 255)))];
      const o = ((ny - 1 - gy) * nx + gx) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
  }
  const off = new OffscreenCanvasOrCanvas(nx, ny);
  off.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, MARGIN.l, MARGIN.t, nx * cell, ny * cell);
}

function OffscreenCanvasOrCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

function blur(g, nx, ny) {
  const out = new Float32Array(g.length);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= ny) continue;
      for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= nx) continue;
        const wgt = dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
        s += g[yy * nx + xx] * wgt; n += wgt; } }
    out[y * nx + x] = s / n * 4; // keep isolated single events visible
  }
  return out;
}

function drawDots(ctx, L, series, densityColors) {
  const MAX = 60000;
  series.forEach((s, si) => {
    const { ux, uy, idx } = s;
    const step = Math.max(1, Math.ceil(idx.length / (MAX / Math.max(1, series.length))));
    ctx.fillStyle = s.color || (densityColors ? '#333' : '#222');
    if (series.length > 1) ctx.globalAlpha = 0.6;
    for (let k = 0; k < idx.length; k += step) {
      const i = idx[k];
      let x = ux[i], y = uy[i];
      x = Math.min(1, Math.max(0, x)); y = Math.min(1, Math.max(0, y));
      ctx.fillRect(L.ux2px(x) - 0.5, L.uy2px(y) - 0.5, 1.3, 1.3);
    }
    ctx.globalAlpha = 1;
  });
}

export function histogramCounts(ux, idx, bins) {
  const h = new Float64Array(bins);
  for (let k = 0; k < idx.length; k++) {
    const u = ux[idx[k]];
    if (!(u >= 0 && u < 1)) continue;
    h[Math.floor(u * bins)]++;
  }
  return h;
}

function smoothHist(h) {
  const k = [1, 4, 6, 4, 1];
  const out = new Float64Array(h.length);
  for (let i = 0; i < h.length; i++) {
    let s = 0, n = 0;
    for (let j = -2; j <= 2; j++) { const ii = i + j; if (ii < 0 || ii >= h.length) continue; s += h[ii] * k[j + 2]; n += k[j + 2]; }
    out[i] = s / n;
  }
  return out;
}

function drawHistograms(ctx, L, spec) {
  const opt = spec.hist || {};
  const bins = opt.bins || 256;
  const n = spec.series.length;
  const offset = n > 1 ? (opt.offset || 0) : 0;
  const hs = spec.series.map(s => {
    let h = histogramCounts(s.ux, s.idx, bins);
    if (opt.smooth) h = smoothHist(h);
    return h;
  });
  // Normalisation: 'mode' scales each series to its own peak; 'count' shares an axis
  let globalMax = 0; hs.forEach(h => h.forEach(v => { if (v > globalMax) globalMax = v; }));
  spec._histMax = globalMax;
  const bandH = n > 1 && offset > 0 ? 1 / (1 + offset * (n - 1)) : 1;
  // Draw last series first so first is on top when stacked
  for (let si = n - 1; si >= 0; si--) {
    const h = hs[si], s = spec.series[si];
    let max = opt.mode === 'mode' ? Math.max(...h) : globalMax;
    if (!max) max = 1;
    const base = si * offset * bandH;
    ctx.beginPath();
    ctx.moveTo(L.ux2px(0), L.uy2px(base));
    for (let b = 0; b < bins; b++) {
      const y = base + (h[b] / max) * bandH * 0.95;
      ctx.lineTo(L.ux2px(b / bins), L.uy2px(y));
      ctx.lineTo(L.ux2px((b + 1) / bins), L.uy2px(y));
    }
    ctx.lineTo(L.ux2px(1), L.uy2px(base));
    ctx.closePath();
    const color = s.color || '#333';
    if (opt.fill !== false) {
      const [r, g, b] = hexToRgb(color);
      ctx.fillStyle = n > 1 && offset === 0 ? `rgba(${r},${g},${b},0.25)` : `rgba(${r},${g},${b},0.55)`;
      ctx.fill();
    }
    ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.stroke();
    if (n > 1 && offset > 0 && s.label) {
      ctx.fillStyle = color; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText(s.label, L.ux2px(1) - 4, L.uy2px(base + bandH * 0.35));
    }
  }
}

function drawAxes(ctx, L, spec) {
  ctx.strokeStyle = '#444'; ctx.lineWidth = 1;
  ctx.strokeRect(MARGIN.l + 0.5, MARGIN.t + 0.5, L.pw, L.ph);
  ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = '#333';
  const tx = makeTransform(spec.x.cfg);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const t of tx.ticks()) {
    const u = tx.fwd(t.v); if (u < -0.001 || u > 1.001) continue;
    const px = Math.round(L.ux2px(u)) + 0.5;
    ctx.beginPath(); ctx.moveTo(px, MARGIN.t + L.ph); ctx.lineTo(px, MARGIN.t + L.ph + (t.major ? 6 : 3)); ctx.stroke();
    if (t.label) ctx.fillText(t.label, px, MARGIN.t + L.ph + 8);
  }
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.fillText(truncate(ctx, spec.x.label, L.pw), MARGIN.l + L.pw / 2, spec.h - 16);
  // Y axis
  ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  if (spec.kind === 'histogram') {
    const isMode = spec.hist?.mode === 'mode';
    const max = spec._histMax || 1;
    const ticks = isMode ? [0, 20, 40, 60, 80, 100].map(v => ({ v, u: v / 100 * 0.95, label: String(v) }))
      : niceCountTicks(max).map(v => ({ v, u: v / max * 0.95, label: v >= 1000 ? (v / 1000) + 'K' : String(v) }));
    const showTicks = !(spec.series.length > 1 && (spec.hist?.offset || 0) > 0);
    if (showTicks) for (const t of ticks) {
      if (t.u > 1) continue;
      const py = Math.round(L.uy2px(t.u)) + 0.5;
      ctx.beginPath(); ctx.moveTo(MARGIN.l - 5, py); ctx.lineTo(MARGIN.l, py); ctx.stroke();
      ctx.fillText(t.label, MARGIN.l - 7, py);
    }
    drawYLabel(ctx, L, isMode ? 'Normalized to Mode' : 'Count');
  } else {
    const ty = makeTransform(spec.y.cfg);
    for (const t of ty.ticks()) {
      const u = ty.fwd(t.v); if (u < -0.001 || u > 1.001) continue;
      const py = Math.round(L.uy2px(u)) + 0.5;
      ctx.beginPath(); ctx.moveTo(MARGIN.l - (t.major ? 6 : 3), py); ctx.lineTo(MARGIN.l, py); ctx.stroke();
      if (t.label) ctx.fillText(t.label, MARGIN.l - 8, py);
    }
    drawYLabel(ctx, L, spec.y.label);
  }
}

function drawYLabel(ctx, L, text) {
  ctx.save();
  ctx.translate(13, MARGIN.t + L.ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#333';
  ctx.fillText(truncate(ctx, text, L.ph), 0, 0);
  ctx.restore();
}

function niceCountTicks(max) {
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => max / s <= 5) || mag * 10;
  const out = []; for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}

function drawLegend(ctx, L, series) {
  ctx.font = '11px system-ui, sans-serif';
  const lineH = 15;
  const w = Math.min(L.pw * 0.6, Math.max(...series.map(s => ctx.measureText(s.label || '').width)) + 26);
  const x = MARGIN.l + L.pw - w - 6, y = MARGIN.t + 6;
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(x, y, w, series.length * lineH + 6);
  series.forEach((s, i) => {
    ctx.fillStyle = s.color; ctx.fillRect(x + 6, y + 6 + i * lineH, 10, 10);
    ctx.fillStyle = '#222'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(truncate(ctx, s.label || '', w - 26), x + 20, y + 4 + i * lineH);
  });
}

// ---- gates ----
export function gateGeometry(L, spec, g) {
  const tx = makeTransform(spec.x.cfg);
  const X = v => L.ux2px(v === -Infinity ? -0.05 : v === Infinity ? 1.05 : tx.fwd(v));
  if (g.type === 'interval') {
    const lvl = g.level ?? 0.85;
    return { kind: 'interval', x0: X(g.x0), x1: X(g.x1), y: L.uy2px(lvl) };
  }
  const ty = makeTransform(spec.y.cfg);
  const Y = v => L.uy2px(v === -Infinity ? -0.05 : v === Infinity ? 1.05 : ty.fwd(v));
  if (g.type === 'rect') return { kind: 'poly', pts: [[X(g.x0), Y(g.y0)], [X(g.x1), Y(g.y0)], [X(g.x1), Y(g.y1)], [X(g.x0), Y(g.y1)]] };
  if (g.type === 'polygon') return { kind: 'poly', pts: g.pts.map(([x, y]) => [X(x), Y(y)]) };
  if (g.type === 'quad') return { kind: 'quad', cx: X(g.cx), cy: Y(g.cy) };
  return null;
}

function drawGate(ctx, L, spec, item) {
  const { gate: g, text, selected } = item;
  const geo = gateGeometry(L, spec, g);
  if (!geo) return;
  const color = item.color || '#000';
  const cx = x => Math.min(MARGIN.l + L.pw - 2, Math.max(MARGIN.l + 2, x));
  const cy = y => Math.min(MARGIN.t + L.ph - 2, Math.max(MARGIN.t + 2, y));
  ctx.save();
  ctx.beginPath(); ctx.rect(MARGIN.l - 1, MARGIN.t - 1, L.pw + 2, L.ph + 2); ctx.clip();
  ctx.lineWidth = selected ? 2.2 : 1.4;
  ctx.strokeStyle = color;
  ctx.font = '600 11px system-ui, sans-serif';
  if (geo.kind === 'poly') {
    ctx.beginPath();
    geo.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath(); ctx.stroke();
    if (selected) { ctx.fillStyle = color; for (const [x, y] of geo.pts) ctx.fillRect(cx(x) - 3, cy(y) - 3, 6, 6); }
    // label above top-most point
    let top = geo.pts[0]; for (const p of geo.pts) if (p[1] < top[1]) top = p;
    const xs = geo.pts.map(p => cx(p[0]));
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const tw = ctx.measureText(text).width / 2 + 4;
    const lx = Math.min(MARGIN.l + L.pw - tw, Math.max(MARGIN.l + tw, mid));
    labelBox(ctx, text, lx, Math.max(MARGIN.t + 10, top[1] - 10), color);
  } else if (geo.kind === 'quad') {
    ctx.beginPath();
    ctx.moveTo(geo.cx, MARGIN.t); ctx.lineTo(geo.cx, MARGIN.t + L.ph);
    ctx.moveTo(MARGIN.l, geo.cy); ctx.lineTo(MARGIN.l + L.pw, geo.cy);
    ctx.stroke();
    if (selected) { ctx.fillStyle = color; ctx.fillRect(geo.cx - 4, geo.cy - 4, 8, 8); }
    const pos = { UL: [MARGIN.l + 4, MARGIN.t + 4, 'left', 'top'], UR: [MARGIN.l + L.pw - 4, MARGIN.t + 4, 'right', 'top'],
      LL: [MARGIN.l + 4, MARGIN.t + L.ph - 4, 'left', 'bottom'], LR: [MARGIN.l + L.pw - 4, MARGIN.t + L.ph - 4, 'right', 'bottom'] }[g.q];
    ctx.textAlign = pos[2]; ctx.textBaseline = pos[3];
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    const tw = ctx.measureText(text).width;
    ctx.fillRect(pos[2] === 'left' ? pos[0] - 2 : pos[0] - tw - 2, pos[3] === 'top' ? pos[1] - 1 : pos[1] - 13, tw + 4, 14);
    ctx.fillStyle = color; ctx.fillText(text, pos[0], pos[1]);
  } else if (geo.kind === 'interval') {
    ctx.beginPath();
    ctx.moveTo(geo.x0, geo.y - 8); ctx.lineTo(geo.x0, geo.y + 8);
    ctx.moveTo(geo.x1, geo.y - 8); ctx.lineTo(geo.x1, geo.y + 8);
    ctx.moveTo(geo.x0, geo.y); ctx.lineTo(geo.x1, geo.y);
    ctx.stroke();
    if (selected) { ctx.fillStyle = color; ctx.fillRect(cx(geo.x0) - 3, geo.y - 3, 6, 6); ctx.fillRect(cx(geo.x1) - 3, geo.y - 3, 6, 6); }
    const tw = ctx.measureText(text).width / 2 + 4;
    labelBox(ctx, text, Math.min(MARGIN.l + L.pw - tw, Math.max(MARGIN.l + tw, (cx(geo.x0) + cx(geo.x1)) / 2)), geo.y - 14, color);
  }
  ctx.restore();
}

function labelBox(ctx, text, x, y, color) {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(x - tw / 2 - 3, y - 8, tw + 6, 16);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}
