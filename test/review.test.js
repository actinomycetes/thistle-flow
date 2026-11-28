// Regression tests from the pre-1.0 calculation review: each test pins down a defect found by
// reviewing the code and comparing it with independent implementations (flowio, flowutils, numpy).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFCS, writeFCS, parseText, parseSpillover, exportRanges } from '../js/fcs.js';
import { makeTransform, Logicle, scaleProblem } from '../js/transforms.js';
import { Sample } from '../js/model.js';
import { GateEngine, channelStats, populationStats, formatStat, exportStat, quadArms, quadRegion, pointInPolygon } from '../js/gates.js';
import { Workspace, fileHeader } from '../js/workspace.js';
import { createZip, readZip } from '../js/zip.js';
import { histogramCounts, renderPlot } from '../js/render.js';
import { renderSVG, renderPDF } from '../js/vector.js';
import { densityGrid, autoGatePolygon } from '../js/autogate.js';
import { clampArmAngle, subsampleIdx, zoomUnits } from '../js/plotview.js';

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
  // edges dragged onto the right/top axis carry explicit snap flags (and store 1.3 display units as the plot does)
  eng.add({ id: 'r', name: 'r', parent: null, type: 'rect', x: 'P1', y: 'P2', x0: 40000, x1: t.inv(1.3), y0: 40000, y1: t.inv(1.3), snap: { x1: 1, y1: 1 } });
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

test('channelStats returns NaN for spread statistics (sd, cv, rsd, rcv) when n < 2', () => {
  const st1 = channelStats(new Float32Array([42]), Uint32Array.from([0]));
  assert.equal(st1.n, 1);
  assert.equal(st1.mean, 42);
  assert.equal(st1.median, 42);
  assert.ok(Number.isNaN(st1.sd) && Number.isNaN(st1.cv) && Number.isNaN(st1.rsd) && Number.isNaN(st1.rcv));
  assert.equal(formatStat(st1.sd, 'sd'), '');
  assert.equal(formatStat(st1.cv, 'cv'), '');
  assert.equal(exportStat(st1.sd), '');

  const st2 = channelStats(new Float32Array([10, 20]), Uint32Array.from([0, 1]));
  assert.equal(st2.n, 2);
  assert.ok(Math.abs(st2.sd - Math.sqrt(50)) < 1e-12);
  assert.ok(Number.isFinite(st2.cv) && Number.isFinite(st2.rsd) && Number.isFinite(st2.rcv));
});

test('linearTicks guards non-increasing bounds, log scale supports min < 1e-3, and workspace drops invalid transforms', () => {
  assert.deepEqual(makeTransform({ kind: 'linear', min: 100, max: 100 }).ticks(), []);
  assert.deepEqual(makeTransform({ kind: 'linear', min: 200, max: 100 }).ticks(), []);

  const t = makeTransform({ kind: 'log', min: 1e-6, max: 1e-3 });
  assert.ok(Math.abs(t.fwd(1e-6) - 0) < 1e-12);
  assert.ok(Math.abs(t.fwd(1e-3) - 1) < 1e-12);
  assert.ok(Math.abs(t.inv(t.fwd(1e-4)) - 1e-4) < 1e-12);
  assert.ok(t.ticks().length > 0);
  // Degenerate log max <= min is safely guarded
  const tDeg = makeTransform({ kind: 'log', min: 10, max: 10 });
  assert.ok(Number.isFinite(tDeg.fwd(100)));

  assert.ok(scaleProblem({ kind: 'unknown' }));
  assert.ok(scaleProblem(null));

  const ws = new Workspace('test');
  const s = sampleOf([[100, 200], [300, 400]], ['FSC-A', 'FITC-A']);
  ws.samples.push(s); ws.activeId = s.id;
  ws.deserialize({
    ...fileHeader('workspace'),
    transforms: {
      'FSC-A': { kind: 'linear', min: 100, max: 100 }, // invalid
      'FITC-A': { kind: 'log', min: 1, max: 10000 },   // valid
      'BAD': { kind: 'bogus', min: 0, max: 10 },       // invalid
    },
    samples: [{ key: s.key, compEnabled: false, spill: null, edits: {} }],
  });
  assert.equal(ws.transforms['FSC-A'], undefined);
  assert.equal(ws.transforms['BAD'], undefined);
  assert.deepEqual(ws.transforms['FITC-A'], { kind: 'log', min: 1, max: 10000 });
  assert.equal(ws.getCfg('FSC-A').kind, 'linear');
  assert.ok(ws.getCfg('FSC-A').max > ws.getCfg('FSC-A').min);

  ws.applyTemplate({
    ...fileHeader('template'),
    transforms: {
      'FSC-A': { kind: 'log', min: 0, max: 1000 }, // invalid
      'FITC-A': { kind: 'linear', min: 0, max: 50000 }, // valid
    },
  }, ['#000']);
  assert.notEqual(ws.transforms['FSC-A']?.kind, 'log');
  assert.deepEqual(ws.transforms['FITC-A'], { kind: 'linear', min: 0, max: 50000 });
});

