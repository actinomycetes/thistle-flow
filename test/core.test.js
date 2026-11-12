import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFCS, writeFCS, parseText, parseSpillover } from '../js/fcs.js';
import { Logicle, makeTransform } from '../js/transforms.js';
import { Sample, invertMatrix } from '../js/model.js';
import { GateEngine, channelStats, populationStats } from '../js/gates.js';
import { makeDemoFile } from '../js/demo.js';

test('FCS round trip (float, little endian)', () => {
  const cols = [Float32Array.from([1, 2, 3]), Float32Array.from([-5, 0, 1e5])];
  const buf = writeFCS({ names: ['A', 'B|x'], labels: ['', 'CD4'], columns: cols });
  const [ds] = parseFCS(buf, 't.fcs');
  assert.equal(ds.events, 3);
  assert.deepEqual(ds.params.map(p => p.name), ['A', 'B|x']); // escaped delimiter
  assert.equal(ds.params[1].label, 'CD4');
  assert.deepEqual([...ds.columns[1]], [-5, 0, 1e5]);
});

test('integer big-endian FCS 2.0 with log amplification', () => {
  const text = '/$BYTEORD/4,3,2,1/$DATATYPE/I/$MODE/L/$PAR/2/$TOT/2/$P1N/FSC/$P1B/16/$P1R/1024/$P1E/0,0/$P2N/FL1/$P2B/16/$P2R/1024/$P2E/4,1/';
  const tStart = 58, tEnd = tStart + text.length - 1, dStart = tEnd + 1, dEnd = dStart + 8 - 1;
  const pad = n => String(n).padStart(8, ' ');
  const hdr = 'FCS2.0    ' + pad(tStart) + pad(tEnd) + pad(dStart) + pad(dEnd) + pad(0) + pad(0);
  const buf = new Uint8Array(dEnd + 1);
  buf.set(new TextEncoder().encode(hdr), 0);
  buf.set(new TextEncoder().encode(text), tStart);
  const dv = new DataView(buf.buffer);
  dv.setUint16(dStart, 100, false); dv.setUint16(dStart + 2, 512, false);
  dv.setUint16(dStart + 4, 1023, false); dv.setUint16(dStart + 6, 0, false);
  const [ds] = parseFCS(buf.buffer);
  assert.equal(ds.columns[0][0], 100);
  assert.ok(Math.abs(ds.columns[1][0] - 100) < 1e-3); // 10^(4*512/1024) = 100
  assert.ok(Math.abs(ds.columns[1][1] - 1) < 1e-6);
});

test('spillover parse + inverse', () => {
  const s = parseSpillover('2,FITC-A,PE-A,1,0.2,0.01,1');
  assert.deepEqual(s.names, ['FITC-A', 'PE-A']);
  const inv = invertMatrix(s.matrix);
  const id = s.matrix.map((r, i) => r.map((_, j) => r.reduce((acc, v, k) => acc + v * inv[k][j], 0)));
  assert.ok(Math.abs(id[0][0] - 1) < 1e-12 && Math.abs(id[0][1]) < 1e-12);
});

test('logicle scale/inverse are consistent', () => {
  const L = new Logicle(262144, 0.5, 4.5, 0);
  for (const v of [-1000, -10, 0, 1, 50, 1000, 1e4, 262144]) {
    const u = L.scale(v);
    assert.ok(Math.abs(L.inverse(u) - v) < Math.max(1e-6, Math.abs(v) * 1e-9), `v=${v}`);
  }
  assert.ok(Math.abs(L.scale(262144) - 1) < 1e-9);
  const fast = makeTransform({ kind: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 });
  for (const v of [-500, 0, 300, 12345]) assert.ok(Math.abs(fast.fwd(v) - L.scale(v)) < 1e-5);
});

