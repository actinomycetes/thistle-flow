// End-to-end UI test: drives the real app in Chromium (Playwright).
// Run with: npm run test:e2e   (needs `npm install` and `npx playwright install chromium` once)
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// TF_BROWSER=firefox or webkit runs the same suite in another engine (lab users run Firefox and Safari)
const ENGINE = process.env.TF_BROWSER || 'chromium';
const chromium = require('playwright')[ENGINE];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'thistle-flow-e2e-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

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

test('all UI features work end to end', { timeout: 240000 }, async () => {
  const results = [];
  const check = (name, cond, extra = '') => { results.push({ name, ok: !!cond, extra }); };
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.stack));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} window.showSaveFilePicker = undefined; });
  const prompts = [];
  page.on('dialog', d => { const v = prompts.shift(); d.accept(v === undefined ? undefined : v); });
  const ev = f => page.evaluate(f);
  await page.goto(BASE + '/');
  await page.click('#btnDemo');
  await page.waitForSelector('.plot-card canvas');
  await page.waitForTimeout(400);

  const plotBox = async i => page.locator('.plot-card canvas').nth(i).boundingBox();
  const P = (b, ux, uy) => [b.x + 64 + ux * (b.width - 78), b.y + 24 + (1 - uy) * (b.height - 72)];

  // (1) gate -> back to select; label drag
  await page.click('[data-tool=rect]');
  let b = await plotBox(0);
  prompts.push('Lymphocytes');
  { const [x, y] = P(b, 0.12, 0.02); await page.mouse.move(x, y); await page.mouse.down(); const [x2, y2] = P(b, 0.32, 0.17); await page.mouse.move(x2, y2, { steps: 5 }); await page.mouse.up(); }
  await page.waitForTimeout(300);
  check('(1) tool returns to Select after drawing a gate', await ev(() => window.thistleFlow.tool === 'select'));
  const lb = await ev(() => { const v = [...window.thistleFlow.views.values()][0]; return v.spec.gates[0].labelBox; });
  b = await plotBox(0);
  await page.mouse.move(b.x + lb.cx, b.y + lb.cy); await page.mouse.down();
  await page.mouse.move(b.x + lb.cx + 120, b.y + lb.cy - 90, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(200);
  const lb2 = await ev(() => { const v = [...window.thistleFlow.views.values()][0]; return { box: v.spec.gates[0].labelBox, pos: v.spec.gates[0].gate.labelPos, g: v.spec.gates[0].gate.x0 }; });
  check('(1) gate label can be dragged with Select', lb2.pos && Math.abs(lb2.box.cx - lb.cx - 120) < 3 && Math.abs(lb2.box.cy - lb.cy + 90) < 3, JSON.stringify(lb2.pos));
  // drag label far outside: stays inside plot
  await page.mouse.move(b.x + lb2.box.cx, b.y + lb2.box.cy); await page.mouse.down();
  await page.mouse.move(b.x + 2000, b.y - 500, { steps: 4 }); await page.mouse.up();
  const lb3 = await ev(() => [...window.thistleFlow.views.values()][0].spec.gates[0].labelBox);
  check('(1) label stays within the plot', lb3.x + lb3.w <= b.width - 14 + 1 && lb3.y >= 24 - 1, JSON.stringify(lb3));

  // (2) events per plot
  await page.selectOption('#displayMax', '1000');
  await page.waitForTimeout(200);
  const titles = await ev(() => [...window.thistleFlow.views.values()].map(v => v.spec.title));
  const shown = titles.map(t => (/showing ([\d,]+)/.exec(t) || [])[1]).filter(Boolean).map(s => +s.replace(/,/g, ''));
  check('(2) workspace event limit thins 2-D plots', shown.length >= 2 && shown.every(n => n > 800 && n < 1200), titles.join(' | '));
  await page.locator('.plot-card').nth(0).locator('button[title^="Plot settings"]').click();
  await page.locator('.popover select').nth(1).selectOption('0');
  await page.waitForTimeout(200);
  const t0 = await ev(() => [...window.thistleFlow.views.values()][0].spec.title);
  check('(2) per-plot override (All events)', !/showing/.test(t0), t0);
  await page.keyboard.press('Escape');

  // (7) density/contour + (3) multi-select via rubber band
  const grid = await page.locator('#plotGrid').boundingBox();
  await page.mouse.move(grid.x + grid.width - 6, grid.y + grid.height - 6); await page.mouse.down();
  await page.mouse.move(grid.x + 4, grid.y + 4, { steps: 8 }); await page.mouse.up();
  const nsel = await ev(() => window.thistleFlow.ws.selPlots.size);
  check('(3) rubber-band selects plots', nsel === 3, `selected ${nsel}`);
  await page.locator('.plot-card').nth(0).locator('select[title="Plot type"]').selectOption('contour');
  await page.waitForTimeout(300);
  const kinds = await ev(() => window.thistleFlow.ws.plots.map(p => p.kind));
  check('(3) changing one selected plot changes all', kinds.filter(k => k === 'contour').length === 3, kinds.join(','));
  await page.locator('.plot-card').nth(2).locator('.plot-head').click({ modifiers: ['Shift'], position: { x: 300, y: 30 } }).catch(() => {});
  const nsel2 = await ev(() => window.thistleFlow.ws.selPlots.size);
  // shift-click on the header empty spot may land on a select; fall back to evaluating
  check('(3) shift-click toggles a plot out of the selection', nsel2 === 2, `selected ${nsel2}`);
  await page.keyboard.press('Escape');
  // set up the four 2-D kinds side by side
  await ev(() => {
    const ws = window.thistleFlow.ws; const [p0, p1] = ws.plots;
    p0.kind = 'pseudo'; p0.maxEvents = undefined; p1.kind = 'contour';
    ws.plots.push({ id: 'pD', pop: null, x: p1.x, y: p1.y, kind: 'smooth' }, { id: 'pE', pop: null, x: p1.x, y: p1.y, kind: 'dot' });
    ws.selPlots.clear(); window.thistleFlow.renderAll();
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + '/e-kinds.png' });
  check('(7) density + contour plots render', await ev(() => [...window.thistleFlow.views.values()].every(v => v.spec)));

  // (8b) per-axis scale: click Y axis of plot 2
  b = await plotBox(1);
  await page.mouse.click(b.x + 20, b.y + 24 + 100);
  await page.waitForTimeout(200);
  const modalTitle = await page.textContent('#modalTitle');
  check('(8b) clicking an axis opens that axis scale', modalTitle === 'Y axis scale', modalTitle);
  const yCh = await ev(() => window.thistleFlow.ws.plots[1].y);
  await page.locator('#modalBody select').nth(1).selectOption('arcsinh');
  await page.waitForTimeout(150);
  check('(8b) Y axis scale changed independently', await page.evaluate(ch => window.thistleFlow.ws.transforms[ch].kind === 'arcsinh' && window.thistleFlow.ws.transforms[window.thistleFlow.ws.plots[1].x].kind !== 'arcsinh', yCh));
  await page.click('#modalClose');

  // (11) undo/redo in gating
  const nG = await ev(() => window.thistleFlow.ws.engine.list().length);
  await page.click('#btnUndo'); await page.waitForTimeout(150);
  const afterUndo = await ev(() => window.thistleFlow.ws.transforms[window.thistleFlow.ws.plots[1].y].kind);
  check('(11) undo reverts last gating change (axis scale)', afterUndo !== 'arcsinh', afterUndo);
  await page.keyboard.press('Control+Shift+Z'); await page.waitForTimeout(150);
  check('(11) redo re-applies it', await ev(() => window.thistleFlow.ws.transforms[window.thistleFlow.ws.plots[1].y].kind) === 'arcsinh');

  // (8) histogram offsets + layout undo separate from gating
  await page.click('[data-tab=layout]');
  await page.click('[data-addfig=overlay-hist]');
  await page.waitForTimeout(200);
  const fig = page.locator('.figure-card').first();
  await fig.locator('select').first().selectOption('PE-Cy7-A');
  const offSel = fig.locator('label:has-text("Offset") select');
  await offSel.selectOption('0.5'); await page.waitForTimeout(150);
  await fig.screenshot({ path: OUT + '/e-half.png' });
  await offSel.selectOption('1'); await page.waitForTimeout(150);
  await fig.screenshot({ path: OUT + '/e-full.png' });
  check('(8) histogram offset presets', await ev(() => window.thistleFlow.ws.figures[0].offset) === 1);
  await page.click('#btnUndo'); await page.waitForTimeout(150);
  const offAfterUndo = await ev(() => window.thistleFlow.ws.figures[0]?.offset);
  const gatesAfterLayoutUndo = await ev(() => window.thistleFlow.ws.engine.list().length);
  check('(11) layout undo is separate from gating', offAfterUndo === 0.5 && gatesAfterLayoutUndo === nG, `offset ${offAfterUndo}, gates ${gatesAfterLayoutUndo}`);

  // (9) exports: figure PNG/SVG/PDF
  for (const fmt of ['svg', 'pdf', 'png']) {
    await fig.locator('button:has-text("Export")').click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`.popover button:has-text("${fmt.toUpperCase()}")`)]);
    const p = `${OUT}/export.${fmt}`; await dl.saveAs(p);
    const head = fs.readFileSync(p).subarray(0, 8).toString('latin1');
    check(`(9) export ${fmt.toUpperCase()}`, (fmt === 'svg' ? head.startsWith('<?xml') : fmt === 'pdf' ? head.startsWith('%PDF') : head.includes('PNG')), dl.suggestedFilename());
  }
  // gating plot export (pseudocolor embeds an image) as PDF/SVG
  await page.click('[data-tab=gating]');
  for (const fmt of ['pdf', 'svg']) {
    await page.locator('.plot-card').nth(0).locator('button[title^="Export plot"]').click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`.popover button:has-text("${fmt.toUpperCase()}")`)]);
    await dl.saveAs(`${OUT}/plot.${fmt}`);
  }
  await page.locator('.plot-card').nth(1).locator('button[title^="Export plot"]').click();
  { const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.popover button:has-text("PDF")')]); await dl.saveAs(`${OUT}/contour.pdf`); }

  // (12) save dialog with dated name
  await page.click('#btnSaveWs');
  const fname = await page.inputValue('#modalBody input[type=text]');
  check('(12) save dialog pre-fills a dated name', /^Workspace 1_\d{4}-\d{2}-\d{2}_\d{4}$/.test(fname), fname);
  await page.fill('#modalBody input[type=text]', 'MyExperiment_' + fname.split('_').slice(1).join('_'));
  const [wsDl] = await Promise.all([page.waitForEvent('download'), page.click('#modalBody button.primary')]);
  await wsDl.saveAs(`${OUT}/ws.json`);
  check('(12) saved with the chosen name', /^MyExperiment_.*\.json$/.test(wsDl.suggestedFilename()), wsDl.suggestedFilename());
  check('(12) workspace no longer marked unsaved', await ev(() => !window.thistleFlow.ws.dirty));

  // (14) properties: edit operator + marker label, undo
  await page.click('[data-tab=properties]');
  await page.waitForTimeout(200);
  const opInput = page.locator('.prop-table tr:has(th:text-is("Operator")) input');
  await opInput.fill('T. Tagawa'); await opInput.press('Enter'); await opInput.blur();
  await page.waitForTimeout(150);
  const peRow = page.locator('.prop-table.channels tr:has(td:text-is("PE-A")) input').first();
  await peRow.fill('CD4 (edited)'); await peRow.press('Tab');
  await page.waitForTimeout(300);
  check('(14) acquisition keyword edited', await ev(() => window.thistleFlow.ws.activeSample().text['$OP']) === 'T. Tagawa');
  check('(14) marker label edit flows to plots', await ev(() => window.thistleFlow.ws.channelLabel('PE-A')) === 'CD4 (edited) :: PE-A');
  await page.screenshot({ path: OUT + '/e-props.png' });
  await page.click('#btnUndo'); await page.waitForTimeout(150);
  check('(11/14) properties undo', await ev(() => window.thistleFlow.ws.channelLabel('PE-A')) === 'CD4 :: PE-A');

  // (6) template: save, open new tab, load demo, apply
  await page.click('[data-tab=gating]');
  await page.click('#btnSaveTpl');
  const [tplDl] = await Promise.all([page.waitForEvent('download'), page.click('#modalBody button.primary')]);
  await tplDl.saveAs(`${OUT}/tpl.json`);
  const tpl = JSON.parse(fs.readFileSync(`${OUT}/tpl.json`, 'utf8'));
  check('(6) template has no sample data or file names', tpl.kind === 'template' && !JSON.stringify(tpl).includes('.fcs') && tpl.gates.length === nG);

  // (5) new tab
  await page.click('.ws-add');
  check('(5) + opens a new workspace tab', await ev(() => window.thistleFlow.workspaces.length) === 2);
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btnApplyTpl')]);
  await chooser.setFiles(`${OUT}/tpl.json`);
  await page.waitForTimeout(500);
  check('(6) template applied to new samples', await ev(() => window.thistleFlow.ws.engine.list().length) === nG);
  await page.screenshot({ path: OUT + '/e-tabs.png' });
  // close tab -> asked to save
  await page.locator('.ws-tab.active button[title="Close workspace"]').click();
  await page.waitForTimeout(150);
  const askTitle = await page.textContent('#modalTitle');
  check('(5) closing a tab asks to save', askTitle === 'Close workspace' && !(await page.isHidden('#modal')));
  await page.click('#modalBody button:has-text("Don’t save")');
  await page.waitForTimeout(150);
  check('(5) tab closed after choosing', await ev(() => window.thistleFlow.workspaces.length) === 1);

  // (4) panes resizable
  const sw0 = await ev(() => document.getElementById('sidebar').offsetWidth);
  const sp = await page.locator('#mainSplit').boundingBox();
  await page.mouse.move(sp.x + 2, sp.y + 300); await page.mouse.down(); await page.mouse.move(sp.x + 152, sp.y + 300, { steps: 5 }); await page.mouse.up();
  const sw1 = await ev(() => document.getElementById('sidebar').offsetWidth);
  check('(4) left/right pane resizable', Math.abs(sw1 - sw0 - 150) < 4, `${sw0} -> ${sw1}`);
  const hs = await page.locator('#sideSplit').boundingBox();
  const sh0 = await ev(() => document.getElementById('secSamples').offsetHeight);
  await page.mouse.move(hs.x + 50, hs.y + 2); await page.mouse.down(); await page.mouse.move(hs.x + 50, hs.y + 102, { steps: 5 }); await page.mouse.up();
  const sh1 = await ev(() => document.getElementById('secSamples').offsetHeight);
  check('(4) samples/gates panes resizable', Math.abs(sh1 - sh0 - 100) < 4, `${sh0} -> ${sh1}`);

  // (10) dark mode
  await page.click('#btnTheme'); await page.waitForTimeout(300);
  check('(10) dark mode toggle', await ev(() => document.documentElement.dataset.theme) === 'dark');
  await page.screenshot({ path: OUT + '/e-dark.png' });
  await page.click('[data-tab=layout]'); await page.waitForTimeout(200);
  await page.screenshot({ path: OUT + '/e-dark-layout.png' });
  await page.click('#btnTheme');

  // (13) help
  const href = await page.getAttribute('#helpLink', 'href');
  const resp = await page.request.get(BASE + '/' + href);
  check('(13) Help link opens the manual', resp.ok() && (await resp.text()).includes('Thistle'), href);

  // reload workspace into fresh page
  await page.reload(); await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  await page.setInputFiles('#wsInput', `${OUT}/ws.json`); await page.waitForTimeout(400);
  const re = await ev(() => ({ g: window.thistleFlow.ws.engine.list().length, f: window.thistleFlow.ws.figures.length, lp: window.thistleFlow.ws.engine.list()[0]?.labelPos, op: window.thistleFlow.ws.activeSample().text['$OP'] }));
  check('workspace round trip (gates, figures, label position)', re.g === nG && re.f === 1 && !!re.lp, JSON.stringify(re));

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  — ' + r.extra : ''}`);
  assert.deepEqual(errors, [], 'no page errors');
  const failed = results.filter(r => !r.ok).map(r => `${r.name} (${r.extra})`);
  assert.deepEqual(failed, [], 'all checks pass');
});

test('single-file build opens from disk and runs', { timeout: 120000 }, async () => {
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [path.join(ROOT, 'tools/build.mjs')], { stdio: 'ignore' });
  browser = browser || await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('file://' + path.join(ROOT, 'dist/thistle-flow.html'));
  await page.click('#btnDemo');
  await page.waitForSelector('.plot-card canvas');
  assert.equal(await page.evaluate(() => window.thistleFlow.ws.samples.length), 3);
  assert.match(await page.getAttribute('#helpLink', 'href'), /^https:\/\/actinomycetes\.github\.io\/thistle-flow\/help\.html$/);
  assert.deepEqual(errors, []);
  await page.close();
});