test('subsampleIdx returns immediately for non-positive or NaN max', () => {
  const idx = Uint32Array.from([0, 1, 2, 3, 4]);
  assert.equal(subsampleIdx(idx, -5), idx);
  assert.equal(subsampleIdx(idx, 0), idx);
  assert.equal(subsampleIdx(idx, NaN), idx);
});

test('compensation clears stale compError on setSpill and disables comp with compError when channels are missing', () => {
  const s = sampleOf([[10, 20], [30, 40]], ['A', 'B'], { $SPILLOVER: '2,A,B,1,1,1,1' });
  s.column('A');
  assert.equal(s.compEnabled, false);
  assert.ok(s.compError);
  // Replacing spillover clears stale compError
  s.setSpill({ names: ['A', 'B'], matrix: [[1, 0], [0, 1]] });
  assert.equal(s.compError, null);
  s.setCompEnabled(true);
  s.column('A');
  assert.equal(s.compEnabled, true);
  assert.equal(s.compError, null);

  // Missing spillover channel disables compensation and sets compError
  const sMiss = sampleOf([[10, 20], [30, 40]], ['A', 'B'], { $SPILLOVER: '2,A,MISSING,1,0.1,0,1' });
  assert.equal(sMiss.compEnabled, false);
  sMiss.setCompEnabled(true);
  sMiss.column('A');
  assert.equal(sMiss.compEnabled, false);
  assert.match(sMiss.compError || '', /MISSING/);
});

test('Workspace.channelRange and getCfg handle lowercase $DATATYPE=i, integer gain, $PnE f2, and Time Infinity', () => {
  const text = {
    $BYTEORD: '1,2', $DATATYPE: 'i', $MODE: 'L', $PAR: 2, $TOT: 2,
    $P1N: 'FL1', $P1B: 16, $P1R: 1024, $P1E: '4,0.5',
    $P2N: 'FSC-A', $P2B: 16, $P2R: 65536, $P2E: '0,0', $P2G: '4',
    $BEGINDATA: 0, $ENDDATA: 0,
  };
  const { buf } = buildFCS({ text, data: new Uint8Array([0, 0, 100, 0, 200, 0, 200, 0]) });
  const sInt = new Sample(parseFCS(buf, 'int.fcs')[0]);
  const sTime = sampleOf([[1, 50, Infinity, 100]], ['Time']);
  const ws = new Workspace('ranges');
  ws.samples.push(sInt, sTime);
  const rLog = ws.channelRange('FL1');
  assert.equal(rLog.logAmp, true);
  assert.equal(rLog.logMin, 0.5);
  assert.equal(rLog.range, 5000);
  const cfgLog = ws.getCfg('FL1');
  assert.equal(cfgLog.kind, 'log');
  assert.equal(cfgLog.min, 0.5);
  assert.equal(cfgLog.max, 5000);

  const rGain = ws.channelRange('FSC-A');
  assert.equal(rGain.range, 16384);

  const cfgTime = ws.getCfg('Time');
  assert.equal(cfgTime.kind, 'linear');
  assert.ok(Number.isFinite(cfgTime.max) && cfgTime.max > 100 && cfgTime.max < 110);
});

