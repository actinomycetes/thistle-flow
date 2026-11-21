// Statistical audit, case 14, through the real app: a gate that needs a channel the sample lacks is blank (not 0)
// in the gate tree, the Statistics table, Export CSV, Copy and Open in Thistle Plot; a measurable empty gate is 0;
// rare percentages keep full precision in exports and in the table's data-v attributes.
// Expected numbers: REFERENCE in test/fixtures/gate-availability.mjs (numpy on the same files).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeGateFixtures, GATES, REFERENCE } from '../fixtures/gate-availability.mjs';

const require = createRequire(import.meta.url);
const ENGINE = process.env.TF_BROWSER || 'chromium';
const pw = require('playwright')[ENGINE];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = p.endsWith('/') ? path.join(p, 'index.html') : p;
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}`;
let browser;
after(async () => { await browser?.close(); server.close(); });

const close = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
// rows of a wide table (CSV/TSV text) -> { sample: { header: cell } }
const byCell = (text, sep) => {
  const [head, ...rows] = text.trim().split('\n').map(l => l.split(sep));
  return Object.fromEntries(rows.map(r => [r[0].replace(/\.fcs$/, ''), Object.fromEntries(head.map((h, i) => [h, r[i]]))]));
};
const C = { cnt: 'CD3+ | Count', par: 'CD3+ | % Parent', tot: 'CD3+ | % Total', med: 'CD3+ | Median (MFI) | CD4',
  cnt4: 'CD3+/CD4+ | Count', par4: 'CD3+/CD4+ | % Parent', tot4: 'CD3+/CD4+ | % Total' };

function checkExported(t, label) {
  for (const k of Object.values(C)) assert.equal(t.S1_noCD3[k], '', `${label}: no-CD3 sample, "${k}" must be blank (not measured), got "${t.S1_noCD3[k]}"`);
  assert.notEqual(t.S1_noCD3['All Events | Count'], '', `${label}: All Events still measured`);
  assert.equal(t.S2_CD3empty[C.cnt], '0', `${label}: empty gate count`); assert.equal(Number(t.S2_CD3empty[C.tot]), 0, `${label}: empty gate %Total`);
  assert.equal(t.S2_CD3empty[C.par], '0', `${label}: empty gate %Parent`);
  const r = REFERENCE.S3_CD3rare3;
  close(Number(t.S3_CD3rare3[C.tot]), r.CD3.pctTotal, `${label}: rare %Total (cell "${t.S3_CD3rare3[C.tot]}")`);
  close(Number(t.S3_CD3rare3[C.tot4]), r.CD4.pctTotal, `${label}: rare CD4 %Total`);
  close(Number(t.S3_CD3rare3[C.par4]), r.CD4.pctParent, `${label}: rare CD4 %Parent`);
  assert.equal(Number(t.S3_CD3rare3[C.cnt]), r.CD3.count);
  close(Number(t.S4_CD3normal[C.par4]), REFERENCE.S4_CD3normal.CD4.pctParent, `${label}: control CD4 %Parent`);
}

test('missing-channel gates are blank, empty gates are 0, exports keep full precision', { timeout: 120000 }, async () => {
  browser = await pw.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true,
    ...(ENGINE === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.stack));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} window.showSaveFilePicker = undefined; });
  await page.goto(BASE + '/?nosession');
  const files = makeGateFixtures().map(f => ({ name: f.name, mimeType: 'application/octet-stream', buffer: Buffer.from(f.bytes) }));
  await page.setInputFiles('#fileInput', files);
  await page.waitForFunction(() => window.thistleFlow.ws.samples.length === 4, null, { timeout: 60000 });
  await page.evaluate(gates => {
    const ws = window.thistleFlow.ws;
    gates.forEach(g => ws.engine.add({ ...g }));
    Object.assign(ws.statsCfg, { pops: null, stats: ['count', 'pctParent', 'pctTotal', 'median'], channels: ['CD3', 'CD4'], layout: 'wide' });
    ws.activeId = ws.samples.find(s => s.name.startsWith('S1')).id;
    window.thistleFlow.renderAll();
  }, GATES);

  // gate tree: not "0.00% · 0" but a dash, with the reason in plain words
  const tree = await page.evaluate(() => [...document.querySelectorAll('#gateTree .node')].map(n => ({ t: n.querySelector('.gpct').textContent, title: n.querySelector('.gpct').title })));
  assert.equal(tree[1].t, '–', `CD3+ in the gate tree of the no-CD3 sample: "${tree[1].t}"`);
  assert.match(tree[1].title, /CD3 not in this sample/);
  assert.equal(tree[2].t, '–', 'child gate too');

  // re-review: an unavailable population cannot be exported as an FCS file (it would read as a measured 0-event file)
  const exportBtn = sel => page.evaluate(i => { const b = document.querySelectorAll('#gateTree .node')[i].querySelector('button[title*="FCS"]');
    return b ? { disabled: b.disabled, title: b.title } : null; }, sel);
  for (const i of [1, 2]) { const b = await exportBtn(i); assert.ok(b && b.disabled, `export button of unavailable gate ${i} is disabled`); assert.match(b.title, /cannot be exported|not in this sample/i); }
  assert.equal((await exportBtn(0)).disabled, false, 'All Events can still be exported');
  const refused = await page.evaluate(() => { const ws = window.thistleFlow.ws, s = ws.activeSample(), g = ws.engine.list().find(x => x.name === 'CD3+');
    return window.thistleFlow.exportPopulation(s, g.id); });
  assert.equal(refused, false, 'exportPopulation refuses a population whose gate needs a missing channel');
  // a measured empty population still exports a valid 0-event file
  await page.evaluate(() => { const ws = window.thistleFlow.ws; ws.activeId = ws.samples.find(s => s.name.startsWith('S2')).id; window.thistleFlow.renderAll(); });
  assert.equal((await exportBtn(1)).disabled, false, 'empty but measured gate can be exported');
  const [fcs] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => document.querySelectorAll('#gateTree .node')[1].querySelector('button[title*="FCS"]').click())]);
  const head = fs.readFileSync(await fcs.path(), 'latin1');
  assert.match(fcs.suggestedFilename(), /S2_CD3empty_CD3\+\.fcs/); assert.match(head, /\$TOT.0\D/, 'zero-event FCS file');
  await page.evaluate(() => { const ws = window.thistleFlow.ws; ws.activeId = ws.samples.find(s => s.name.startsWith('S1')).id; window.thistleFlow.renderAll(); });

  // Statistics table
  await page.click('[data-tab=stats]');
  const table = await page.evaluate(() => {
    const t = document.getElementById('statsTable');
    const head = [...t.querySelectorAll('thead th')].map(c => c.textContent);
    return Object.fromEntries([...t.querySelectorAll('tbody tr')].map(tr => { const c = [...tr.children];
      return [c[0].textContent.replace(/\.fcs$/, ''), Object.fromEntries(head.map((h, i) => [h, { t: c[i].textContent, v: c[i].getAttribute('data-v') }]))]; }));
  });
  for (const k of Object.values(C)) {
    assert.equal(table.S1_noCD3[k].t, '', `table: no-CD3 "${k}" must be blank, got "${table.S1_noCD3[k].t}"`);
    assert.equal(table.S1_noCD3[k].v, '', `table: no-CD3 "${k}" data-v must be ""`);
  }
  assert.equal(table.S2_CD3empty[C.cnt].t, '0'); assert.equal(table.S2_CD3empty[C.tot].t, '0.00'); assert.equal(table.S2_CD3empty[C.tot].v, '0');
  close(Number(table.S3_CD3rare3[C.tot].v), 0.003, 'data-v of the rare %Total');
  assert.notEqual(Number(table.S3_CD3rare3[C.tot].t), 0, `on-screen rare %Total must not read as 0 ("${table.S3_CD3rare3[C.tot].t}")`);
  close(Number(table.S4_CD3normal[C.par4].v), REFERENCE.S4_CD3normal.CD4.pctParent, 'data-v of 66.67');
  assert.equal(table.S4_CD3normal[C.par4].t, '66.67', 'ordinary percentages keep their on-screen rounding');
  assert.equal(table.S1_noCD3.Sample.v, null, 'sample-name cells carry no data-v');
  const note = await page.locator('#statsNote').textContent();
  assert.match(note, /S1_noCD3.*no CD3 channel.*cannot be applied/s, `note under the table: "${note}"`);

  // the long layout is blank too
  await page.selectOption('#statsControls select', 'long');
  const longRow = await page.evaluate(() => [...document.querySelectorAll('#statsTable tbody tr')].map(tr => [...tr.children].map(c => c.textContent)).find(r => /S1_noCD3/.test(r[0]) && r[1] === 'CD3+'));
  assert.deepEqual(longRow.slice(2).filter(Boolean), [], `long layout, no-CD3 CD3+ row: ${JSON.stringify(longRow)}`);
  await page.selectOption('#statsControls select', 'wide');

  // Export CSV
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#statsControls button.primary')]);
  checkExported(byCell(fs.readFileSync(await dl.path(), 'utf8'), ','), 'CSV');

  // Copy (clipboard reading is reliable in Chromium only)
  if (ENGINE === 'chromium') {
    await page.click('#statsControls button:has-text("Copy")');
    await page.waitForFunction(() => /Table copied/.test(document.getElementById('toast').textContent));
    checkExported(byCell(await page.evaluate(() => navigator.clipboard.readText()), '\t'), 'Copy');
  }

  // Open in Thistle Plot (stand-in page that follows the handshake)
  await page.evaluate(() => { window.TF_TP_URL = '/test/e2e/fake-tp.html'; });
  const [tp] = await Promise.all([ctx.waitForEvent('page'), page.click('#btnStatsToTP')]);
  await tp.waitForFunction(() => window.received, null, { timeout: 10000 });
  checkExported(byCell((await tp.evaluate(() => window.received)).csv, ','), 'Open in Thistle Plot');
  await tp.close();
  assert.deepEqual(errors, []);
  await ctx.close();
});
