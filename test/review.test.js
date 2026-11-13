// Regression tests from the pre-1.0 calculation review: each test pins down a defect found by
// reviewing the code and comparing it with independent implementations (flowio, flowutils, numpy).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFCS, writeFCS, parseSpillover, exportRanges } from '../js/fcs.js';
import { makeTransform, Logicle } from '../js/transforms.js';
import { Sample } from '../js/model.js';
import { GateEngine, channelStats, populationStats } from '../js/gates.js';
import { histogramCounts } from '../js/render.js';
import { clampArmAngle } from '../js/plotview.js';

// ---- a minimal FCS builder for hand-made test files ----
function buildFCS({ version = 'FCS3.1', text, data, headerData = null }) {
  const enc = s => new TextEncoder().encode(s);
  const kv = Object.entries(text).map(([k, v]) => `/${k}/${v}`).join('') + '/';
  const textStart = 58, textBytes = enc(kv), textEnd = textStart + textBytes.length - 1;
  const dataStart = textEnd + 1, dataEnd = dataStart + data.length - 1;
  const [hs, he] = headerData || [dataStart, dataEnd];
  const pad = n => String(n).padStart(8, ' ');
  const header = enc(version + '    ' + pad(textStart) + pad(textEnd) + pad(hs) + pad(he) + pad(0) + pad(0));
  const out = new Uint8Array(dataEnd + 1);
  out.set(header, 0); out.set(textBytes, textStart); out.set(data, dataStart);
  return { buf: out.buffer, dataStart, dataEnd };
}
const floatData = rows => { const a = new Float32Array(rows.flat()); return new Uint8Array(a.buffer); };
function sampleOf(cols, names = cols.map((_, i) => `P${i + 1}`), extra = {}) {
  const n = cols[0].length;
  const text = { $BYTEORD: '1,2,3,4', $DATATYPE: 'F', $MODE: 'L', $PAR: cols.length, $TOT: n, ...extra };
  names.forEach((nm, i) => { text[`$P${i + 1}N`] = nm; text[`$P${i + 1}B`] = 32; text[`$P${i + 1}R`] = 262144; text[`$P${i + 1}E`] = '0,0'; });
  const rows = Array.from({ length: n }, (_, e) => cols.map(c => c[e]));
  const { buf } = buildFCS({ text: { ...text, $BEGINDATA: 0, $ENDDATA: 0 }, data: floatData(rows) });
  return new Sample(parseFCS(buf, 't.fcs')[0]);
}
const lin = max => () => ({ kind: 'linear', min: 0, max });
const ids = (eng, s, id) => [...eng.population(s, id).idx];

// ---------- gates: off-scale, NaN, ±Infinity, exact boundaries ----------
test('a gate edge snapped to an axis includes every event piled up on that axis', () => {
  const s = sampleOf([[50000, 250000, 30000, 500000], [80000, 80000, 80000, 90000]]);
  const t = makeTransform(lin(100000)());
  const eng = new GateEngine(lin(100000));
  // edges dragged onto the right/top axis are stored at 1.3 display units (as the plot does)
  eng.add({ id: 'r', name: 'r', parent: null, type: 'rect', x: 'P1', y: 'P2', x0: 40000, x1: t.inv(1.3), y0: 40000, y1: t.inv(1.3) });
  assert.deepEqual(ids(eng, s, 'r'), [0, 1, 3], 'events beyond the right axis are drawn on it, inside the gate');
});

test('angled and staggered quadrants cover events far off scale, like the standard cross', () => {
  const X = [50000, 250000, -60000, 20000, 1e7, -1e7], Y = [80000, 80000, 20000, 250000, -1e7, 1e7];
  const s = sampleOf([X, Y]);
  const run = geom => {
    const eng = new GateEngine(lin(100000));
    for (const q of ['UL', 'UR', 'LR', 'LL']) eng.add({ id: q, name: q, parent: null, type: 'quad', q, group: 'G', x: 'P1', y: 'P2', cx: 30000, cy: 50000, ...geom });
    return Object.fromEntries(['UL', 'UR', 'LR', 'LL'].map(q => [q, ids(eng, s, q)]));
  };
  const std = run({});
  assert.equal(Object.values(std).flat().length, X.length);
  assert.deepEqual(run({ quadMode: 'angled', angles: { up: 90, right: 0, down: 270, left: 180 } }), std);
  assert.deepEqual(run({ quadMode: 'staggered', offsets: { up: 30000, down: 30000, right: 50000, left: 50000 } }), std);
});