test('zoomUnits drops collapsed negative zoom ranges when switching to log scale', () => {
  const ws = new Workspace('z');
  ws.transforms['FL1'] = { kind: 'log', min: 10, max: 262144 };
  ws.transforms['FL2'] = { kind: 'linear', min: 0, max: 262144 };
  const def = { x: 'FL1', y: 'FL2', zoom: { x: [-500, -100], y: [1000, 50000] } };
  const zu = zoomUnits(ws, def);
  assert.equal(zu.x, null);
  assert.ok(zu.y && zu.y[1] > zu.y[0]);
  const defBothNeg = { x: 'FL1', y: null, zoom: { x: [-500, -100], y: null } };
  assert.equal(zoomUnits(ws, defBothNeg), null);
});

test('GateEngine guards missing gate IDs and cyclic parents; readZip validates bounds; PDF maps pencil glyph', async () => {
  const s = sampleOf([[100, 200], [300, 400]], ['A', 'B']);
  const eng = new GateEngine(lin(1000));
  assert.equal(eng.population(s, 'nonexistent').count, 0);
  eng.add({ id: 'a', name: 'A', parent: 'b', type: 'interval', x: 'A', x0: 0, x1: 500 });
  eng.add({ id: 'b', name: 'B', parent: 'a', type: 'interval', x: 'A', x0: 0, x1: 500 });
  assert.equal(eng.path('a').length, 2);
  assert.equal(eng.population(s, 'a').count, 0);

  // Truncated ZIP archive throws descriptive error instead of RangeError
  const validZip = await createZip([{ name: 'a.txt', data: 'hello world' }], { compress: false });
  // Corrupt central directory offset in EOCD to point near end of buffer
  const badCd = validZip.slice();
  const dvCd = new DataView(badCd.buffer);
  dvCd.setUint32(badCd.length - 6, badCd.length - 10, true);
  await assert.rejects(() => readZip(badCd), /Damaged zip/i);
  // Corrupt compressed size to extend past buffer
  const badPayload = validZip.slice();
  const dvPay = new DataView(badPayload.buffer);
  const cdOff = dvPay.getUint32(badPayload.length - 6, true);
  dvPay.setUint32(cdOff + 20, 999999, true);
  await assert.rejects(() => readZip(badPayload), /Damaged zip/i);

  // PDF WinAnsi maps custom-gate pencil mark (✎) to '*' rather than '?'
  const pdfBytes = renderPDF(200, 100, ctx => { ctx.font = '12px Helvetica'; ctx.fillText('Gate ✎ 12%', 10, 20); });
  const pdfStr = new TextDecoder('latin1').decode(pdfBytes);
  assert.ok(pdfStr.includes('(Gate * 12%)'), 'PDF should encode ✎ as *');
  assert.ok(!pdfStr.includes('(Gate ? 12%)'), 'PDF must not encode ✎ as ?');
});

test('log scale returns NaN for NaN inputs so NaN events enter no gate', () => {
  const cfg = { kind: 'log', min: 10, max: 262144 };
  const t = makeTransform(cfg);
  assert.ok(Number.isNaN(t.fwd(NaN)));
  const s = sampleOf([[NaN, 100, 0, -50], [100, NaN, 100, 100]]);
  const eng = new GateEngine(() => cfg);
  for (const q of ['UL', 'UR', 'LR', 'LL']) eng.add({ id: q, name: q, parent: null, type: 'quad', q, group: 'Q', x: 'P1', y: 'P2', cx: 100, cy: 100 });
  for (const side of ['L', 'R']) eng.add({ id: side, name: side, parent: null, type: 'split', side, group: 'S', x: 'P1', cx: 100 });
  eng.add({ id: 'r', name: 'r', parent: null, type: 'rect', x: 'P1', y: 'P2', x0: t.inv(-0.3), x1: t.inv(1.3), y0: t.inv(-0.3), y1: t.inv(1.3) });
  assert.deepEqual(['UL', 'UR', 'LR', 'LL'].flatMap(q => ids(eng, s, q)).sort(), [2, 3]);
  assert.deepEqual([...ids(eng, s, 'L'), ...ids(eng, s, 'R')].sort(), [1, 2, 3]);
  assert.deepEqual(ids(eng, s, 'r'), [2, 3]);
});

