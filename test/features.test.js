import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFCS } from '../js/fcs.js';
import { Sample } from '../js/model.js';
import { makeDemoFile } from '../js/demo.js';
import { Workspace } from '../js/workspace.js';
import { buildSpec, subsampleIdx } from '../js/plotview.js';
import { renderPlot, contourLevels, marchingSquares, gaussianBlur, SERIES_COLORS } from '../js/render.js';
import { renderSVG, renderPDF, parseColor } from '../js/vector.js';

function demoWorkspace(n = 2) {
  const ws = new Workspace('Test');
  for (let i = 0; i < n; i++) {
    const [ds] = parseFCS(makeDemoFile(`s${i}.fcs`, 0.3 * i, 5 + i, 8000), `s${i}.fcs`);
    ws.samples.push(new Sample(ds));
  }
  ws.activeId = ws.samples[0].id;
  ws.rebase();
  return ws;
}
const lymph = { id: 'g1', name: 'Lymph', parent: null, type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 40000, x1: 80000, y0: 8000, y1: 38000, color: '#e6194b' };

test('deterministic subsample: size, stability and nesting', () => {
  const all = Uint32Array.from({ length: 50000 }, (_, i) => i);
  const a = subsampleIdx(all, 5000), b = subsampleIdx(all, 5000);
  assert.equal(a, b); // cached
  assert.ok(a.length > 4500 && a.length < 5500, `got ${a.length}`);
  const child = all.filter(i => i % 3 === 0); // a "child population" of the same events
  const sub = new Set(subsampleIdx(child, 5000 / 3));
  const parentShown = new Set(a);
  // every displayed child event is also displayed in the parent
  assert.ok([...sub].every(i => parentShown.has(i)));
  assert.equal(subsampleIdx(all, 0), all);
});

test('contours: equal-probability levels and closed marching-squares lines', () => {
  const nx = 40, ny = 40, grid = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) grid[y * nx + x] = Math.round(100 * Math.exp(-((x - 20) ** 2 + (y - 20) ** 2) / 40));
  const d = gaussianBlur(grid, nx, ny, 1.2);
  const levels = contourLevels(grid, d, 0.1);
  assert.ok(levels.length >= 6 && levels.length <= 9, `levels ${levels.length}`);
  assert.ok(levels.every((v, i) => !i || v > levels[i - 1]));
  const segs = marchingSquares(d, nx, ny, (levels[3] + levels[4]) / 2); // between grid values: no degenerate segments
  assert.ok(segs.length > 10);
  // a closed curve: every segment endpoint is shared with another segment
  const key = (x, y) => `${x.toFixed(6)},${y.toFixed(6)}`;
  const count = new Map();
  for (const [a, b, c, e] of segs) for (const k of [key(a, b), key(c, e)]) count.set(k, (count.get(k) || 0) + 1);
  assert.ok([...count.values()].every(n => n === 2));
});