test('NaN events are in no gate; ±Infinity events are in exactly one quadrant and one split side', () => {
  for (const cfg of [lin(262144)(), { kind: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 }]) {
    const s = sampleOf([[NaN, Infinity, -Infinity, 1000], [1000, Infinity, -Infinity, NaN]]);
    const eng = new GateEngine(() => cfg);
    for (const q of ['UL', 'UR', 'LR', 'LL']) eng.add({ id: q, name: q, parent: null, type: 'quad', q, group: 'G', x: 'P1', y: 'P2', cx: 500, cy: 500 });
    for (const q of ['UL', 'UR', 'LR', 'LL']) eng.add({ id: 's' + q, name: q, parent: null, type: 'quad', q, group: 'S', x: 'P1', y: 'P2', cx: 500, cy: 500, quadMode: 'angled', angles: { up: 80, right: 10, down: 260, left: 190 } });
    for (const side of ['L', 'R']) eng.add({ id: side, name: side, parent: null, type: 'split', side, group: 'X', x: 'P1', cx: 500 });
    const inQ = pre => ['UL', 'UR', 'LR', 'LL'].map(q => ids(eng, s, pre + q)).flat().sort();
    assert.deepEqual(inQ(''), [1, 2], `${cfg.kind}: standard quadrants`);
    assert.deepEqual(inQ('s'), [1, 2], `${cfg.kind}: angled quadrants`);
    assert.deepEqual([...ids(eng, s, 'L'), ...ids(eng, s, 'R')].sort(), [1, 2, 3], `${cfg.kind}: split`);
  }
});

test('an event exactly on a gate edge is counted the same way on every scale (lower edge included)', () => {
  const vals = Array.from({ length: 2000 }, (_, i) => 3 + i * 7);
  for (const cfg of [{ kind: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 }, { kind: 'arcsinh', cofactor: 150, min: -1000, max: 262144 }, { kind: 'log', min: 1, max: 262144 }]) {
    let missed = 0;
    for (const v of vals.filter((_, i) => i % 97 === 0)) {
      const s = sampleOf([[v]]);
      const eng = new GateEngine(() => cfg);
      eng.add({ id: 'i', name: 'i', parent: null, type: 'interval', x: 'P1', x0: v, x1: 300000 });
      if (eng.population(s, 'i').count !== 1) missed++;
    }
    assert.equal(missed, 0, `${cfg.kind}: events on the lower edge excluded`);
  }
});

test('log scale keeps the order of values below its minimum (no gate can skip 1-4 but keep 0)', () => {
  const t = makeTransform({ kind: 'log', min: 10, max: 262144 });
  const xs = [-100, 0, 0.5, 1, 5, 9.9, 10, 11];
  for (let i = 1; i < xs.length; i++) assert.ok(t.fwd(xs[i]) >= t.fwd(xs[i - 1]), `${xs[i - 1]} -> ${xs[i]}`);
});

// ---------- statistics ----------
test('statistics ignore NaN values instead of returning NaN or shifting the median', () => {
  const col = new Float32Array([1, 2, 3, 4, NaN]);
  const st = channelStats(col, Uint32Array.from([0, 1, 2, 3, 4]));
  assert.equal(st.median, 2.5); assert.equal(st.mean, 2.5); assert.equal(st.max, 4); assert.equal(st.n, 4);
});

// ---------- compensation input ----------
test('a singular spillover matrix turns compensation off visibly instead of silently', () => {
  const s = sampleOf([[10, 20], [30, 40]], ['A', 'B'], { $SPILLOVER: '2,A,B,1,1,1,1' });
  assert.doesNotThrow(() => s.column('A'));
  assert.equal(s.compEnabled, false);
  assert.match(s.compError || '', /singular|cannot be inverted/i);
  assert.equal(s.column('A')[0], 10);
});