test('parseText distinguishes doubled-delimiter escapes in values from empty values and key boundaries', () => {
  const raw = new TextEncoder().encode('/$P1S//$P2N/SSC/$P2S//$P3N/FL1/');
  const parsed = parseText(raw, 0, raw.length - 1);
  assert.equal(parsed['$P1S'], '');
  assert.equal(parsed['$P2N'], 'SSC');
  assert.equal(parsed['$P2S'], '');
  assert.equal(parsed['$P3N'], 'FL1');

  const buf = writeFCS({
    names: ['A', 'B', 'C'],
    labels: ['a|b', '|lead', 'trail|'],
    columns: [Float32Array.from([1]), Float32Array.from([2]), Float32Array.from([3])],
    extraText: { '$COM': '|', '$SRC': 'Mouse1', '$EXP': '||' },
  });
  const [ds] = parseFCS(buf, 'delim.fcs');
  assert.equal(ds.text['$COM'], '|');
  assert.equal(ds.text['$SRC'], 'Mouse1');
  assert.equal(ds.text['$EXP'], '||');
  assert.deepEqual(ds.params.map(p => p.label), ['a|b', '|lead', 'trail|']);
});

test('FCS 3.x STEXT ($BEGINSTEXT/$ENDSTEXT) is parsed and merged, and malformed headers/bounds are guarded', () => {
  const enc = s => new TextEncoder().encode(s);
  const data = floatData([[100, 200], [300, 400]]);
  const stextStr = '/$P1S/CD3/$P2S/CD4/$SPILLOVER/2,A,B,1,0.1,0.05,1/$P1N/IGNORED/';
  const stextBytes = enc(stextStr);
  const primary = (sb, se, bd, ed) => enc(
    `/$BYTEORD/1,2,3,4/$DATATYPE/F/$MODE/L/$PAR/2/$TOT/2/$P1N/A/$P1B/32/$P1R/262144/$P1E/0,0/$P2N/B/$P2B/32/$P2R/262144/$P2E/0,0`
    + `/$BEGINDATA/${String(bd).padStart(8, '0')}/$ENDDATA/${String(ed).padStart(8, '0')}`
    + `/$BEGINSTEXT/${String(sb).padStart(8, '0')}/$ENDSTEXT/${String(se).padStart(8, '0')}/`
  );
  const textStart = 58;
  const textLen = primary(0, 0, 0, 0).length;
  const textEnd = textStart + textLen - 1;
  const dataStart = textEnd + 1, dataEnd = dataStart + data.length - 1;
  const stextStart = dataEnd + 1, stextEnd = stextStart + stextBytes.length - 1;
  const pad = n => String(n).padStart(8, ' ');
  const header = enc('FCS3.1    ' + pad(textStart) + pad(textEnd) + pad(dataStart) + pad(dataEnd) + pad(0) + pad(0));
  const out = new Uint8Array(stextEnd + 1);
  out.set(header, 0);
  out.set(primary(stextStart, stextEnd, dataStart, dataEnd), textStart);
  out.set(data, dataStart);
  out.set(stextBytes, stextStart);
  const [ds] = parseFCS(out.buffer, 'stext.fcs');
  assert.equal(ds.params[0].name, 'A'); // primary TEXT wins over STEXT duplicate
  assert.equal(ds.params[0].label, 'CD3');
  assert.equal(ds.params[1].label, 'CD4');
  assert.ok(ds.spill && ds.spill.matrix[0][1] === 0.1);

  // Malformed headers / bounds
  assert.throws(() => parseFCS(new ArrayBuffer(20)), /truncated/i);
  const badOffsets = enc('FCS3.1    ' + pad(10) + pad(50) + pad(0) + pad(0) + pad(0) + pad(0) + ' '.repeat(20));
  assert.throws(() => parseFCS(badOffsets.buffer), /TEXT segment offsets/i);
  const zeroPar = buildFCS({ text: { $BYTEORD: '1,2,3,4', $DATATYPE: 'F', $MODE: 'L', $PAR: 0, $TOT: 0 }, data: new Uint8Array(0) });
  assert.throws(() => parseFCS(zeroPar.buf), /\$PAR/);
  const negTot = buildFCS({ text: { $BYTEORD: '1,2,3,4', $DATATYPE: 'F', $MODE: 'L', $PAR: 1, $TOT: -5, $P1N: 'A' }, data: new Uint8Array(0) });
  assert.throws(() => parseFCS(negTot.buf), /\$TOT/);

  // Integer $PnR = 0 with log amplification skips division by zero
  const zeroR = buildFCS({
    text: { $BYTEORD: '1,2', $DATATYPE: 'I', $MODE: 'L', $PAR: 1, $TOT: 1, $P1N: 'FL1', $P1B: 16, $P1R: 0, $P1E: '4,1', $BEGINDATA: 0, $ENDDATA: 0 },
    data: new Uint8Array([10, 0]),
  });
  const [dsZeroR] = parseFCS(zeroR.buf, 'zr.fcs');
  assert.ok(Number.isFinite(dsZeroR.columns[0][0]));
  assert.match(dsZeroR.warnings.join(' '), /\$P1R/);
});

