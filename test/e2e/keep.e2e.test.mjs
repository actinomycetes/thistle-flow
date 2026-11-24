// The kept session: the open workspaces (with their FCS files) are copied to this browser's IndexedDB and
// reopen after a refresh; Start fresh empties it; inside another page (Thistle Notebook) nothing is kept or restored.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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

const flow = page => page.evaluate(() => {
  const a = window.thistleFlow;
  return { tabs: a.workspaces.map(w => w.name), active: a.ws.name, samples: a.ws.samples.map(s => s.name), gates: a.ws.engine.list().map(g => g.name), dirty: a.ws.dirty };
});
const waitKept = page => page.waitForFunction(() => window.thistleFlow.sessionKept(), null, { timeout: 15000 });

test('work is kept across a refresh and Start fresh empties it', { timeout: 180000 }, async () => {
  browser = browser || await pw.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/index.html');
  assert.equal(await page.locator('.restore-note').count(), 0, 'nothing to reopen on a first visit');
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  await page.evaluate(() => { const e = window.thistleFlow.ws.engine;
    e.add({ id: 'gA', name: 'Lymphocytes', parent: null, type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 30000, x1: 75000, y0: 3000, y1: 60000, color: '#d55e00' });
    window.thistleFlow.ws.name = 'Day 1'; window.thistleFlow.renderAll(); });
  // a second workspace tab, left active
  await page.click('.ws-add');
  await page.evaluate(() => { window.thistleFlow.ws.name = 'Day 2'; window.thistleFlow.ws.engine.add({ id: 'gB', name: 'Cells', parent: null, type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 1, x1: 2, y0: 1, y1: 2, color: '#3a8fc4' }); window.thistleFlow.renderAll(); });
  await waitKept(page);
  const before = await flow(page);
  await page.reload();
  await page.waitForSelector('.restore-note');
  assert.deepEqual(await flow(page), before, 'same tabs, active tab, gates and unsaved mark');
  assert.match(await page.textContent('.restore-note'), /Reopened your last session/);
  await page.click('.ws-tab >> text=Day 1');
  const d1 = await flow(page);
  assert.deepEqual(d1.samples, ['Unstimulated.fcs', 'Stim_6h.fcs', 'Stim_24h.fcs'], 'FCS files reopened from the browser');
  assert.deepEqual(d1.gates, ['Lymphocytes']);
  await page.waitForSelector('.plot-card canvas');
  // a change after reopening is kept too
  await page.evaluate(() => { window.thistleFlow.ws.engine.add({ id: 'gC', name: 'Singlets', parent: 'gA', type: 'rect', x: 'FSC-A', y: 'FSC-H', x0: 1, x1: 2, y0: 1, y1: 2, color: '#009e73' }); window.thistleFlow.renderAll(); });
  await waitKept(page);
  await page.reload(); await page.waitForSelector('.restore-note');
  await page.click('.ws-tab >> text=Day 1');
  assert.deepEqual((await flow(page)).gates, ['Lymphocytes', 'Singlets']);
  // Start fresh: one empty workspace, and nothing reopens afterwards
  page.once('dialog', d => d.accept());
  await page.click('.restore-note button:has-text("Start fresh")');
  await page.waitForFunction(() => window.thistleFlow.workspaces.length === 1 && !window.thistleFlow.ws.samples.length);
  await waitKept(page);
  await page.reload(); await page.waitForTimeout(1500);
  assert.equal(await page.locator('.restore-note').count(), 0);
  assert.deepEqual((await flow(page)).samples, []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('inside another page (as in Thistle Notebook) nothing is restored or kept', { timeout: 120000 }, async () => {
  browser = browser || await pw.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  await waitKept(page);
  // a same-site page that embeds Thistle Flow
  await page.route('**/embed-test.html', r => r.fulfill({ contentType: 'text/html', body: '<iframe id="f" src="index.html" style="width:1200px;height:800px"></iframe>' }));
  await page.goto(BASE + '/embed-test.html');
  const frame = page.frameLocator('#f');
  await frame.locator('#btnDemo').waitFor();
  await page.waitForTimeout(1500);
  const inner = page.frames().find(f => f.url().endsWith('/index.html'));
  assert.equal(await inner.evaluate(() => window.thistleFlow.ws.samples.length), 0, 'embedded copy starts empty');
  assert.equal(await frame.locator('.restore-note').count(), 0);
  // and it does not overwrite the kept session: the top-level app still reopens the demo
  await page.goto(BASE + '/index.html'); await page.waitForSelector('.restore-note');
  assert.equal(await page.evaluate(() => window.thistleFlow.ws.samples.length), 3);
  await ctx.close();
});

test('a workspace opened while the kept session is still being read is not replaced by it', { timeout: 180000 }, async () => {
  browser = browser || await pw.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/index.html');
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  await page.evaluate(() => { const a = window.thistleFlow; a.ws.name = 'Kept'; a.ws.engine.add({ id: 'gK', name: 'Kept gate', parent: null, type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 1, x1: 2, y0: 1, y1: 2 }); a.renderAll(); });
  await waitKept(page);
  // a workspace file to open right after the reload (without its FCS files, so it opens at once)
  const file = path.join(fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'tf-keep-')), 'Opened.tflow');
  const data = await page.evaluate(() => { const d = window.thistleFlow.ws.serialize(); d.name = 'Opened'; d.gates = [{ id: 'gO', name: 'Opened gate', parent: null, type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 1, x1: 2, y0: 1, y1: 2 }]; d.samples = []; return d; });
  fs.writeFileSync(file, JSON.stringify(data));
  await page.addInitScript(() => { window.TF_RESTORE_DELAY = 2000; }); // the kept copy takes a while to read
  await page.reload();
  await page.setInputFiles('#wsInput', file);
  await page.waitForFunction(() => window.thistleFlow.ws.name === 'Opened');
  await page.waitForSelector('.restore-note', { timeout: 15000 });
  const f = await flow(page);
  assert.equal(f.active, 'Opened', 'the opened workspace stays in front');
  assert.deepEqual(f.gates, ['Opened gate']);
  assert.deepEqual(f.tabs, ['Opened', 'Kept'], 'the earlier session comes back in an extra tab');
  assert.match(await page.textContent('.restore-note'), /extra tabs, next to what you opened/);
  assert.equal(await page.locator('.restore-note button:has-text("Start fresh")').count(), 0, 'no Start fresh that would also remove what was opened');
  assert.deepEqual(errors, []);
  await ctx.close();
});