test('demo file: compensation recovers single-stain, gating and stats work', () => {
  const [ds] = parseFCS(makeDemoFile('d.fcs', 0.5, 7, 20000), 'd.fcs');
  assert.ok(ds.spill && ds.spill.names.length === 5);
  const s = new Sample(ds);
  const cfgs = {};
  const getCfg = ch => cfgs[ch] || (ch.startsWith('FSC') || ch.startsWith('SSC') ? { kind: 'linear', min: 0, max: 262144 } : { kind: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 });
  const eng = new GateEngine(getCfg);
  eng.add({ id: 'g1', name: 'Lymph', parent: null, type: 'polygon', x: 'FSC-A', y: 'SSC-A', pts: [[40000, 8000], [80000, 8000], [80000, 38000], [40000, 38000]] });
  eng.add({ id: 'g2', name: 'CD3+', parent: 'g1', type: 'interval', x: 'FITC-A', x0: 1000, x1: 262144 });
  eng.add({ id: 'q1', name: 'CD4+CD8-', parent: 'g2', type: 'quad', group: 'Q', q: 'LR', x: 'PE-A', y: 'APC-A', cx: 800, cy: 800 });
  const lymph = populationStats(eng, s, 'g1');
  assert.ok(lymph.pctTotal > 55 && lymph.pctTotal < 75, 'lymph % ' + lymph.pctTotal);
  const t = populationStats(eng, s, 'g2');
  assert.ok(t.pctParent > 55 && t.pctParent < 75, 'CD3 % ' + t.pctParent);
  const cd4 = populationStats(eng, s, 'q1');
  assert.ok(cd4.pctParent > 50 && cd4.pctParent < 70, 'CD4 % ' + cd4.pctParent);
  // CD3+ cells are FITC bright: with compensation PE spill from FITC should be removed in CD8 (CD4-) T cells
  const pop = eng.population(s, 'g2');
  const statsComp = channelStats(s.column('FITC-A'), pop.idx);
  assert.ok(statsComp.median > 2500 && statsComp.median < 6000, 'FITC median ' + statsComp.median);
  // CD8 T cells (CD4-negative): FITC (CD3) spills ~18% into PE. Compensation should bring PE back to ~background.
  eng.add({ id: 'q2', name: 'CD4-CD8+', parent: 'g2', type: 'quad', group: 'Q', q: 'UL', x: 'PE-A', y: 'APC-A', cx: 800, cy: 800 });
  const cd8 = eng.population(s, 'q2');
  const peComp = channelStats(s.column('PE-A'), cd8.idx).median;
  s.setCompEnabled(false); eng.invalidate();
  assert.ok(s.column('PE-A') === s.raw[s.channelIndex('PE-A')]);
  const peRaw = channelStats(s.column('PE-A'), cd8.idx).median;
  assert.ok(peComp < 200, 'compensated PE median in CD8 ' + peComp);
  assert.ok(peRaw > 500, 'uncompensated PE median in CD8 ' + peRaw);
});

test('quadrant styles: spider and offset quadrants tile the parent; defaults equal the straight cross', async () => {
  const { quadArms, quadRegion, pointInPolygon } = await import('../js/gates.js');
  const [ds] = parseFCS(makeDemoFile('q.fcs', 0.5, 7, 20000), 'q.fcs');
  const s = new Sample(ds);
  const getCfg = ch => (ch.startsWith('FSC') || ch.startsWith('SSC') ? { kind: 'linear', min: 0, max: 262144 } : { kind: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 });
  const counts = geom => {
    const eng = new GateEngine(getCfg);
    for (const q of ['UL', 'UR', 'LR', 'LL']) eng.add({ id: q, name: q, parent: null, type: 'quad', group: 'Q', q, x: 'PE-A', y: 'APC-A', cx: 800, cy: 800, ...geom });
    return Object.fromEntries(['UL', 'UR', 'LR', 'LL'].map(q => [q, eng.population(s, q).idx.length]));
  };
  const N = s.events;
  const std = counts({});
  const sum = c => Object.values(c).reduce((a, b) => a + b, 0);
  assert.equal(sum(std), N);
  // default spider / offset = the standard cross
  assert.deepEqual(counts({ quadMode: 'spider', angles: { up: 90, right: 0, down: 270, left: 180 } }), std);
  assert.deepEqual(counts({ quadMode: 'offset', offsets: { up: 800, down: 800, right: 800, left: 800 } }), std);
  // reshaped: every event still in exactly one quadrant
  const sp = counts({ quadMode: 'spider', angles: { up: 70, right: 20, down: 250, left: 170 } });
  assert.equal(sum(sp), N); assert.notDeepEqual(sp, std);
  const of = counts({ quadMode: 'offset', offsets: { up: 3000, down: 300, right: 2000, left: 200 } });
  assert.equal(sum(of), N); assert.notDeepEqual(of, std);
  // offset: up arm moved left, so UL shrinks and UR grows by the same events; the lower half is unchanged
  const of2 = counts({ quadMode: 'offset', offsets: { up: 10, down: 800, right: 800, left: 800 } });
  assert.ok(of2.UL < std.UL && of2.UR > std.UR && of2.UL + of2.UR === std.UL + std.UR, JSON.stringify([of2, std]));
  assert.ok(of2.LR === std.LR && of2.LL === std.LL);
  // geometry: regions tile an extended grid for awkward settings too
  const id = { fwd: v => v, inv: v => v };
  const g = { cx: 0.3, cy: 0.7, quadMode: 'offset', offsets: { up: 0.1, down: 0.6, right: 0.9, left: 0.2 } };
  const arms = quadArms(g, id, id);
  for (let x = -0.3; x < 1.3; x += 0.031) for (let y = -0.3; y < 1.3; y += 0.029) {
    const n = ['UR', 'LR', 'LL', 'UL'].filter(q => pointInPolygon(x, y, quadRegion(arms, q))).length;
    assert.equal(n, 1, `point ${x},${y} in ${n} quadrants`);
  }
});