test('2D plots skip NaN coordinates instead of plotting phantom events at (0, 0)', () => {
  const validUx = Float32Array.from({ length: 40 }, (_, i) => 0.55 + (i % 5) * 0.02);
  const validUy = Float32Array.from({ length: 40 }, (_, i) => 0.55 + Math.floor(i / 5) * 0.02);
  const withNaN_ux = new Float32Array(validUx.length + 20);
  const withNaN_uy = new Float32Array(validUy.length + 20);
  withNaN_ux.set(validUx); withNaN_uy.set(validUy);
  withNaN_ux.fill(NaN, validUx.length); withNaN_uy.fill(NaN, validUy.length);
  const cfg = { kind: 'linear', min: 0, max: 100 };
  const makeSpec = (ux, uy, kind) => ({
    w: 220, h: 200, kind, x: { name: 'X', label: 'X', cfg }, y: { name: 'Y', label: 'Y', cfg },
    series: [{ ux, uy, idx: Uint32Array.from(ux.keys()), fullIdx: Uint32Array.from(ux.keys()) }], gates: [],
  });
  for (const kind of ['dot', 'pseudo', 'contour']) {
    const cleanSvg = renderSVG(220, 200, ctx => renderPlot(ctx, makeSpec(validUx, validUy, kind)));
    const nanSvg = renderSVG(220, 200, ctx => renderPlot(ctx, makeSpec(withNaN_ux, withNaN_uy, kind)));
    assert.equal(nanSvg, cleanSvg, `${kind}: NaN events must not change the rendered plot`);
  }
});