test('a spillover matrix given in percent (diagonal 100) is read as fractions', () => {
  const sp = parseSpillover('2,A,B,100,15,2,100');
  assert.deepEqual(sp.matrix, [[1, 0.15], [0.02, 1]]);
});

test('an unreadable $SPILLOVER falls back to SPILL; a name-less FCS 3.0 $COMP is reported', () => {
  const a = sampleOf([[1], [2]], ['A', 'B'], { $SPILLOVER: '2,A,B,1,x', SPILL: '2,A,B,1,0.1,0,1' });
  assert.deepEqual(a.spill.matrix, [[1, 0.1], [0, 1]]);
  const b = sampleOf([[1], [2]], ['A', 'B'], { $COMP: '2,1,0.1,0.2,1' });
  assert.equal(b.spill, null);
  assert.match(b.spillNote || '', /\$COMP/);
});

// ---------- FCS reading / writing ----------
test('header and TEXT data offsets that disagree: FCS 3 files use the TEXT ($BEGINDATA)', () => {
  const rows = [[1, 2], [3, 4]];
  const text = { $BYTEORD: '1,2,3,4', $DATATYPE: 'F', $MODE: 'L', $PAR: 2, $TOT: 2, $P1N: 'A', $P1B: 32, $P1R: 1024, $P1E: '0,0', $P2N: 'B', $P2B: 32, $P2R: 1024, $P2E: '0,0' };
  // first build to learn where the data go, then write those offsets in TEXT but wrong ones in HEADER
  const probe = buildFCS({ text: { ...text, $BEGINDATA: '00000000', $ENDDATA: '00000000' }, data: floatData(rows) });
  const { buf } = buildFCS({ text: { ...text, $BEGINDATA: String(probe.dataStart).padStart(8, '0'), $ENDDATA: String(probe.dataEnd).padStart(8, '0') }, data: floatData(rows), headerData: [probe.dataStart - 4, probe.dataEnd] });
  const ds = parseFCS(buf, 'x.fcs')[0];
  assert.deepEqual([...ds.columns[0]], [1, 3]);
  assert.match(ds.warnings.join(' '), /offset/i);
});

test('$TOT larger than the data segment: events are capped and a warning is given', () => {
  const text = { $BYTEORD: '1,2,3,4', $DATATYPE: 'F', $MODE: 'L', $PAR: 1, $TOT: 5, $P1N: 'A', $P1B: 32, $P1R: 1024, $P1E: '0,0', $BEGINDATA: 0, $ENDDATA: 0 };
  const { buf } = buildFCS({ text, data: floatData([[1], [2], [3]]) });
  const ds = parseFCS(buf, 'x.fcs')[0];
  assert.equal(ds.events, 3);
  assert.match(ds.warnings.join(' '), /\$TOT/);
});

test('integer channels with $PnR = 1 are not masked to zero', () => {
  const text = { $BYTEORD: '1,2', $DATATYPE: 'I', $MODE: 'L', $PAR: 1, $TOT: 2, $P1N: 'A', $P1B: 16, $P1R: 1, $P1E: '0,0', $BEGINDATA: 0, $ENDDATA: 0 };
  const { buf } = buildFCS({ text, data: new Uint8Array([1, 0, 0, 0]) });
  assert.deepEqual([...parseFCS(buf, 'x.fcs')[0].columns[0]], [1, 0]);
});

test('writer: an empty population is a valid file with zero data offsets', () => {
  const buf = writeFCS({ names: ['A'], columns: [new Float32Array(0)] });
  const ds = parseFCS(buf, 'e.fcs')[0];
  assert.equal(ds.events, 0);
  assert.equal(ds.text['$BEGINDATA'].trim().replace(/^0+/, '') || '0', '0');
});

