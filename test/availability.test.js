// Statistical audit, case 14: a gate that needs a channel the sample does not have is NOT measured (blank, never 0),
// a genuinely empty gate is 0, and exported percentages keep full precision (3 of 100,000 = 0.003 %, not "0.00").
// Reference numbers (REFERENCE in the fixture module) were computed independently with numpy from the same files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFCS } from '../js/fcs.js';
import { Sample } from '../js/model.js';
import { GateEngine, populationStats, statValue, formatStat, exportStat } from '../js/gates.js';
import { makeGateFixtures, GATES, REFERENCE } from './fixtures/gate-availability.mjs';

const getCfg = ch => /FSC|SSC/.test(ch) ? { kind: 'linear', min: 0, max: 262144 } : { kind: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 };
const samples = Object.fromEntries(makeGateFixtures().map(f => [f.name.replace('.fcs', ''), new Sample(parseFCS(f.bytes, f.name)[0])]));
const engine = () => { const e = new GateEngine(getCfg); GATES.forEach(g => e.add({ ...g })); return e; };
const close = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);

test('a gate on a channel the sample lacks is not measured (and neither is any gate inside it)', () => {
  const eng = engine(), s = samples.S1_noCD3;
  for (const id of ['g3', 'g4']) {
    const st = populationStats(eng, s, id);
    assert.equal(st.available, false, `${id} must be flagged as not measured`);
    assert.deepEqual(st.missing, ['CD3'], `${id}: missing channel named`);
    for (const k of ['count', 'pctParent', 'pctTotal']) assert.ok(Number.isNaN(st[k]), `${id} ${k} must be NaN, got ${st[k]}`);
    // per-channel statistics of a population that cannot be evaluated are not measured either (CD4 exists here)
    assert.ok(Number.isNaN(statValue(eng, s, id, 'median', 'CD4')), `${id} median CD4 must be NaN`);
    assert.equal(exportStat(statValue(eng, s, id, 'count')), '', `${id} count exports blank, not 0`);
    assert.equal(formatStat(statValue(eng, s, id, 'pctTotal'), 'pctTotal'), '', `${id} %Total shows blank, not 0.00`);
  }
  // All Events is still measured
  assert.equal(statValue(eng, s, null, 'count'), 100000);
});

test('a measurable but empty gate reports 0 / 0 / 0', () => {
  const eng = engine(), s = samples.S2_CD3empty, ref = REFERENCE.S2_CD3empty.CD3;
  const st = populationStats(eng, s, 'g3');
  assert.equal(st.available, true);
  assert.equal(st.count, ref.count); assert.equal(st.pctParent, ref.pctParent); assert.equal(st.pctTotal, ref.pctTotal);
  assert.equal(exportStat(st.count), '0'); assert.equal(exportStat(st.pctTotal), '0'); assert.equal(formatStat(st.pctTotal, 'pctTotal'), '0.00');
  const child = populationStats(eng, s, 'g4');
  assert.equal(child.available, true); assert.equal(child.count, 0); assert.equal(child.pctTotal, 0);
});

test('3 of 100,000 events: 0.003 % kept at full precision in exports', () => {
  const eng = engine(), s = samples.S3_CD3rare3, ref = REFERENCE.S3_CD3rare3;
  const st = populationStats(eng, s, 'g3'), c = populationStats(eng, s, 'g4');
  assert.equal(st.count, ref.CD3.count); close(st.pctTotal, ref.CD3.pctTotal, 'CD3 %Total'); close(st.pctParent, ref.CD3.pctParent, 'CD3 %Parent');
  assert.equal(c.count, ref.CD4.count); close(c.pctParent, ref.CD4.pctParent, 'CD4 %Parent'); close(c.pctTotal, ref.CD4.pctTotal, 'CD4 %Total');
  close(statValue(eng, s, 'g3', 'median', 'CD3'), ref.CD3median, 'CD3 median in CD3+');
  // export text (CSV, Copy, Open in Thistle Plot) reads back as the exact value
  close(Number(exportStat(st.pctTotal)), 0.003, 'exported %Total round trip');
  close(Number(exportStat(c.pctParent)), ref.CD4.pctParent, 'exported %Parent round trip');
  // the on-screen text does not read as zero either
  assert.notEqual(Number(formatStat(st.pctTotal, 'pctTotal')), 0, 'screen text of 0.003 must not be 0.00');
  close(Number(formatStat(st.pctTotal, 'pctTotal')), 0.003, 'screen text of 0.003');
});

test('positive control matches the numpy reference', () => {
  const eng = engine(), s = samples.S4_CD3normal, ref = REFERENCE.S4_CD3normal;
  const st = populationStats(eng, s, 'g3'), c = populationStats(eng, s, 'g4');
  assert.equal(st.count, ref.CD3.count); close(st.pctTotal, ref.CD3.pctTotal, 'CD3 %Total');
  assert.equal(c.count, ref.CD4.count); close(c.pctParent, ref.CD4.pctParent, 'CD4 %Parent'); close(c.pctTotal, ref.CD4.pctTotal, 'CD4 %Total');
  assert.equal(formatStat(c.pctParent, 'pctParent'), '66.67'); // on-screen rounding unchanged for ordinary values
});