test('tightening an axis scale preserves rect, interval, split, and polygon gates beyond display unit 1.25', () => {
  const s = sampleOf([[50000, 150000, 200000, 300000], [50000, 50000, 50000, 50000]]);
  const eng = new GateEngine(lin(100000)); // events at u = 0.5, 1.5, 2.0, 3.0
  eng.add({ id: 'rect', name: 'r', parent: null, type: 'rect', x: 'P1', y: 'P2', x0: 140000, x1: 250000, y0: 0, y1: 100000 });
  eng.add({ id: 'iv', name: 'iv', parent: null, type: 'interval', x: 'P1', x0: 140000, x1: 250000 });
  eng.add({ id: 'poly', name: 'p', parent: null, type: 'polygon', x: 'P1', y: 'P2', pts: [[140000, 0], [250000, 0], [250000, 100000], [140000, 100000]] });
  for (const side of ['L', 'R']) eng.add({ id: 's' + side, name: side, parent: null, type: 'split', side, group: 'S', x: 'P1', cx: 140000 });
  for (const side of ['L', 'R']) eng.add({ id: 's13' + side, name: side, parent: null, type: 'split', side, group: 'S13', x: 'P1', cx: 130000 });
  assert.deepEqual(ids(eng, s, 'rect'), [1, 2]);
  assert.deepEqual(ids(eng, s, 'iv'), [1, 2]);
  assert.deepEqual(ids(eng, s, 'poly'), [1, 2]);
  assert.deepEqual(ids(eng, s, 'sL'), [0]);
  assert.deepEqual(ids(eng, s, 'sR'), [1, 2, 3]);
  assert.deepEqual(ids(eng, s, 's13L'), [0]);
  assert.deepEqual(ids(eng, s, 's13R'), [1, 2, 3]);

  // Explicitly axis-snapped polygon right edge includes piled events across scale changes
  const t = makeTransform(lin(100000)());
  eng.add({
    id: 'snapPoly', name: 'sp', parent: null, type: 'polygon', x: 'P1', y: 'P2',
    pts: [[40000, 10000], [t.inv(1.3), 10000], [t.inv(1.3), 90000], [40000, 90000]],
    snap: [[0, 0], [1, 0], [1, 0], [0, 0]],
  });
  assert.deepEqual(ids(eng, s, 'snapPoly'), [0, 1, 2, 3]);
});

test('finite gate endpoints stay finite across scale changes while explicitly snapped edges include piled events and survive workspace round-trip', () => {
  const s1 = sampleOf([[50000, 125000, 150000, 200000], [50000, 50000, 50000, 50000]], ['P1', 'P2']);
  const s2 = sampleOf([[50000, 125000, 150000, 200000], [50000, 50000, 50000, 50000]], ['P1', 'P2']);
  s2.key = 'sample2.fcs';
  const maxima = [200000, 100000, 100100];

  const checkBoth = (ws) => {
    for (const max of maxima) {
      ws.transforms.P1 = { kind: 'linear', min: 0, max };
      ws.engine.invalidate();
      assert.deepEqual(ids(ws.engine, s1, 'ivFin'), [0, 1], `finite interval at max=${max}`);
      assert.deepEqual(ids(ws.engine, s1, 'ivSnap'), [0, 1, 2, 3], `snapped interval at max=${max}`);
      // per-sample override clears snap on s2 (back to finite [0, 130000))
      assert.deepEqual(ids(ws.engine, s2, 'ivSnap'), [0, 1], `per-sample unsnapped override at max=${max}`);
      // per-sample override enables snap on s2 for ivFin
      assert.deepEqual(ids(ws.engine, s2, 'ivFin'), [0, 1, 2, 3], `per-sample snapped override at max=${max}`);
    }
  };

  const ws = new Workspace('snap-test');
  ws.samples.push(s1, s2);
  ws.activeId = s1.id;
  ws.engine.add({
    id: 'ivFin', name: 'Finite', parent: null, type: 'interval', x: 'P1', x0: 0, x1: 130000,
    overrides: { [s2.key]: { x0: 0, x1: 130000, snap: { x1: 1 } } },
  });
  ws.engine.add({
    id: 'ivSnap', name: 'Snapped', parent: null, type: 'interval', x: 'P1', x0: 0, x1: 130000, snap: { x1: 1 },
    overrides: { [s2.key]: { x0: 0, x1: 130000, snap: null } },
  });
  checkBoth(ws);

  // Repeat both checks after JSON workspace serialize + deserialize round-trip
  const saved = JSON.parse(JSON.stringify(ws.serialize()));
  const ws2 = new Workspace('reopened');
  ws2.samples.push(s1, s2);
  ws2.activeId = s1.id;
  ws2.deserialize(saved);
  checkBoth(ws2);
});

