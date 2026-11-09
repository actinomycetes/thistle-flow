import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip, readZip, isZip, crc32 } from '../js/zip.js';
import { parseFCS } from '../js/fcs.js';
import { Sample } from '../js/model.js';
import { Workspace } from '../js/workspace.js';
import { makeDemoFile } from '../js/demo.js';

test('crc32 matches the reference value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip round trip: compressed and stored entries, UTF-8 names, damage detection', async () => {
  const big = new Uint8Array(200000).map((_, i) => (i * 7) % 13); // compressible
  const rnd = crypto.getRandomValues(new Uint8Array(5000));        // not compressible -> stored
  const zip = await createZip([{ name: 'workspace.json', data: '{"a":1}' }, { name: 'fcs/Probe µ 1.fcs', data: big }, { name: 'fcs/r.fcs', data: rnd }]);
  assert.ok(isZip(zip));
  assert.ok(zip.length < big.length / 4, 'compressed');
  const out = await readZip(zip);
  assert.deepEqual(out.map(e => e.name), ['workspace.json', 'fcs/Probe µ 1.fcs', 'fcs/r.fcs']);
  assert.equal(new TextDecoder().decode(out[0].data), '{"a":1}');
  assert.deepEqual(out[1].data, big);
  assert.deepEqual(out[2].data, rnd);
  const stored = await createZip([{ name: 'x', data: big }], { compress: false });
  assert.deepEqual((await readZip(stored))[0].data, big);
  const bad = zip.slice(); bad[30 + 14 + 2] ^= 0xff; // corrupt a byte of workspace.json (header 30 + name 14)
  await assert.rejects(readZip(bad), /damaged|checksum|invalid|incorrect/i);
  await assert.rejects(readZip(new Uint8Array(100)), /Not a zip/);
});

test('workspace bundle round trip restores samples, gates and edits', async () => {
  const ws = new Workspace('Exp');
  for (const [name, act] of [['A.fcs', 0.1], ['B.fcs', 0.6]]) {
    const buf = makeDemoFile(name, act, 3, 5000);
    const [ds] = parseFCS(buf, name);
    const s = new Sample(ds); s.source = { name, data: new Uint8Array(buf) };
    ws.samples.push(s);
  }
  ws.engine.add({ id: 'g1', name: 'Lymph', parent: null, type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 40000, x1: 80000, y0: 8000, y1: 38000, color: '#e6194b' });
  ws.samples[1].setKeyword('$OP', 'TT');
  const data = ws.serialize();
  data.files = ws.sourceFiles().map(f => ({ entry: 'fcs/' + f.name, name: f.name }));
  assert.deepEqual(data.samples.map(e => e.file), ['A.fcs', 'B.fcs']);
  const zip = await createZip([{ name: 'workspace.json', data: JSON.stringify(data) }, ...ws.sourceFiles().map(f => ({ name: 'fcs/' + f.name, data: f.data }))]);
  // reopen as the app does
  const entries = await readZip(zip);
  const back = JSON.parse(new TextDecoder().decode(entries.find(e => e.name === 'workspace.json').data));
  const ws2 = new Workspace('x');
  for (const e of entries.filter(e => e.name.startsWith('fcs/'))) {
    const [ds] = parseFCS(e.data.slice().buffer, e.name.slice(4));
    ws2.samples.push(new Sample(ds));
  }
  assert.deepEqual(ws2.deserialize(back), []);
  assert.equal(ws2.engine.list().length, 1);
  assert.equal(ws2.samples[1].text['$OP'], 'TT');
  const pop = s => ws2.engine.population(s, 'g1').count;
  assert.deepEqual(ws2.samples.map(pop), ws.samples.map(s => ws.engine.population(s, 'g1').count));
});