test('event limit shows exactly that many events, the same ones every time, in order', async () => {
  const { subsampleIdx } = await import('../js/plotview.js');
  for (const [n, max] of [[40000, 5000], [40000, 1000], [123457, 10000], [5200, 5000], [3000, 5000]]) {
    const idx = Uint32Array.from({ length: n }, (_, i) => i * 3 + 7);
    const a = subsampleIdx(idx, max);
    assert.equal(a.length, Math.min(n, max), `${n} -> ${max}`);
    for (let i = 1; i < a.length; i++) assert.ok(a[i] > a[i - 1], 'kept in order');
    assert.deepEqual([...subsampleIdx(Uint32Array.from(idx), max)], [...a], 'deterministic');
  }
});

test('auto gate: a click outlines the population under it, not its neighbours', async () => {
  const { densityGrid, autoGatePolygon } = await import('../js/autogate.js');
  const { pointInPolygon } = await import('../js/gates.js');
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const ux = [], uy = [], lab = [];
  const blobs = [[0.3, 0.3, 0.04, 20000], [0.45, 0.35, 0.035, 8000], [0.7, 0.7, 0.05, 15000]];
  blobs.forEach(([cx, cy, s, n], b) => { for (let i = 0; i < n; i++) { ux.push(cx + s * g()); uy.push(cy + s * g()); lab.push(b); } });
  // off-scale events piled on the axis must not become a population
  for (let i = 0; i < 5000; i++) { ux.push(0); uy.push(rnd()); lab.push(3); }
  const dens = densityGrid(Float32Array.from(ux), Float32Array.from(uy), Uint32Array.from(ux.keys()));
  blobs.forEach(([cx, cy, , n], b) => {
    const poly = autoGatePolygon(dens, [cx + 0.01, cy + 0.01]);
    assert.ok(poly && poly.length >= 3 && poly.length <= 80, 'polygon');
    const inn = [0, 0, 0, 0]; ux.forEach((x, i) => { if (pointInPolygon(x, uy[i], poly)) inn[lab[i]]++; });
    assert.ok(inn[b] > 0.88 * n, `population ${b}: ${inn}`);
    blobs.forEach(([, , , m], o) => { if (o !== b) assert.ok(inn[o] < 0.05 * m, `population ${b} leaks into ${o}: ${inn}`); });
    assert.equal(inn[3], 0);
  });
  assert.equal(autoGatePolygon(dens, [0.9, 0.1]), null, 'empty space');
  const tight = autoGatePolygon(dens, [0.31, 0.31], { level: 0.25 }), loose = autoGatePolygon(dens, [0.31, 0.31]);
  const count = p => ux.filter((x, i) => pointInPolygon(x, uy[i], p)).length;
  assert.ok(count(tight) < count(loose), 'Shift = tighter');
});