test('angled and staggered quadrants tile exactly on diagonal arms and out-of-frame centres/offsets', () => {
  // 162 points lying exactly on 45° diagonal arms + centre + ±Infinity
  const xs = [5000], ys = [5000];
  for (const [dx, dy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    for (let k = 1; k <= 40; k++) { xs.push(5000 + dx * k * 100); ys.push(5000 + dy * k * 100); }
  }
  xs.push(Infinity, -Infinity, Infinity, -Infinity); ys.push(Infinity, -Infinity, -Infinity, Infinity);
  const sDiag = sampleOf([xs, ys]);
  const engDiag = new GateEngine(lin(10000));
  const angles45 = { up: 45, right: 315, down: 225, left: 135 };
  for (const q of ['UL', 'UR', 'LR', 'LL']) engDiag.add({ id: q, name: q, parent: null, type: 'quad', q, group: 'A', x: 'P1', y: 'P2', cx: 5000, cy: 5000, quadMode: 'angled', angles: angles45 });
  const diagCounts = new Uint8Array(xs.length);
  for (const q of ['UL', 'UR', 'LR', 'LL']) for (const idx of ids(engDiag, sDiag, q)) diagCounts[idx]++;
  assert.ok(diagCounts.every(c => c === 1), 'every diagonal-arm, centre, and ±Infinity point must fall in exactly 1 angled quadrant');
  assert.ok(ids(engDiag, sDiag, 'UR').includes(0), 'exact centre is deterministically assigned to UR');

  // Out-of-frame centre (angled) and out-of-frame offsets (staggered) on 10x10 in-plot grid + stepped edges
  const gx = [], gy = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) { gx.push(500 + i * 1000); gy.push(500 + j * 1000); }
  // include points on staggered centre/offset lines too
  gx.push(5000, 20000, -15000, 5000, Infinity, -Infinity); gy.push(5000, 5000, 5000, 20000, -Infinity, Infinity);
  const sGrid = sampleOf([gx, gy]);
  const engOut = new GateEngine(lin(10000));
  for (const q of ['UL', 'UR', 'LR', 'LL']) {
    engOut.add({ id: 'a' + q, name: q, parent: null, type: 'quad', q, group: 'AO', x: 'P1', y: 'P2', cx: 20000, cy: 20000, quadMode: 'angled', angles: angles45 });
    engOut.add({ id: 's' + q, name: q, parent: null, type: 'quad', q, group: 'SO', x: 'P1', y: 'P2', cx: 5000, cy: 5000, quadMode: 'staggered', offsets: { up: 20000, down: -15000, right: 20000, left: -15000 } });
  }
  for (const pre of ['a', 's']) {
    const seen = new Uint8Array(gx.length);
    for (const q of ['UL', 'UR', 'LR', 'LL']) for (const idx of ids(engOut, sGrid, pre + q)) seen[idx]++;
    assert.ok(seen.every(c => c === 1), `${pre}: every grid/edge/±Infinity point must fall in exactly 1 quadrant`);
  }
  // Dynamic frame in quadArms/quadRegion also tiles out-of-frame staggered geometry cleanly
  const t = makeTransform(lin(10000)());
  const arms = quadArms({ cx: 5000, cy: 5000, quadMode: 'staggered', offsets: { up: 20000, down: -15000, right: 20000, left: -15000 } }, t, t);
  for (let x = 0.05; x < 1; x += 0.13) for (let y = 0.05; y < 1; y += 0.13) {
    const hits = ['UR', 'LR', 'LL', 'UL'].filter(q => pointInPolygon(x, y, quadRegion(arms, q)));
    assert.equal(hits.length, 1, `quadRegion out-of-frame tiling at (${x},${y})`);
  }
});