test('exported files give each channel the range of its decoded values ($PnR)', () => {
  const params = [{ range: 1024, ampE: [4, 1], gain: 1 }, { range: 1024, ampE: [4, 0], gain: 1 }, { range: 65536, ampE: [0, 0], gain: 2, int: true }, { range: 262144, ampE: [0, 0], gain: 1 }];
  assert.deepEqual(exportRanges(params), [10000, 10000, 32768, 262144]);
});

// ---------- display ----------
test('histograms pile off-scale events into the end bins (like 2-D plots) unless zoomed', () => {
  const ux = new Float32Array([0, 0.5, 1, 1, 1.2, -0.01]);
  const h = histogramCounts(ux, Uint32Array.from([0, 1, 2, 3, 4, 5]), 4);
  assert.deepEqual([...h], [2, 0, 1, 3]);
});

test('angled-quadrant arm dragged a little past its clockwise neighbour stops next to it (not on the far side)', () => {
  // up arm between right (0°) and left (180°): cursor at -10° -> 5°, not 175°
  assert.equal(clampArmAngle(-10, 0, 180), 5);
  // right arm between down (270°) and up (90°): cursor at 260° -> 275°
  assert.equal(clampArmAngle(260, 270, 90), 275);
  assert.equal(clampArmAngle(45, 0, 180), 45);
});

// ---------- Logicle, against an independent implementation ----------
test('Logicle agrees with flowutils (FlowKit) to 1e-9 display units, and round-trips', () => {
  const ref = JSON.parse(fs.readFileSync(new URL('./fixtures/logicle_flowutils.json', import.meta.url)));
  for (const c of ref.cases) {
    const L = new Logicle(c.T, c.W, c.M, c.A);
    ref.xs.forEach((x, i) => {
      assert.ok(Math.abs(L.scale(x) - c.fwd[i]) < 1e-9, `T=${c.T} W=${c.W} M=${c.M} A=${c.A} x=${x}: ${L.scale(x)} vs ${c.fwd[i]}`);
      const back = L.inverse(L.scale(x));
      assert.ok(Math.abs(back - x) <= 1e-9 * Math.max(1, Math.abs(x)), `round trip ${x} -> ${back}`);
    });
    const t = makeTransform({ kind: 'logicle', T: c.T, W: c.W, M: c.M, A: c.A });
    ref.xs.forEach((x, i) => assert.ok(Math.abs(t.fwd(x) - c.fwd[i]) < 1e-6, 'fast (table) version'));
  }
  assert.equal(new Logicle().scale(Infinity), Infinity);
  assert.equal(new Logicle().scale(-Infinity), -Infinity);
});

test('shipped files do not name other analysis software (trademarks)', () => {
  const files = ['index.html', 'help.html', 'README.md', 'CLAUDE.md', ...fs.readdirSync(new URL('../js/', import.meta.url)).map(f => 'js/' + f)];
  for (const f of files) {
    const text = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.ok(!/flow\s*jo|tree\s*star/i.test(text), `${f} names another analysis program`);
  }
});

test('quadrant styles saved under their old names (spider, offset) still work', () => {
  const s = sampleOf([[50000, 250000, -60000, 20000], [80000, 80000, 20000, 250000]]);
  const run = geom => {
    const eng = new GateEngine(lin(100000));
    for (const q of ['UL', 'UR', 'LR', 'LL']) eng.add({ id: q, name: q, parent: null, type: 'quad', q, group: 'G', x: 'P1', y: 'P2', cx: 30000, cy: 50000, ...geom });
    return ['UL', 'UR', 'LR', 'LL'].map(q => ids(eng, s, q));
  };
  const angles = { up: 80, right: 20, down: 250, left: 170 }, offsets = { up: 60000, down: 10000, right: 30000, left: 70000 };
  assert.deepEqual(run({ quadMode: 'spider', angles }), run({ quadMode: 'angled', angles }));
  assert.deepEqual(run({ quadMode: 'offset', offsets }), run({ quadMode: 'staggered', offsets }));
  assert.notDeepEqual(run({ quadMode: 'angled', angles }), run({}));
});
