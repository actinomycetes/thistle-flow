// Moving between samples (▲▼ buttons and the ↑ ↓ keys), quadrants (Q1–Q4) in the population menus,
// and the Statistics defaults (no channels, wide layout) with larger, resizable option boxes.
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

async function openDemo() {
  browser = browser || await pw.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await page.goto(BASE + '/index.html');
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  return { page, errors, ev: f => page.evaluate(f) };
}

test('step through samples with the ▲▼ buttons and the ↑ ↓ keys', { timeout: 120000 }, async () => {
  const { page, errors, ev } = await openDemo();
  const active = () => ev(() => window.thistleFlow.ws.activeSample().name);
  assert.equal(await active(), 'Unstimulated.fcs');
  assert.equal(await page.isDisabled('#sampleStep button[title^="Previous"]'), true, 'no previous sample at the top');
  await page.keyboard.press('ArrowDown');
  assert.equal(await active(), 'Stim_6h.fcs');
  assert.match(await page.textContent('#activeSampleInfo'), /Active sample: Stim_6h\.fcs/);
  await page.click('#sampleStep button[title^="Next"]');
  assert.equal(await active(), 'Stim_24h.fcs');
  assert.equal(await page.isDisabled('#activeSampleInfo button[title^="Next"]'), true, 'no next sample at the bottom');
  await page.keyboard.press('ArrowDown'); // stays on the last sample
  assert.equal(await active(), 'Stim_24h.fcs');
  await page.click('#activeSampleInfo button[title^="Previous"]');
  assert.equal(await active(), 'Stim_6h.fcs');
  await page.keyboard.press('ArrowUp');
  assert.equal(await active(), 'Unstimulated.fcs');
  // the gate tree and plots follow the active sample
  assert.match(await ev(() => [...window.thistleFlow.views.values()][0].spec.title), /Unstimulated\.fcs/);
  // stepping leaves an overlay of several samples
  await page.locator('.sample-list li').nth(2).click({ modifiers: ['Shift'] });
  assert.equal(await ev(() => window.thistleFlow.ws.selSamples.length), 3);
  await page.keyboard.press('ArrowDown');
  assert.equal(await ev(() => window.thistleFlow.ws.selSamples.length), 0);
  assert.equal(await active(), 'Stim_6h.fcs');
  // arrow keys inside a menu keep working as usual (no sample change)
  await page.locator('.plot-card select').first().focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await active(), 'Stim_6h.fcs');
  assert.deepEqual(errors, []);
  await page.close();
});

test('quadrants are listed as Q1–Q4 in the population menus', { timeout: 120000 }, async () => {
  const { page, errors, ev } = await openDemo();
  await ev(() => { const ws = window.thistleFlow.ws; ws.plots[1].x = 'PE-A'; ws.plots[1].y = 'APC-A'; window.thistleFlow.renderAll(); });
  const b = await page.locator('.plot-card canvas').nth(1).boundingBox();
  await page.click('[data-tool=quad]');
  await page.mouse.click(b.x + 64 + 0.55 * (b.width - 78), b.y + 24 + 0.45 * (b.height - 72));
  const opts = (await page.locator('.plot-card').first().locator('select[title^="Population"] option').allTextContents()).map(s => s.trim());
  for (const q of ['Q1 · CD4- CD8+', 'Q2 · CD4+ CD8+', 'Q3 · CD4+ CD8-', 'Q4 · CD4- CD8-']) assert.ok(opts.includes(q), `${q} in ${opts.join(' | ')}`);
  // choosing one draws the plot of that quadrant
  const q2 = await ev(() => window.thistleFlow.ws.engine.list().find(g => g.type === 'quad' && g.q === 'UR').id);
  await page.locator('.plot-card').first().locator('select[title^="Population"]').selectOption(q2);
  assert.equal(await ev(() => window.thistleFlow.ws.plots[0].pop), q2);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Statistics: no channels ticked and Wide layout by default; option boxes are larger and resizable', { timeout: 120000 }, async () => {
  const { page, errors, ev } = await openDemo();
  await page.click('button[data-tab="stats"]');
  const chanBoxes = page.locator('.stat-list[data-list="channels"] input[type=checkbox]');
  assert.ok(await chanBoxes.count() > 3);
  assert.equal(await page.locator('.stat-list[data-list="channels"] input:checked').count(), 0, 'no channel ticked');
  assert.equal(await page.locator('#statsControls select').inputValue(), 'wide');
  const head = await page.locator('#statsTable thead th').allTextContents();
  assert.ok(!head.some(t => /Median/.test(t)), 'no per-channel columns until a channel is ticked');
  assert.equal(await page.locator('#statsTable tbody tr').count(), 3, 'wide: one row per sample');
  // ticking a channel adds its median column
  await chanBoxes.first().check();
  assert.ok((await page.locator('#statsTable thead th').allTextContents()).some(t => /Median/.test(t)));
  // boxes: taller than before (120 px) and resizable; a new size is remembered
  const box = page.locator('.stat-list[data-list="pops"]');
  const st = await box.evaluate(el => ({ resize: getComputedStyle(el).resize, h: el.getBoundingClientRect().height }));
  assert.equal(st.resize, 'both');
  assert.ok(st.h >= 180, 'default height ' + st.h);
  await box.evaluate(el => { el.style.height = '260px'; el.style.width = '320px'; });
  await page.waitForTimeout(200);
  await page.click('button[data-tab="gating"]'); await page.click('button[data-tab="stats"]');
  const h2 = await page.locator('.stat-list[data-list="pops"]').evaluate(el => Math.round(el.getBoundingClientRect().height));
  assert.equal(h2, 260, 'resized box keeps its size');
  assert.deepEqual(errors, []);
  await page.close();
});