test('duplicate resolved channel names in $SPILLOVER disable compensation with a clear error', () => {
  const s1 = sampleOf([[1000, 2000], [500, 600]], ['FITC-A', 'PE-A'], { $P1S: 'CD3', $SPILLOVER: '2,FITC-A,CD3,1,0.2,0.1,1' });
  assert.equal(s1.compEnabled, false);
  assert.match(s1.compError || '', /FITC-A/);
  assert.deepEqual([...s1.column('FITC-A')], [1000, 2000]);
  s1.setCompEnabled(true);
  assert.deepEqual([...s1.column('FITC-A')], [1000, 2000]);
  assert.equal(s1.compEnabled, false);
  assert.match(s1.compError || '', /FITC-A/);

  const s2 = sampleOf([[1000, 2000], [500, 600]], ['FITC-A', 'PE-A'], { $SPILLOVER: '2,FITC-A,fitc-a,1,0.2,0.1,1' });
  assert.equal(s2.compEnabled, false);
  assert.match(s2.compError || '', /FITC-A/);
  assert.deepEqual([...s2.column('FITC-A')], [1000, 2000]);
});

test('SVG and PDF vector contexts implement arc() and render selected angled/staggered quadrants without crashing', () => {
  const cfg = { kind: 'linear', min: 0, max: 100 };
  const ux = Float32Array.from([0.2, 0.8]), uy = Float32Array.from([0.2, 0.8]);
  const idx = Uint32Array.from([0, 1]);
  const gates = [
    { gate: { id: 'q1', name: 'UR', type: 'quad', q: 'UR', x: 'X', y: 'Y', cx: 50, cy: 50, quadMode: 'angled', angles: { up: 80, right: 10, down: 260, left: 190 } }, text: 'UR 50%', selected: true, color: '#d55e00' },
    { gate: { id: 'q2', name: 'LL', type: 'quad', q: 'LL', x: 'X', y: 'Y', cx: 50, cy: 50, quadMode: 'staggered', offsets: { up: 60, down: 40, right: 60, left: 40 } }, text: 'LL 50%', selected: true, color: '#3a8fc4' },
  ];
  const spec = { w: 240, h: 200, kind: 'dot', x: { name: 'X', label: 'X', cfg }, y: { name: 'Y', label: 'Y', cfg }, series: [{ ux, uy, idx }], gates };
  const svg = renderSVG(240, 200, ctx => renderPlot(ctx, spec));
  assert.ok(svg.startsWith('<?xml') && svg.includes('<svg') && svg.includes('<path'));
  const pdf = renderPDF(240, 200, ctx => renderPlot(ctx, spec));
  assert.equal(new TextDecoder('latin1').decode(pdf.slice(0, 8)), '%PDF-1.4');
});

test('autoGatePolygon closes cleanly for populations touching plot borders', () => {
  let seed = 19; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  for (const cx of [0.025, 0.975]) {
    const ux = [], uy = [];
    for (let i = 0; i < 8000; i++) {
      const x = cx + 0.03 * g(), y = 0.5 + 0.04 * g();
      if (x > 0.001 && x < 0.999 && y > 0.001 && y < 0.999) { ux.push(x); uy.push(y); }
    }
    const dens = densityGrid(Float32Array.from(ux), Float32Array.from(uy), Uint32Array.from(ux.keys()));
    const poly = autoGatePolygon(dens, [cx, 0.5]);
    assert.ok(poly && poly.length >= 3, `edge population at x=${cx} must return a closed polygon`);
    assert.ok(pointInPolygon(cx, 0.5, poly), `polygon at x=${cx} must contain the clicked peak`);
    const inside = ux.filter((x, i) => pointInPolygon(x, uy[i], poly)).length;
    assert.ok(inside > 0.85 * ux.length, `polygon at x=${cx} captured ${inside}/${ux.length}`);
  }
});