test('SVG and PDF export of pseudocolor, contour and histogram plots', () => {
  const ws = demoWorkspace(1);
  ws.engine.add({ ...lymph });
  const s = ws.samples[0];
  for (const kind of ['contour', 'dot']) {
    const spec = buildSpec(ws, s, { pop: null, x: 'FITC-A', y: 'PE-A', kind }, 370, 340);
    const svg = renderSVG(370, 340, ctx => renderPlot(ctx, spec));
    assert.match(svg, /^<\?xml/);
    assert.match(svg, /<svg [^>]*viewBox="0 0 370 340"/);
    assert.ok(svg.includes('CD3 :: FITC-A'));
    assert.equal((svg.match(/<g /g) || []).length, (svg.match(/<\/g>/g) || []).length, 'balanced groups');
    const pdf = renderPDF(370, 340, ctx => renderPlot(ctx, spec));
    const txt = new TextDecoder('latin1').decode(pdf);
    assert.ok(txt.startsWith('%PDF-1.4') && txt.trimEnd().endsWith('%%EOF'));
    // xref offsets point at the objects
    const xref = +/startxref\n(\d+)/.exec(txt)[1];
    assert.ok(txt.slice(xref).startsWith('xref'));
    const offs = [...txt.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => +m[1]);
    offs.forEach((o, i) => assert.ok(txt.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
    // q/Q balanced and superscript ticks split into raised runs
    const content = txt.slice(txt.indexOf('stream\n') + 7, txt.indexOf('\nendstream'));
    assert.equal((content.match(/^q$/gm) || []).length, (content.match(/^Q$/gm) || []).length);
    assert.ok(content.includes('(10) Tj') && /\(\d\) Tj/.test(content));
  }
  // gates appear in vector output with their labels
  const fsc = buildSpec(ws, s, { pop: null, x: 'FSC-A', y: 'SSC-A', kind: 'dot' }, 370, 340);
  assert.ok(renderSVG(370, 340, ctx => renderPlot(ctx, fsc)).includes('Lymph'));
  assert.deepEqual(parseColor('rgba(10,20,30,0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
});

test('per-mode undo/redo', () => {
  const ws = demoWorkspace(1);
  ws.plots.push({ id: 'p1', pop: null, x: 'FSC-A', y: 'SSC-A', kind: 'pseudo' });
  ws.commit();
  ws.engine.add({ ...lymph }); ws.commit();
  ws.figures.push({ id: 'f1', kind: 'overlay-hist', x: 'PE-A', series: [] }); ws.commit();
  ws.statsCfg.stats = ['count']; ws.commit();
  // undo in layout leaves gates alone
  assert.ok(ws.undoStep('layout'));
  assert.equal(ws.figures.length, 0);
  assert.equal(ws.engine.list().length, 1);
  assert.ok(ws.undoStep('gating'));
  assert.equal(ws.engine.list().length, 0);
  assert.ok(ws.redoStep('gating'));
  assert.equal(ws.engine.list().length, 1);
  assert.ok(ws.undoStep('stats'));
  assert.deepEqual(ws.statsCfg.stats, ['count', 'pctParent', 'median']);
  // a new change clears the redo history of that mode
  assert.ok(ws.canRedo('layout'));
  ws.figures.push({ id: 'f2', kind: 'batch', x: 'PE-A' }); ws.commit();
  assert.ok(!ws.canRedo('layout'));
  // compensation toggle is a gating step
  ws.samples[0].setCompEnabled(false); ws.commit();
  ws.undoStep('gating');
  assert.equal(ws.samples[0].compEnabled, true);
});

test('metadata edits: keywords, labels, structural protection, undo', () => {
  const ws = demoWorkspace(1);
  const s = ws.samples[0];
  s.setKeyword('$OP', 'Operator A');
  s.setLabel('PE-A', 'CD4-PE');
  s.rename('Renamed');
  assert.equal(s.text['$OP'], 'Operator A');
  assert.equal(s.label('PE-A'), 'CD4-PE :: PE-A');
  assert.equal(s.text['$P5S'], 'CD4-PE');
  assert.throws(() => s.setKeyword('$DATATYPE', 'I'), /layout/);
  assert.throws(() => s.setKeyword('$P3B', '16'), /layout/);
  ws.commit();
  ws.undoStep('properties');
  assert.equal(s.text['$OP'], undefined);
  assert.equal(s.label('PE-A'), 'CD4 :: PE-A');
  assert.equal(s.name, 's0.fcs');
  ws.redoStep('properties');
  assert.equal(s.name, 'Renamed');
});

test('workspace file round trip keeps gates, label positions, edits and compensation', () => {
  const ws = demoWorkspace(2);
  ws.engine.add({ ...lymph, labelPos: [0.2, 0.9] });
  ws.figures.push({ id: 'f', kind: 'overlay-hist', x: 'PE-A', offset: 0.5, series: ws.samples.map((s, i) => ({ sampleId: s.id, pop: 'g1', color: SERIES_COLORS[i] })) });
  ws.samples[1].setKeyword('$OP', 'X'); ws.samples[1].setCompEnabled(false);
  ws.displayMax = 2000;
  const json = JSON.parse(JSON.stringify(ws.serialize()));
  assert.ok(!JSON.stringify(json).includes('"raw"'));
  const ws2 = demoWorkspace(2);
  const missing = ws2.deserialize(json);
  assert.deepEqual(missing, []);
  assert.deepEqual(ws2.engine.get('g1').labelPos, [0.2, 0.9]);
  assert.equal(ws2.figures[0].series.length, 2);
  assert.equal(ws2.figures[0].series[1].sampleId, ws2.samples[1].id);
  assert.equal(ws2.samples[1].text['$OP'], 'X');
  assert.equal(ws2.samples[1].compEnabled, false);
  assert.equal(ws2.displayMax, 2000);
});

test('template: no data or file names, re-expands to all samples, applies compensation and labels', () => {
  const ws = demoWorkspace(2);
  ws.engine.add({ ...lymph });
  ws.transforms['PE-A'] = { kind: 'arcsinh', cofactor: 150, min: -1000, max: 262144 };
  ws.samples[0].setLabel('APC-A', 'CD8a');
  ws.figures.push({ id: 'f', kind: 'overlay-hist', x: 'PE-A', series: ws.samples.map((s, i) => ({ sampleId: s.id, pop: 'g1', color: SERIES_COLORS[i] })) });
  const t = JSON.parse(JSON.stringify(ws.template()));
  const str = JSON.stringify(t);
  assert.equal(t.kind, 'template');
  assert.ok(!str.includes('.fcs') && !str.includes('sampleId'));
  assert.ok(t.compensation && t.compensation.names.length === 5);
  const target = demoWorkspace(3);
  target.samples.forEach(s => s.setCompEnabled(false));
  const { compApplied } = target.applyTemplate(t, SERIES_COLORS);
  assert.equal(compApplied, 3);
  assert.ok(target.samples.every(s => s.compEnabled));
  assert.equal(target.engine.list().length, 1);
  assert.equal(target.figures[0].series.length, 3, 'all-samples overlay re-expanded');
  assert.equal(target.transforms['PE-A'].kind, 'arcsinh');
  assert.ok(target.samples.every(s => s.label('APC-A') === 'CD8a :: APC-A'));
  assert.throws(() => target.deserialize(t), /template/);
});

test('workspace files keep the order of the samples', () => {
  const ws = demoWorkspace(3);
  ws.samples.reverse();
  const json = JSON.parse(JSON.stringify(ws.serialize()));
  const ws2 = demoWorkspace(3);
  assert.deepEqual(ws2.samples.map(s => s.key), ['s0.fcs', 's1.fcs', 's2.fcs']);
  ws2.deserialize(json);
  assert.deepEqual(ws2.samples.map(s => s.key), ['s2.fcs', 's1.fcs', 's0.fcs']);
});

test('per-sample gate adjustments: only that sample changes; saved with the workspace, not in templates', async () => {
  const { gateFor, isCustom } = await import('../js/gates.js');
  const ws = demoWorkspace(2);
  ws.engine.add({ ...lymph });
  const [a, b] = ws.samples;
  const before = ws.samples.map(s => ws.engine.population(s, 'g1').count);
  const g = ws.engine.get('g1');
  g.overrides = { [b.key]: { x0: 40000, x1: 60000, y0: 8000, y1: 38000 } }; // narrower for sample b only
  ws.engine.invalidate();
  const after = ws.samples.map(s => ws.engine.population(s, 'g1').count);
  assert.equal(after[0], before[0], 'other sample unchanged');
  assert.ok(after[1] < before[1] * 0.8, 'adjusted sample uses its own gate');
  assert.ok(isCustom(g, b) && !isCustom(g, a));
  assert.equal(gateFor(g, b).x1, 60000); assert.equal(gateFor(g, a).x1, 80000);
  // workspace file keeps it (by file name), template drops it
  const ws2 = demoWorkspace(2);
  ws2.deserialize(JSON.parse(JSON.stringify(ws.serialize())));
  assert.deepEqual(ws2.samples.map(s => ws2.engine.population(s, 'g1').count), after);
  assert.ok(!JSON.stringify(ws.template()).includes('overrides'));
  // undo restores the adjustment state
  ws.commit();
  delete g.overrides; ws.commit();
  ws.undoStep('gating');
  assert.ok(isCustom(ws.engine.get('g1'), ws.samples[1]));
});

test('split gate: left + right cover the parent exactly; per-sample line position', () => {
  const ws = demoWorkspace(2);
  ws.engine.add({ ...lymph });
  const base = { parent: 'g1', type: 'split', group: 'S1', x: 'FITC-A', y: null, cx: 1000, color: '#000' };
  ws.engine.add({ ...base, id: 'sL', name: 'CD3-', side: 'L' });
  ws.engine.add({ ...base, id: 'sR', name: 'CD3+', side: 'R' });
  for (const s of ws.samples) {
    const parent = ws.engine.population(s, 'g1').count;
    const l = ws.engine.population(s, 'sL').count, r = ws.engine.population(s, 'sR').count;
    assert.equal(l + r, parent, 'every parent event is on exactly one side');
    assert.ok(l > 0 && r > 0);
  }
  // removing one side removes its partner
  const ws2 = demoWorkspace(1);
  ws2.engine.add({ ...base, parent: null, id: 'a', side: 'L' }); ws2.engine.add({ ...base, parent: null, id: 'b', side: 'R' });
  ws2.engine.remove('a');
  assert.equal(ws2.engine.list().length, 0);
  // per-sample line position
  const b = ws.samples[1];
  const before = ws.engine.population(b, 'sR').count;
  for (const id of ['sL', 'sR']) ws.engine.get(id).overrides = { [b.key]: { cx: 3000 } };
  ws.engine.invalidate();
  assert.ok(ws.engine.population(b, 'sR').count < before);
  assert.equal(ws.engine.population(b, 'sL').count + ws.engine.population(b, 'sR').count, ws.engine.population(b, 'g1').count);
});
