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
const OUT = process.env.TF_E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'thistle-flow-e2e-'));
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
  const defaults = await ev(() => window.thistleFlow.ws.plots.map(p => `${p.x}/${p.y}`));
  check('default plots: FSC-A/SSC-A, FSC-A/FSC-H (singlets), Time/SSC-A', JSON.stringify(defaults) === JSON.stringify(['FSC-A/SSC-A', 'FSC-A/FSC-H', 'Time/SSC-A']), defaults.join(', '));
  // the rest of this test uses scatter, two fluorescence channels and a histogram
  await ev(() => { const ws = window.thistleFlow.ws; ws.plots[1].x = 'FITC-A'; ws.plots[1].y = 'PE-A'; ws.plots[2].x = 'FITC-A'; ws.plots[2].y = null; window.thistleFlow.renderAll(); });
  await page.waitForTimeout(200);

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
  const titles = await ev(() => [...window.thistleFlow.views.values()].map(v => v.spec.title + (v.spec.titleTail || "")));
  const shown = titles.map(t => (/showing ([\d,]+)/.exec(t) || [])[1]).filter(Boolean).map(s => +s.replace(/,/g, ''));
  check('(2) workspace event limit thins 2-D plots', shown.length >= 2 && shown.every(n => n === 1000), titles.join(' | '));
  await page.locator('.plot-card').nth(0).locator('button[title^="Plot settings"]').click();
  await page.locator('.popover select').nth(1).selectOption('0');
  await page.waitForTimeout(200);
  const t0 = await ev(() => [...window.thistleFlow.views.values()][0].spec.titleTail);
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
  const menuTitle = await page.textContent('.popover .pop-title').catch(() => '');
  check('(8b) clicking an axis opens a quick menu for that axis only', menuTitle.startsWith('Y axis') && (await page.isHidden('#modal')), menuTitle);
  const yCh = await ev(() => window.thistleFlow.ws.plots[1].y);
  check('(8b) quick menu shows the channel of that axis', (await page.locator('.popover select').first().inputValue()) === yCh);
  await page.click('.popover .seg button:has-text("Arcsinh")');
  await page.waitForTimeout(150);
  check('(8b) Y axis scale changed independently', await page.evaluate(ch => window.thistleFlow.ws.transforms[ch].kind === 'arcsinh' && window.thistleFlow.ws.transforms[window.thistleFlow.ws.plots[1].x].kind !== 'arcsinh', yCh));
  // switching the channel of this axis from the quick menu changes only this plot
  await page.locator('.popover select').first().selectOption('APC-A');
  await page.waitForTimeout(150);
  check('(8b) quick menu changes the channel of this plot only', await ev(() => window.thistleFlow.ws.plots[1].y === 'APC-A' && window.thistleFlow.ws.plots[0].y === 'SSC-A'));
  await page.locator('.popover select').first().selectOption('PE-A');
  await page.keyboard.press('Escape');

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
  await wsDl.saveAs(`${OUT}/ws.zip`);
  check('(12) saved with the chosen name (zip with FCS files by default)', /^MyExperiment_.*\.zip$/.test(wsDl.suggestedFilename()), wsDl.suggestedFilename());
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
  const theme0 = await ev(() => document.documentElement.dataset.theme);
  check('dark is the default theme (as in Thistle Plot)', theme0 === 'dark' && (await page.textContent('#btnTheme')) === '🌙');
  check('BETA and version badges', (await page.textContent('#app-version')) === 'v' + (await ev(() => window.thistleFlow.version)) && (await page.textContent('.badge-hdr.beta')) === 'BETA');
  await page.click('#btnTheme'); await page.waitForTimeout(300);
  check('(10) theme toggle switches to light', await ev(() => document.documentElement.dataset.theme) === 'light' && (await page.textContent('#btnTheme')) === '☀️');
  await page.screenshot({ path: OUT + '/e-light.png' });
  await page.click('#btnTheme'); await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + '/e-dark.png' });
  await page.click('[data-tab=layout]'); await page.waitForTimeout(200);
  await page.screenshot({ path: OUT + '/e-dark-layout.png' });

  // (13) help
  const href = await page.getAttribute('#helpLink', 'href');
  const resp = await page.request.get(BASE + '/' + href);
  check('(13) Help link opens the manual', resp.ok() && (await resp.text()).includes('Thistle'), href);

  // (L1) Layout: one range gate on a histogram overlay sets the gate for all samples; labels movable
  await page.click('[data-tab=layout]');
  await ev(() => {
    const ws = window.thistleFlow.ws; const g = ws.engine.list().find(x => x.name === 'Lymphocytes');
    ws.figures.push(
      { id: 'fo', kind: 'overlay-hist', x: 'PE-Cy7-A', y: null, pop: g.id, title: '', mode: 'mode', offset: 0.5, smooth: true, fill: true, w: 460, h: 360,
        series: ws.samples.map((s, i) => ({ sampleId: s.id, pop: g.id, color: ['#d62728', '#1f77b4', '#2ca02c'][i] })) },
      { id: 'fb', kind: 'batch', x: 'FSC-A', y: 'SSC-A', pop: null, plotKind: 'pseudo', w: 230, h: 220, title: '' });
    window.thistleFlow.renderAll();
  });
  const gatingLabelBefore = await ev(() => JSON.stringify(window.thistleFlow.ws.engine.list().find(x => x.name === 'Lymphocytes').labelPos || null));
  const ofig = page.locator('.figure-card[data-fig=fo]');
  await ofig.locator('button:has-text("Range gate")').click();
  let oc = await ofig.locator('canvas').boundingBox();
  const PO = (ux, uy) => [oc.x + 64 + ux * (oc.width - 78), oc.y + 24 + (1 - uy) * (oc.height - 72)];
  prompts.push('CD69+');
  { const [x, y] = PO(0.6, 0.92); await page.mouse.move(x, y); await page.mouse.down(); const [x2] = PO(0.99, 0.92); await page.mouse.move(x2, y, { steps: 6 }); await page.mouse.up(); }
  await page.waitForTimeout(400);
  const rg = await ev(() => {
    const ws = window.thistleFlow.ws; const g = ws.engine.list().find(x => x.name === 'CD69+');
    return g && { parent: ws.engine.get(g.parent)?.name, type: g.type, pcts: ws.samples.map(s => ws.engine.population(s, g.id).count / ws.engine.population(s, g.parent).count), drawing: window.thistleFlow.figDrawing };
  });
  check('(L1) Range gate drawn on overlay creates one gate for all samples', rg && rg.type === 'interval' && rg.parent === 'Lymphocytes' && rg.drawing === null, JSON.stringify(rg));
  check('(L1) each sample gets its own % (activation increases)', rg && rg.pcts[0] < rg.pcts[1] && rg.pcts[1] < rg.pcts[2], JSON.stringify(rg?.pcts));
  const lines = await page.evaluate(() => document.querySelector('.figure-card[data-fig=fo] canvas')._figView.spec.gates.find(i => i.gate.name === 'CD69+').lines.map(l => l.text));
  check('(L1) overlay label lists every sample', lines.length === 4, lines.join(' | '));
  await ofig.screenshot({ path: OUT + '/e-overlay-gate.png' });
  // drag the overlay label
  const ob = await page.evaluate(() => document.querySelector('.figure-card[data-fig=fo] canvas')._figView.spec.gates.find(i => i.gate.name === 'CD69+').labelBox);
  oc = await ofig.locator('canvas').boundingBox();
  await page.mouse.move(oc.x + ob.cx, oc.y + ob.cy); await page.mouse.down(); await page.mouse.move(oc.x + ob.cx - 150, oc.y + ob.cy + 40, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(200);
  const lp = await ev(() => { const ws = window.thistleFlow.ws; const g = ws.engine.list().find(x => x.name === 'CD69+'); return { fig: ws.figures.find(f => f.id === 'fo').labelPos?.[g.id], gate: g.labelPos || null }; });
  check('(i) overlay labels movable, kept per figure', lp.fig && lp.gate === null, JSON.stringify(lp));
  // drag a gate end in the overlay
  const ge = await page.evaluate(() => { const v = document.querySelector('.figure-card[data-fig=fo] canvas')._figView; const it = v.spec.gates.find(i => i.gate.name === 'CD69+'); return { x0: it.gate.x0 }; });
  { const [x, y] = PO(0.6, 0.92); await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 30, y, { steps: 4 }); await page.mouse.up(); }
  await page.waitForTimeout(200);
  check('(L1) gate end adjustable in the overlay', await ev(() => window.thistleFlow.ws.engine.list().find(x => x.name === 'CD69+').x0) < ge.x0);
  // batch figure: move a label in one plot -> all plots of the figure follow
  const bcan = page.locator('.figure-card[data-fig=fb] canvas');
  await bcan.first().scrollIntoViewIfNeeded();
  const bb = await bcan.first().boundingBox();
  const blb = await page.evaluate(() => document.querySelector('.figure-card[data-fig=fb] canvas')._figView.spec.gates[0].labelBox);
  // move the label to the vertical middle of the plot (always room there, wherever it starts)
  const midY = 24 + (220 - 72) / 2;
  await page.mouse.move(bb.x + blb.cx, bb.y + blb.cy); await page.mouse.down(); await page.mouse.move(bb.x + blb.cx - 40, bb.y + midY, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const bx = await page.evaluate(() => [...document.querySelectorAll('.figure-card[data-fig=fb] canvas')].map(c => Math.round(c._figView.spec.gates[0].labelBox.cy)));
  check('(i) batch labels movable (same place in every sample plot)', bx.every(v => v === bx[0]) && Math.abs(bx[0] - midY) < 3, `${blb.cy} -> ${bx.join(',')}`);
  check('(i) Gating label position not changed by Layout', await ev(() => JSON.stringify(window.thistleFlow.ws.engine.list().find(x => x.name === 'Lymphocytes').labelPos || null)) === gatingLabelBefore);
  await page.locator('.figure-card[data-fig=fb]').screenshot({ path: OUT + '/e-batch.png' });
  await page.click('#btnUndo'); await page.waitForTimeout(150);
  check('(i) Layout undo restores the label position', await ev(() => !window.thistleFlow.ws.figures.find(f => f.id === 'fb').labelPos));

  // dot size option (pseudocolor draws dots, sized per plot)
  await page.click('[data-tab=gating]');
  await page.locator('.plot-card').nth(0).locator('button[title^="Plot settings"]').click();
  await page.locator('.popover label:has-text("Dot size") select').selectOption('3');
  await page.keyboard.press('Escape');
  check('dot size per plot', await ev(() => window.thistleFlow.ws.plots[0].dotSize === 3 && [...window.thistleFlow.views.values()][0].spec.dotSize === 3));
  // Clear: remove samples but keep gates and plots
  const nGatesBefore = await ev(() => window.thistleFlow.ws.engine.list().length);
  await page.click('#btnClear');
  await page.click('#modalBody button:has-text("keep gates")');
  await page.waitForTimeout(200);
  check('🗑 Clear removes all samples and keeps gates/plots', await page.evaluate(n => window.thistleFlow.ws.samples.length === 0 && window.thistleFlow.ws.engine.list().length === n && window.thistleFlow.ws.plots.length > 0, nGatesBefore));
  await page.click('#btnClear'); // nothing left: just a message, no dialog
  check('Clear with no samples shows no dialog', await page.isHidden('#modal'));

  // reload workspace into fresh page
  await page.reload(); await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  await page.setInputFiles('#wsInput', `${OUT}/ws.zip`); await page.waitForFunction(() => window.thistleFlow.workspaces.length === 2 && window.thistleFlow.ws.samples.length === 3, null, { timeout: 30000 });
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
  // the help panel shows the built-in manual (works offline)
  await page.click('#helpLink');
  await page.frameLocator('#helpFrame').locator('h1:has-text("Help and manual")').waitFor();
  assert.ok(await page.getAttribute('#helpFrame', 'srcdoc'));
  await page.frameLocator('#helpFrame').locator('#backToApp').click();
  await page.waitForSelector('#helpOv', { state: 'hidden', timeout: 5000 });
  assert.equal(await page.evaluate(() => window.thistleFlow.ws.samples.length), 3);
  assert.deepEqual(errors, []);
  await page.close();
});

test('overlay range-gate button, sample labels, workspace bundles and locating FCS files', { timeout: 240000 }, async () => {
  const { demoFiles } = await import('../../js/demo.js');
  const fcsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-fcs-'));
  for (const f of demoFiles()) fs.writeFileSync(path.join(fcsDir, f.name), Buffer.from(f.buffer));
  browser = browser || await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} window.showSaveFilePicker = undefined; });
  const prompts = [];
  page.on('dialog', d => d.accept(prompts.shift()));
  const ev = f => page.evaluate(f);
  await page.goto(BASE + '/');
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  await ev(() => {
    const ws = window.thistleFlow.ws;
    ws.engine.add({ id: 'gS', name: 'Singlets', parent: null, type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 40000, x1: 80000, y0: 8000, y1: 38000, color: '#e6194b' });
    window.thistleFlow.selectGate(null); window.thistleFlow.renderAll();
  });
  await page.click('[data-tab=layout]');
  await page.click('[data-addfig=overlay-hist]');
  const fig = page.locator('.figure-card').first();
  const rangeBtn = fig.locator('button:has-text("Range gate")');
  // series start on All Events; change one series to Singlets -> mixed -> disabled
  await fig.locator('.series-row').nth(0).locator('select').nth(1).selectOption('gS');
  assert.equal(await rangeBtn.isDisabled(), true, 'disabled while series mix populations');
  // set every series to Singlets one by one (the case in the screenshot) -> enabled without re-opening
  for (const i of [1, 2]) await fig.locator('.series-row').nth(i).locator('select').nth(1).selectOption('gS');
  assert.equal(await rangeBtn.isDisabled(), false, 'enabled once all series share Singlets');
  assert.match(await fig.textContent(), /gate goes under Singlets/);

  // sample labels: half offset -> one label per band; drag one; outside; off
  await fig.locator('label:has-text("Offset") select').selectOption('0.5');
  const view = () => page.evaluate(() => document.querySelector('.figure-card canvas')._figView);
  const box = await page.evaluate(() => document.querySelector('.figure-card canvas')._figView.spec._labelBoxes[0]);
  const cb = await fig.locator('canvas').boundingBox();
  await page.mouse.move(cb.x + box.cx, cb.y + box.cy); await page.mouse.down();
  await page.mouse.move(cb.x + box.cx - 120, cb.y + box.cy - 30, { steps: 6 }); await page.mouse.up();
  const moved = await ev(() => window.thistleFlow.ws.figures[0].series[0].labelPos);
  assert.ok(moved, 'sample label dragged');
  const pwInside = await page.evaluate(() => document.querySelector('.figure-card canvas')._figView.L.pw);
  await fig.locator('label:has-text("Labels") select').selectOption('outside');
  const out = await page.evaluate(() => { const v = document.querySelector('.figure-card canvas')._figView; return { pw: v.L.pw, right: Math.min(...v.spec._labelBoxes.map(b => b.x)) }; });
  assert.ok(out.pw < pwInside - 40 && out.right > 64 + out.pw, `labels outside the plot: ${JSON.stringify(out)} vs ${pwInside}`);
  await fig.screenshot({ path: OUT + '/e-labels-outside.png' });
  await fig.locator('label:has-text("Labels") select').selectOption('off');
  assert.equal(await page.evaluate(() => document.querySelector('.figure-card canvas')._figView.spec._labelBoxes.length), 0, 'labels off');
  await fig.locator('label:has-text("Labels") select').selectOption('inside');
  await fig.locator('button:has-text("Reset label positions")').click();
  assert.equal(await ev(() => window.thistleFlow.ws.figures[0].series[0].labelPos), undefined, 'reset label positions');
  await fig.locator('label:has-text("Gate labels") input').uncheck();
  assert.equal(await ev(() => window.thistleFlow.ws.figures[0].gateLabels), false);

  // save as a bundle (zip with FCS files) and reopen it in a fresh page
  await page.click('#btnSaveWs');
  assert.equal(await page.isChecked('#modalBody input[type=checkbox]'), true, 'FCS files included by default');
  assert.equal((await page.textContent('#modalBody .row .hint')).trim(), '.zip');
  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.click('#modalBody button.primary')]);
  const zipPath = path.join(OUT, 'bundle.zip'); await zipDl.saveAs(zipPath);
  assert.match(zipDl.suggestedFilename(), /\.zip$/);
  // ...and as plain JSON
  await page.click('#btnSaveWs');
  await page.uncheck('#modalBody input[type=checkbox]');
  assert.equal((await page.textContent('#modalBody .row .hint')).trim(), '.json');
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.click('#modalBody button.primary')]);
  const jsonPath = path.join(OUT, 'plain.json'); await jsonDl.saveAs(jsonPath);

  await page.reload();
  await page.setInputFiles('#wsInput', zipPath);
  await page.waitForFunction(() => window.thistleFlow.ws.samples.length === 3, null, { timeout: 30000 });
  const re = await ev(() => { const ws = window.thistleFlow.ws; return { gates: ws.engine.list().map(g => g.name), figs: ws.figures.length, series: ws.figures[0]?.series.length, counts: ws.samples.map(s => ws.engine.population(s, 'gS').count) }; });
  assert.deepEqual(re.gates, ['Singlets']);
  assert.equal(re.figs, 1); assert.equal(re.series, 3);
  assert.ok(re.counts.every(c => c > 1000), 'gate applies to the reopened samples');

  // JSON without data: dialog to find the files; choose the files -> matched by name
  await page.reload();
  await page.setInputFiles('#wsInput', jsonPath);
  await page.waitForSelector('#modal:not([hidden])');
  assert.match(await page.textContent('#modalTitle'), /Find the FCS files/);
  assert.equal(await page.locator('#modalBody table tr').count(), 4, 'three missing samples listed');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#modalBody button:has-text("Choose files")')]);
  await chooser.setFiles(fs.readdirSync(fcsDir).map(f => path.join(fcsDir, f)));
  await page.waitForFunction(() => window.thistleFlow.ws.samples.length === 3, null, { timeout: 30000 });
  await page.waitForSelector('#modal', { state: 'hidden' });
  assert.equal(await ev(() => window.thistleFlow.ws.figures[0]?.series.length), 3, 'figures re-linked to the found samples');

  // replace a sample's file: keeps gates, swaps data
  const before = await ev(() => window.thistleFlow.ws.samples[0].name);
  const [ch2] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.sample-list li').first().locator('button[title^="Replace"]').click()]);
  await ch2.setFiles(path.join(fcsDir, 'Stim_24h.fcs'));
  await page.waitForFunction(b => window.thistleFlow.ws.samples[0].name !== b, before);
  const rep = await ev(() => { const ws = window.thistleFlow.ws; return { name: ws.samples[0].name, n: ws.samples.length, gates: ws.engine.list().length, series0: ws.figures[0].series[0].sampleId === ws.samples[0].id }; });
  assert.deepEqual(rep, { name: 'Stim_24h.fcs', n: 3, gates: 1, series0: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('quick overlay of several samples in Gating; one population for all series in Layout', { timeout: 180000 }, async () => {
  browser = browser || await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  const ev = f => page.evaluate(f);
  await page.goto(BASE + '/');
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  await ev(() => {
    const ws = window.thistleFlow.ws;
    ws.engine.add({ id: 'gS', name: 'Singlets', parent: null, type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 40000, x1: 80000, y0: 8000, y1: 38000, color: '#e6194b' });
    ws.plots[2].x = 'PE-Cy7-A'; ws.plots[2].y = null; ws.plots[2].pop = 'gS';
    window.thistleFlow.renderAll();
  });
  const items = page.locator('.sample-list li');
  const specs = () => page.evaluate(() => [...window.thistleFlow.views.values()].map(v => ({ n: v.spec.series.length, kind: v.spec.kind, title: v.spec.title, lines: v.spec.gates[0]?.lines?.length || 0 })));
  // Ctrl/⌘-click adds a sample to the overlay
  await items.nth(0).click();
  await items.nth(2).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  let sp = await specs();
  assert.deepEqual(sp.map(x => x.n), [2, 2, 2], 'two samples overlaid in every plot');
  assert.equal(sp[0].kind, 'dot'); assert.equal(sp[2].kind, 'histogram');
  assert.match(sp[0].title, /Overlay of 2 samples/);
  assert.equal(sp[0].lines, 3, 'gate label lists each overlaid sample');
  assert.equal(await page.locator('.sample-list li.in-overlay').count(), 2);
  assert.match(await page.textContent('#activeSampleInfo'), /Overlay of 2 samples/);
  await page.locator('.plot-card').nth(2).screenshot({ path: OUT + '/e-quick-overlay-hist.png' });
  await page.locator('.plot-card').nth(0).screenshot({ path: OUT + '/e-quick-overlay-dots.png' });
  // Shift-click selects a range from the active sample
  await items.nth(1).click(); await items.nth(2).click({ modifiers: ['Shift'] });
  assert.deepEqual((await specs()).map(x => x.n), [2, 2, 2]);
  await items.nth(0).click({ modifiers: ['Shift'] });
  assert.deepEqual((await specs()).map(x => x.n), [2, 2, 2], 'range 0..1 from the active sample');
  await page.click('#activeSampleInfo button:has-text("Show one sample")');
  assert.deepEqual((await specs()).map(x => x.n), [1, 1, 1], 'back to a single sample');
  await items.nth(0).click(); await items.nth(1).click({ modifiers: ['Shift'] }); await items.nth(2).click();
  assert.deepEqual((await specs()).map(x => x.n), [1, 1, 1], 'a plain click shows one sample');

  // Layout: Population menu sets every series at once
  await page.click('[data-tab=layout]');
  await page.click('[data-addfig=overlay-hist]');
  const fig = page.locator('.figure-card').first();
  const allPop = fig.locator('label:has-text("Population") select').first();
  await allPop.selectOption('gS');
  assert.deepEqual(await ev(() => window.thistleFlow.ws.figures[0].series.map(se => se.pop)), ['gS', 'gS', 'gS']);
  assert.equal(await fig.locator('button:has-text("Range gate")').isDisabled(), false);
  await fig.locator('.series-row').nth(1).locator('select').nth(1).selectOption('');
  assert.equal(await allPop.inputValue(), '__mixed', 'shows that the series differ');
  await allPop.selectOption('');
  assert.deepEqual(await ev(() => window.thistleFlow.ws.figures[0].series.map(se => se.pop)), [null, null, null]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('README describes the functionality without naming other software', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(!/flowjo/i.test(readme));
  assert.match(readme, /Part of the Thistle suite/);
});

test('reorder samples by dragging the handle; quadrants labelled Q1-Q4 in Gating plots', { timeout: 120000 }, async () => {
  browser = browser || await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  const ev = f => page.evaluate(f);
  await page.goto(BASE + '/');
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  const order = () => ev(() => window.thistleFlow.ws.samples.map(s => s.name));
  assert.deepEqual(await order(), ['Unstimulated.fcs', 'Stim_6h.fcs', 'Stim_24h.fcs']);
  const drag = async (fromIdx, toY) => {
    const hb = await page.locator('.sample-list .drag-handle').nth(fromIdx).boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, toY, { steps: 8 }); await page.mouse.up();
  };
  // last sample to the top
  const first = await page.locator('.sample-list li').nth(0).boundingBox();
  await drag(2, first.y + 4);
  assert.deepEqual(await order(), ['Stim_24h.fcs', 'Unstimulated.fcs', 'Stim_6h.fcs']);
  assert.equal(await page.locator('.sample-list li .name').first().textContent(), 'Stim_24h.fcs');
  // first sample to the bottom
  const last = await page.locator('.sample-list li').nth(2).boundingBox();
  await drag(0, last.y + last.height - 3);
  assert.deepEqual(await order(), ['Unstimulated.fcs', 'Stim_6h.fcs', 'Stim_24h.fcs']);
  // clicking the handle does not change the active sample
  const active = await ev(() => window.thistleFlow.ws.activeId);
  await page.locator('.sample-list .drag-handle').nth(1).click();
  assert.equal(await ev(() => window.thistleFlow.ws.activeId), active);
  // the statistics follow the new order
  await drag(2, first.y + 4);
  await page.click('[data-tab=stats]');
  assert.equal(await page.locator('#statsTable tbody tr td').first().textContent(), 'Stim_24h.fcs');

  // quadrant gate: plots show Q1-Q4 with %, the gate tree keeps the full names
  await page.click('[data-tab=gating]');
  await ev(() => { const ws = window.thistleFlow.ws; ws.plots[1].x = 'PE-A'; ws.plots[1].y = 'APC-A'; window.thistleFlow.renderAll(); });
  const b = await page.locator('.plot-card canvas').nth(1).boundingBox();
  await page.click('[data-tool=quad]');
  await page.mouse.click(b.x + 64 + 0.55 * (b.width - 78), b.y + 24 + 0.45 * (b.height - 72));
  const texts = await ev(() => [...window.thistleFlow.views.values()][1].spec.gates.map(g => g.text.split('  ')[0]).sort());
  assert.deepEqual(texts, ['Q1', 'Q2', 'Q3', 'Q4']);
  const tree = await page.locator('.gate-tree .gname').allTextContents();
  assert.ok(tree.includes('Q1 · CD4- CD8+') && tree.includes('Q2 · CD4+ CD8+'), tree.join(' | '));
  await page.locator('.plot-card').nth(1).screenshot({ path: OUT + '/e-quad-labels.png' });
  await page.locator('.sample-list').screenshot({ path: OUT + '/e-sample-handles.png' });
  assert.deepEqual(errors, []);
  await page.close();
});

test('per-sample gates (adjust, indicators, back to global); Layout keep ratio', { timeout: 180000 }, async () => {
  browser = browser || await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  page.on('dialog', d => d.accept());
  const ev = f => page.evaluate(f);
  await page.goto(BASE + '/');
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  await ev(() => {
    const ws = window.thistleFlow.ws;
    ws.engine.add({ id: 'gL', name: 'Lymph', parent: null, type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 40000, x1: 80000, y0: 8000, y1: 38000, color: '#e6194b' });
    window.thistleFlow.renderAll();
  });
  const counts = () => ev(() => window.thistleFlow.ws.samples.map(s => window.thistleFlow.ws.engine.population(s, 'gL').count));
  const before = await counts();
  // "This sample" mode, then drag the right edge of the gate for the active (first) sample
  await page.click('#gateEditMode button[data-mode=sample]');
  const b = await page.locator('.plot-card canvas').nth(0).boundingBox();
  const P = (ux, uy) => [b.x + 64 + ux * (b.width - 78), b.y + 24 + (1 - uy) * (b.height - 72)];
  const ux1 = 80000 / 262144, uy0 = 8000 / 262144;
  { const [x, y] = P(ux1, uy0); await page.mouse.move(x, y); await page.mouse.down(); const [x2] = P(0.22, uy0); await page.mouse.move(x2, y, { steps: 6 }); await page.mouse.up(); }
  await page.waitForTimeout(200);
  const after = await counts();
  assert.ok(after[0] < before[0] * 0.9, `active sample uses its adjusted gate: ${before[0]} -> ${after[0]}`);
  assert.deepEqual(after.slice(1), before.slice(1), 'other samples unchanged');
  assert.equal(await ev(() => window.thistleFlow.ws.engine.get('gL').x1), 80000, 'global gate unchanged');
  // indicators: dashed + ✎ on the plot label, ✎1 in the gate tree, badge on the sample
  const item = await ev(() => { const it = [...window.thistleFlow.views.values()][0].spec.gates[0]; return { custom: it.custom, text: it.text }; });
  assert.ok(item.custom && item.text.includes('✎'), JSON.stringify(item));
  assert.equal(await page.locator('.gate-tree .custom-mark').textContent(), '✎1');
  assert.equal(await page.locator('.sample-list li').nth(0).locator('.badge.custom').count(), 1);
  assert.equal(await page.locator('.sample-list li').nth(1).locator('.badge.custom').count(), 0);
  await page.locator('.plot-card').nth(0).screenshot({ path: OUT + '/e-custom-gate.png' });
  // another sample shows the global gate
  await page.locator('.sample-list li').nth(1).click();
  assert.equal(await ev(() => [...window.thistleFlow.views.values()][0].spec.gates[0].custom), false);
  // back to the global gate
  await page.locator('.sample-list li').nth(0).click();
  await page.locator('.gate-tree .node:has-text("Lymph")').click();
  assert.equal(await page.isDisabled('#btnGlobalGate'), false);
  await page.click('#btnGlobalGate');
  await page.waitForTimeout(150);
  assert.deepEqual(await counts(), before, 'back to the global gate');
  assert.equal(await page.locator('.gate-tree .custom-mark').count(), 0);
  assert.equal(await page.isDisabled('#btnGlobalGate'), true);
  // "All samples" mode edits the global gate again
  await page.click('#gateEditMode button[data-mode=all]');
  { const [x, y] = P(ux1, uy0); await page.mouse.move(x, y); await page.mouse.down(); const [x2] = P(0.25, uy0); await page.mouse.move(x2, y, { steps: 6 }); await page.mouse.up(); }
  await page.waitForTimeout(150);
  assert.ok(await ev(() => window.thistleFlow.ws.engine.get('gL').x1 < 80000 && !window.thistleFlow.ws.engine.get('gL').overrides));

  // Layout: keep ratio (on by default)
  await page.click('[data-tab=layout]');
  await page.click('[data-addfig=overlay-hist]');
  const fig = page.locator('.figure-card').first();
  assert.equal(await fig.locator('label:has-text("Keep ratio") input').isChecked(), true);
  await fig.locator('.wh input[type=number]').first().fill('660'); await fig.locator('.wh input[type=number]').first().press('Tab');
  assert.deepEqual(await ev(() => [window.thistleFlow.ws.figures[0].w, window.thistleFlow.ws.figures[0].h]), [660, 510]);
  assert.equal(await fig.locator('.wh input[type=number]').nth(1).inputValue(), '510');
  await fig.locator('label:has-text("Keep ratio") input').uncheck();
  await fig.locator('.wh input[type=number]').nth(1).fill('300'); await fig.locator('.wh input[type=number]').nth(1).press('Tab');
  assert.deepEqual(await ev(() => [window.thistleFlow.ws.figures[0].w, window.thistleFlow.ws.figures[0].h]), [660, 300]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('drags end even if the browser loses the mouseup (Safari); axis menu beside the plot with Done', { timeout: 120000 }, async () => {
  browser = browser || await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  const ev = f => page.evaluate(f);
  await page.goto(BASE + '/');
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  await ev(() => { const ws = window.thistleFlow.ws; ws.plots[1].x = 'FITC-A'; ws.plots[1].y = 'PE-A'; window.thistleFlow.renderAll(); });

  // axis quick menu opens beside the plot card, not over it
  const card = await page.locator('.plot-card').nth(1).boundingBox();
  const cv = await page.locator('.plot-card canvas').nth(1).boundingBox();
  await page.mouse.click(cv.x + 20, cv.y + 24 + 120);
  const pop = await page.locator('.popover').boundingBox();
  const overlaps = !(pop.x >= card.x + card.width || pop.x + pop.width <= card.x || pop.y >= card.y + card.height || pop.y + pop.height <= card.y);
  assert.ok(!overlaps, `menu ${JSON.stringify(pop)} must not cover the plot ${JSON.stringify(card)}`);

  // the drag that closes the menu: start a selection box on the empty grid, then lose the mouseup
  const grid = await page.locator('#plotGrid').boundingBox();
  await page.mouse.move(grid.x + grid.width - 8, grid.y + grid.height - 8);
  await page.mouse.down();
  await page.mouse.move(grid.x + grid.width / 2, grid.y + grid.height / 2, { steps: 5 });
  assert.equal(await page.locator('.rubber-band').count(), 1, 'selection box while dragging');
  assert.equal(await page.locator('.popover').count(), 0, 'menu closed by the click outside');
  // Safari sometimes never delivers this mouseup: the next move arrives with no button pressed
  await ev(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 300, buttons: 0, bubbles: true })));
  assert.equal(await page.locator('.rubber-band').count(), 0, 'selection box ended');
  const selAfter = await ev(() => [...window.thistleFlow.ws.selPlots].length);
  await page.mouse.move(grid.x + 10, grid.y + 10, { steps: 3 }); // more movement must not keep selecting
  assert.equal(await ev(() => [...window.thistleFlow.ws.selPlots].length), selAfter);
  await page.mouse.up();
  // the same safety net for gate drawing: a rectangle drag that loses its mouseup still finishes
  page.once('dialog', d => d.dismiss());
  await page.click('[data-tool=rect]');
  await page.mouse.move(cv.x + 150, cv.y + 120); await page.mouse.down(); await page.mouse.move(cv.x + 220, cv.y + 200, { steps: 4 });
  await ev(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10, buttons: 0 })));
  await page.mouse.up();
  assert.equal(await ev(() => window.thistleFlow.tool), 'select', 'gate drag finished (back to Select)');

  // Done applies a value that is still being typed and closes the menu
  await page.locator('.plot-card').nth(0).locator('button[title^="Plot settings"]').click();
  await page.click('.popover button:has-text("X axis")');
  await page.locator('.popover input[type=number]').nth(1).fill('200000');
  await page.click('.popover .pop-actions button:has-text("Done")');
  assert.equal(await page.locator('.popover').count(), 0, 'Done closes the menu');
  assert.equal(await ev(() => window.thistleFlow.ws.transforms['FSC-A'].max), 200000, 'typed value applied');
  assert.deepEqual(errors, []);
  await page.close();
});

test('axis quick menu opens next to the click: left for Y, below for X (right near the window bottom)', { timeout: 120000 }, async () => {
  browser = browser || await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await page.goto(BASE + '/');
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  await page.evaluate(() => { const ws = window.thistleFlow.ws; ws.plots[1].x = 'FITC-A'; ws.plots[1].y = 'PE-A'; window.thistleFlow.renderAll(); });
  const open = async (axis, plot = 1) => {
    const cv = await page.locator('.plot-card canvas').nth(plot).boundingBox();
    const pt = axis === 'y' ? [cv.x + 20, cv.y + 24 + 180] : [cv.x + 64 + 120, cv.y + cv.height - 20];
    await page.mouse.click(...pt);
    const pop = await page.locator('.popover').boundingBox();
    const card = await page.locator('.plot-card').nth(plot).boundingBox();
    const side = await page.getAttribute('.popover', 'data-side');
    await page.keyboard.press('Escape');
    return { pt, pop, card, side };
  };
  // Y axis: left of the plot, vertically lined up with the click
  let r = await open('y');
  assert.equal(r.side, 'left');
  assert.ok(r.pop.x + r.pop.width <= r.card.x, 'left of the plot');
  assert.ok(Math.abs(r.pop.y + r.pop.height / 2 - r.pt[1]) < 40, 'level with the click');
  // X axis: below the plot, horizontally lined up with the click
  r = await open('x');
  assert.equal(r.side, 'below');
  assert.ok(r.pop.y >= r.card.y + r.card.height, 'below the plot');
  assert.ok(Math.abs(r.pop.x + r.pop.width / 2 - r.pt[0]) < 40, 'under the click');
  // X axis of a plot at the bottom of the window: to the right instead
  await page.setViewportSize({ width: 1600, height: 680 });
  r = await open('x', 1);
  assert.equal(r.side, 'right', 'no room below');
  assert.ok(r.pop.x >= r.card.x + r.card.width);
  // the menu is easy to spot: accent border and an arrow towards the axis
  await page.mouse.click(r.pt[0], r.pt[1]);
  const style = await page.evaluate(() => { const el = document.querySelector('.popover'); const cs = getComputedStyle(el); return { border: cs.borderTopWidth, arrow: getComputedStyle(el, '::before').display }; });
  assert.deepEqual(style, { border: '2px', arrow: 'block' });
  await page.screenshot({ path: OUT + '/e-menu-x-right.png' });
  assert.deepEqual(errors, []);
  await page.close();
});

test('select-to-zoom with unzoom/reset; split gate; leaving "This sample" asks to apply to all', { timeout: 240000 }, async () => {
  browser = browser || await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  const prompts = [];
  page.on('dialog', d => d.accept(prompts.shift()));
  const ev = f => page.evaluate(f);
  await page.goto(BASE + '/');
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  await ev(() => {
    const ws = window.thistleFlow.ws;
    ws.engine.add({ id: 'gL', name: 'Lymph', parent: null, type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 40000, x1: 80000, y0: 8000, y1: 38000, color: '#e6194b' });
    ws.plots[1].x = 'FITC-A'; ws.plots[1].y = null; ws.plots[1].pop = 'gL';
    window.thistleFlow.renderAll();
  });
  const box = async i => page.locator('.plot-card canvas').nth(i).boundingBox();
  const at = (b, ux, uy) => [b.x + 64 + ux * (b.width - 78), b.y + 24 + (1 - uy) * (b.height - 72)];
  const drag = async (b, from, to) => { await page.mouse.move(...at(b, ...from)); await page.mouse.down(); await page.mouse.move(...at(b, ...to), { steps: 6 }); await page.mouse.up(); };
  const counts = id => page.evaluate(id => window.thistleFlow.ws.samples.map(s => window.thistleFlow.ws.engine.population(s, id).count), id);

  // ---- zoom: drag a box on FSC/SSC; gates and statistics unchanged ----
  const lymphBefore = await counts('gL');
  let b = await box(0);
  await page.click('[data-tool=zoom]');
  await drag(b, [0.1, 0.02], [0.4, 0.2]);
  let z = await ev(() => window.thistleFlow.ws.plots[0].zoom);
  assert.ok(z && Math.abs(z.x[0] - 0.1 * 262144) < 3000 && Math.abs(z.x[1] - 0.4 * 262144) < 3000, JSON.stringify(z));
  assert.ok(z.y[1] < 0.25 * 262144);
  assert.equal(await ev(() => window.thistleFlow.tool), 'zoom', 'Zoom stays on after zooming');
  assert.match(await ev(() => [...window.thistleFlow.views.values()][0].spec.titleTail), /zoomed/);
  assert.deepEqual(await counts('gL'), lymphBefore, 'zoom does not change gates or statistics');
  // the gate is drawn larger: its rectangle now spans most of the frame width
  const gw = await ev(() => { const L = [...window.thistleFlow.views.values()][0].L; return (L.ux2px(80000 / 262144) - L.ux2px(40000 / 262144)) / L.pw; });
  assert.ok(gw > 0.4, `gate width fraction ${gw}`);
  await page.locator('.plot-card').nth(0).screenshot({ path: OUT + '/e-zoomed.png' });
  // zoom again inside (the tool is still on), then Unzoom goes back one step, Reset to the full range
  b = await box(0);
  await drag(b, [0.2, 0.2], [0.6, 0.7]);
  const z2 = await ev(() => window.thistleFlow.ws.plots[0].zoom);
  assert.ok(z2.x[1] - z2.x[0] < z.x[1] - z.x[0], 'zoomed further in');
  await page.locator('.plot-card').nth(0).locator('button[title^="Unzoom"]').click();
  assert.deepEqual(await ev(() => window.thistleFlow.ws.plots[0].zoom), z, 'unzoom returns to the previous view');
  await page.locator('.plot-card').nth(0).locator('button[title^="Reset zoom"]').click();
  assert.equal(await ev(() => window.thistleFlow.ws.plots[0].zoom), undefined, 'reset shows everything');
  assert.equal(await page.locator('.plot-card').nth(0).locator('button[title^="Unzoom"]').count(), 0);
  // histograms zoom along X only
  b = await box(1);
  await page.click('[data-tool=zoom]');
  await drag(b, [0.55, 0.5], [0.9, 0.6]);
  z = await ev(() => window.thistleFlow.ws.plots[1].zoom);
  assert.ok(z.x && !z.y, JSON.stringify(z));
  await page.locator('.plot-card').nth(1).locator('button[title^="Reset zoom"]').click();
  // changing the channel resets the zoom
  await page.click('[data-tool=zoom]'); b = await box(0); await drag(b, [0.1, 0.1], [0.5, 0.5]);
  await page.locator('.plot-card').nth(0).locator('select[title="X axis"]').selectOption('FSC-H');
  assert.equal(await ev(() => window.thistleFlow.ws.plots[0].zoom), undefined);
  await page.locator('.plot-card').nth(0).locator('select[title="X axis"]').selectOption('FSC-A');

  // ---- split gate on the FITC histogram ----
  b = await box(1);
  await page.click('[data-tool=split]');
  await page.mouse.click(...at(b, 0.6, 0.5));
  const split = await ev(() => window.thistleFlow.ws.engine.list().filter(g => g.type === 'split').map(g => ({ id: g.id, name: g.name, side: g.side })));
  assert.deepEqual(split.map(g => [g.name, g.side]), [['CD3-', 'L'], ['CD3+', 'R']]);
  assert.equal(await ev(() => window.thistleFlow.tool), 'select');
  const [cl, cr, cp] = [await counts(split[0].id), await counts(split[1].id), await counts('gL')];
  assert.deepEqual(cl.map((v, i) => v + cr[i]), cp, 'left + right = parent for every sample');
  assert.ok(cr[0] > 0.4 * cp[0], 'CD3+ T cells on the right');
  // drag the line: both sides follow
  const cx0 = await ev(() => window.thistleFlow.ws.engine.list().find(g => g.side === 'R').cx);
  const lineScreen = await ev(() => {
    const v = [...window.thistleFlow.views.values()][1];
    // find the canvas x of the split line by scanning hit tests across the plot
    for (let x = 70; x < v.w - 15; x++) { const h = v.hitTest(x, 150); if (h && h.mode === 'split') return x + 3; }
    return null;
  });
  assert.ok(lineScreen, 'split line found');
  await page.mouse.move(b.x + lineScreen, b.y + 150); await page.mouse.down(); await page.mouse.move(b.x + lineScreen + 40, b.y + 150, { steps: 5 }); await page.mouse.up();
  const after = await ev(() => window.thistleFlow.ws.engine.list().filter(g => g.type === 'split').map(g => g.cx));
  assert.ok(after[0] === after[1] && after[0] > cx0, `both sides moved: ${cx0} -> ${after}`);
  await page.locator('.plot-card').nth(1).screenshot({ path: OUT + '/e-split.png' });

  // ---- "This sample" edits, then "All samples": asks to apply ----
  await page.click('#gateEditMode button[data-mode=sample]');
  b = await box(0);
  const edge = [80000 / 262144, 8000 / 262144];
  await drag(b, edge, [0.22, edge[1]]);
  const own = await counts('gL');
  assert.ok(own[0] < lymphBefore[0] && own[1] === lymphBefore[1], 'adjusted for the active sample only');
  // Cancel: stay in This sample
  await page.click('#gateEditMode button[data-mode=all]');
  assert.equal(await page.textContent('#modalTitle'), 'Apply to all samples?');
  assert.match(await page.textContent('#modalBody'), /Lymph/);
  await page.click('#modalBody button:has-text("Cancel")');
  assert.equal(await ev(() => window.thistleFlow.gateEditMode), 'sample');
  // Apply: the adjusted version becomes the shared gate for every sample
  await page.click('#gateEditMode button[data-mode=all]');
  await page.click('#modalBody button:has-text("Apply to all samples")');
  assert.equal(await ev(() => window.thistleFlow.gateEditMode), 'all');
  const shared = await counts('gL');
  assert.equal(shared[0], own[0]);
  assert.ok(shared[1] < lymphBefore[1], 'other samples now use the adjusted gate');
  assert.equal(await ev(() => !!window.thistleFlow.ws.engine.get('gL').overrides), false, 'no per-sample versions left');
  // Keep: the adjustment stays this sample's own
  await page.click('#gateEditMode button[data-mode=sample]');
  b = await box(0);
  const edge2 = [(await ev(() => window.thistleFlow.ws.engine.get('gL').x1)) / 262144, 8000 / 262144];
  await drag(b, edge2, [0.33, edge2[1]]);
  await page.click('#gateEditMode button[data-mode=all]');
  await page.click('#modalBody button:has-text("Keep for")');
  assert.equal(await ev(() => window.thistleFlow.gateEditMode), 'all');
  assert.equal(await ev(() => Object.keys(window.thistleFlow.ws.engine.get('gL').overrides || {}).length), 1);
  // switching again without new edits does not ask
  await page.click('#gateEditMode button[data-mode=sample]');
  await page.click('#gateEditMode button[data-mode=all]');
  assert.equal(await page.isHidden('#modal'), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('help opens over the app and closing it keeps the data; grouped two-tier gating toolbar', { timeout: 120000 }, async () => {
  browser = browser || await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  const ev = f => page.evaluate(f);
  await page.goto(BASE + '/');
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');

  // toolbar: two rows of named groups, tools still work
  const groups = await page.$$eval('#tab-gating .tb-row', rows => rows.map(r => [...r.querySelectorAll('.tb-label')].map(l => l.textContent)));
  assert.deepEqual(groups, [['Plots', 'Gate edits apply to'], ['Gate']]);
  // Use global gate sits right after the All samples / This sample switch, in the same group
  assert.equal(await page.evaluate(() => document.getElementById('gateEditMode').nextElementSibling.id), 'btnGlobalGate');
  assert.equal(await page.evaluate(() => document.getElementById('btnDeleteGate').closest('.tb-group').getAttribute('aria-label')), 'Gate');
  assert.equal(await page.evaluate(() => document.getElementById('btnAddPlot').closest('.tb-group').getAttribute('aria-label')), 'Plots');
  await page.click('[data-tool=zoom]');
  assert.equal(await ev(() => window.thistleFlow.tool), 'zoom');
  assert.equal(await page.locator('[data-tool=zoom].active').count(), 1);
  await page.keyboard.press('v');
  assert.equal(await page.locator('[data-tool=select].active').count(), 1);
  await page.locator('#tab-gating .toolbar').screenshot({ path: OUT + '/e-toolbar.png' });

  // Help opens as a panel; "Close help" inside it returns with everything in place
  await ev(() => { window.thistleFlow.ws.engine.add({ id: 'gH', name: 'Kept', parent: null, type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 40000, x1: 80000, y0: 8000, y1: 38000, color: '#e6194b' }); window.thistleFlow.renderAll(); });
  await page.click('#helpLink');
  assert.equal(await page.isVisible('#helpOv'), true);
  const frame = page.frameLocator('#helpFrame');
  await frame.locator('h1:has-text("Help and manual")').waitFor();
  assert.equal(await frame.locator('#backToApp').textContent(), '✕ Close help');
  await frame.locator('#backToApp').click();
  await page.waitForSelector('#helpOv', { state: 'hidden', timeout: 5000 }); // closed via a message from the panel
  assert.equal(await ev(() => window.thistleFlow.ws.samples.length), 3, 'samples kept');
  assert.equal(await ev(() => window.thistleFlow.ws.engine.get('gH')?.name), 'Kept', 'analysis kept');
  // F1 and Esc
  await page.keyboard.press('F1');
  assert.equal(await page.isVisible('#helpOv'), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.isHidden('#helpOv'), true);

  // standalone help page reached from the app in the same tab: "Back to the app" goes back in history
  await ev(() => { location.href = 'help.html'; });
  await page.waitForURL(/help\.html$/);
  assert.equal(await page.textContent('#backToApp'), '← Back to the app');
  await page.click('#backToApp');
  await page.waitForURL(u => !/help\.html/.test(String(u)));
  // opened on its own (no app behind it): the button opens the app
  await page.goto(BASE + '/help.html');
  await page.click('#backToApp');
  await page.waitForURL(u => !/help\.html/.test(String(u)));
  assert.equal(await page.isVisible('#btnDemo'), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('gate previews follow the cursor; double-click resets zoom; spider and offset quadrants', { timeout: 240000 }, async () => {
  browser = browser || await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  const ev = f => page.evaluate(f);
  await page.goto(BASE + '/');
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  await ev(() => {
    const ws = window.thistleFlow.ws;
    ws.plots[1].x = 'FITC-A'; ws.plots[1].y = null;
    ws.plots[2].x = 'PE-A'; ws.plots[2].y = 'APC-A';
    window.thistleFlow.renderAll();
  });
  const box = async i => page.locator('.plot-card canvas').nth(i).boundingBox();
  const at = (b, ux, uy) => [b.x + 64 + ux * (b.width - 78), b.y + 24 + (1 - uy) * (b.height - 72)];
  const view = i => `[...window.thistleFlow.views.values()][${i}]`;
  const preview = i => page.evaluate(`(${view(i)}).preview?.type || null`);

  // ---- previews: Quadrant on a 2-D plot, Split and Range on a histogram ----
  let b = await box(2);
  await page.click('[data-tool=quad]');
  await page.mouse.move(...at(b, 0.4, 0.4)); await page.mouse.move(...at(b, 0.45, 0.42));
  assert.equal(await preview(2), 'quad');
  await page.locator('.plot-card').nth(2).screenshot({ path: OUT + '/f-quad-preview.png' });
  await page.mouse.move(b.x + b.width + 200, b.y + 10); // leaving the plot removes it
  assert.equal(await preview(2), null);
  b = await box(1);
  for (const t of ['split', 'interval']) {
    await page.click(`[data-tool=${t}]`);
    await page.mouse.move(...at(b, 0.5, 0.5)); await page.mouse.move(...at(b, 0.55, 0.5));
    assert.equal(await preview(1), t, t + ' preview');
    await page.locator('.plot-card').nth(1).screenshot({ path: OUT + `/f-${t}-preview.png` });
  }
  await page.keyboard.press('v');
  assert.equal(await preview(1), null, 'choosing Select clears the preview');

  // ---- double-click in Zoom mode = Reset zoom ----
  b = await box(0);
  await page.click('[data-tool=zoom]');
  await page.mouse.move(...at(b, 0.1, 0.1)); await page.mouse.down(); await page.mouse.move(...at(b, 0.5, 0.5), { steps: 6 }); await page.mouse.up();
  assert.ok(await ev(() => window.thistleFlow.ws.plots[0].zoom));
  await page.mouse.move(...at(b, 0.3, 0.3)); await page.mouse.down(); await page.mouse.move(...at(b, 0.6, 0.6), { steps: 6 }); await page.mouse.up(); // zoom twice
  assert.equal(await ev(() => window.thistleFlow.ws.plots[0].zoomStack?.length), 2);
  await page.mouse.dblclick(...at(b, 0.5, 0.5));
  assert.equal(await ev(() => window.thistleFlow.ws.plots[0].zoom), undefined, 'double-click resets the zoom');
  assert.equal(await ev(() => window.thistleFlow.tool), 'zoom', 'still zooming');

  // ---- quadrant: standard, then spider and offset ----
  b = await box(2);
  await page.click('[data-tool=quad]');
  await page.mouse.click(...at(b, 0.35, 0.35));
  const ids = await ev(() => window.thistleFlow.ws.engine.list().filter(g => g.type === 'quad').map(g => g.id));
  assert.equal(ids.length, 4);
  const counts = () => page.evaluate(ids => ids.map(id => window.thistleFlow.ws.engine.population(window.thistleFlow.ws.activeSample(), id).count), ids);
  const total = await ev(() => window.thistleFlow.ws.activeSample().events);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const std = await counts();
  assert.equal(sum(std), total);
  assert.equal(await page.isVisible('#quadStyle'), true, 'style switch shown for a selected quadrant');
  await page.click('#quadStyle [data-qmode=spider]');
  assert.equal(await ev(() => window.thistleFlow.ws.engine.list().filter(g => g.type === 'quad').every(g => g.quadMode === 'spider')), true, 'whole group');
  assert.deepEqual(await counts(), std, 'spider starts as the straight cross');
  const findArm = arm => page.evaluate(([v, arm]) => {
    const pv = eval(v);
    for (let y = 20; y < pv.h - 40; y += 2) for (let x = 60; x < pv.w - 10; x += 2) { const h = pv.hitTest(x, y); if (h?.mode === 'arm' && h.arm === arm) return [x, y]; }
    return null;
  }, [view(2), arm]);
  b = await box(2); // the style switch can make the toolbar wrap on narrow windows: measure again
  let hnd = await findArm('right');
  assert.ok(hnd, 'right-arm handle found');
  await page.mouse.move(b.x + hnd[0], b.y + hnd[1]); await page.mouse.down();
  await page.mouse.move(b.x + hnd[0], b.y + hnd[1] - 60, { steps: 6 }); await page.mouse.up(); // turn the right arm upwards
  const ang = await ev(() => window.thistleFlow.ws.engine.list().find(g => g.type === 'quad').angles.right);
  assert.ok(ang > 10 && ang < 85, 'right arm turned anticlockwise: ' + ang);
  const sp = await counts();
  assert.equal(sum(sp), total, 'spider quadrants still cover every event once');
  assert.notDeepEqual(sp, std);
  await page.locator('.plot-card').nth(2).screenshot({ path: OUT + '/f-spider.png' });

  await page.click('#quadStyle [data-qmode=offset]');
  assert.deepEqual(await counts(), std, 'offset starts as the straight cross');
  b = await box(2);
  hnd = await findArm('up');
  assert.ok(hnd, 'up-arm handle found');
  await page.mouse.move(b.x + hnd[0], b.y + hnd[1]); await page.mouse.down();
  await page.mouse.move(b.x + hnd[0] - 50, b.y + hnd[1], { steps: 6 }); await page.mouse.up(); // slide the up arm left
  const of = await counts();
  assert.equal(sum(of), total, 'offset quadrants still cover every event once');
  assert.notDeepEqual(of, std);
  // only the upper quadrants change when the up arm slides
  const names = await ev(() => window.thistleFlow.ws.engine.list().filter(g => g.type === 'quad').map(g => g.q));
  names.forEach((q, i) => { if (q[0] === 'L') assert.equal(of[i], std[i], q + ' unchanged'); });
  await page.locator('.plot-card').nth(2).screenshot({ path: OUT + '/f-offset.png' });
  // undo / workspace keep the style
  const json = await ev(() => JSON.stringify(window.thistleFlow.ws.serialize ? window.thistleFlow.ws.serialize() : {}));
  assert.match(json, /"quadMode":"offset"/);
  await page.click('#quadStyle [data-qmode=standard]');
  assert.deepEqual(await counts(), std, 'back to the straight cross');
  await page.click('.plot-card >> nth=0'); // another gate selected / none: style switch hidden
  await ev(() => window.thistleFlow.selectGate(null));
  assert.equal(await page.isVisible('#quadStyle'), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Layout gating strategy for one sample; compensation editor with live preview plots', { timeout: 240000 }, async () => {
  browser = browser || await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  const ev = f => page.evaluate(f);
  await page.goto(BASE + '/');
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  await ev(() => {
    const e = window.thistleFlow.ws.engine;
    e.add({ id: 'gC', name: 'Cells', parent: null, type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 30000, x1: 120000, y0: 3000, y1: 60000, color: '#e6194b' });
    e.add({ id: 'gS', name: 'Singlets', parent: 'gC', type: 'polygon', x: 'FSC-A', y: 'FSC-H', pts: [[30000, 20000], [120000, 90000], [120000, 130000], [30000, 35000]], color: '#3cb44b' });
    e.add({ id: 'gT', name: 'CD3+', parent: 'gS', type: 'interval', x: 'FITC-A', x0: 1000, x1: 262144, color: '#4363d8' });
    for (const q of ['UL', 'UR', 'LR', 'LL']) e.add({ id: 'q' + q, name: q, parent: 'gT', type: 'quad', q, group: 'QQ', x: 'PE-A', y: 'APC-A', cx: 800, cy: 800, color: '#f58231' });
    e.add({ id: 'gX', name: 'Other', parent: 'gS', type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 1, x1: 2, y0: 1, y1: 2, color: '#000' });
    window.thistleFlow.ws.selectedGate = 'qLR';
    window.thistleFlow.renderAll();
  });

  // ---- gating strategy ----
  await page.click('.tabs [data-tab=layout], [data-tab=layout]');
  await page.click('[data-addfig=strategy]');
  const card = page.locator('.figure-card').last();
  await card.locator('canvas').nth(3).waitFor();
  const steps = await card.locator('canvas').evaluateAll(cs => cs.map(c => ({ title: c._figView.spec?.title, x: c._figView.spec?.x.name, y: c._figView.spec?.y?.name ?? null, gates: c._figView.spec?.gates.map(g => g.gate.id) })));
  assert.deepEqual(steps.map(s => [s.x, s.y]), [['FSC-A', 'SSC-A'], ['FSC-A', 'FSC-H'], ['FITC-A', null], ['PE-A', 'APC-A']]);
  assert.match(steps[0].title, /^All Events/); assert.match(steps[1].title, /^Cells/); assert.match(steps[3].title, /^CD3\+/);
  assert.deepEqual(steps[0].gates, ['gC'], 'only the gate on the path');
  assert.deepEqual(steps[3].gates.sort(), ['qLL', 'qLR', 'qUL', 'qUR'], 'linked quadrants together');
  assert.equal(await card.locator('.strategy-arrow').count(), 3);
  // another sample, and a last plot of the final population
  const second = await ev(() => window.thistleFlow.ws.samples[1].key);
  await card.locator('label:has-text("Sample") select').selectOption(second);
  await card.locator('label:has-text("Then show") select').selectOption('BV421-A');
  await card.locator('canvas').nth(4).waitFor();
  assert.match(await card.locator('.fig-title').textContent(), new RegExp(second.replace(/\.fcs$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const last = await card.locator('canvas').nth(4).evaluate(c => ({ x: c._figView.spec.x.name, y: c._figView.spec.y, n: c._figView.spec.gates.length, title: c._figView.spec.title }));
  assert.deepEqual([last.x, last.y, last.n], ['BV421-A', null, 0]);
  assert.match(last.title, /^LR/);
  await card.locator('label:has-text("Other gates too") input').check();
  assert.ok((await card.locator('canvas').nth(0).evaluate(c => c._figView.spec.gates.length)) >= 1);
  assert.ok(await card.locator('canvas').nth(1).evaluate(c => c._figView.spec.gates.length) >= 1);
  await card.screenshot({ path: OUT + '/g-strategy.png' });
  // saved with the workspace
  assert.match(await ev(() => JSON.stringify(window.thistleFlow.ws.serialize().figures)), /"kind":"strategy"/);

  // ---- compensation with preview (its own tab) ----
  await page.click('.tabs [data-tab=comp]');
  await page.waitForSelector('.comp-mini');
  const n = await ev(() => window.thistleFlow.ws.activeSample().spill.names.length);
  assert.equal(await page.locator('.comp-mini').count(), n * (n - 1), 'one preview plot per off-diagonal matrix value');
  const before = await ev(() => window.thistleFlow.ws.activeSample().spill.matrix[0][1]);
  const pic = () => page.locator('.comp-mini[data-i="0"][data-j="1"]').evaluate(c => c.toDataURL());
  const pic0 = await pic();
  await page.click('.comp-mini[data-i="0"][data-j="1"]');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.i + ',' + document.activeElement.dataset.j), '0,1', 'clicking a plot selects its matrix value');
  for (let k = 0; k < 8; k++) await page.keyboard.press('Shift+ArrowDown');
  await page.waitForTimeout(200);
  const edited = +(await page.inputValue('.matrix input[data-i="0"][data-j="1"]'));
  assert.ok(Math.abs(edited - (before - 0.08)) < 1e-9, `nudged ${before} -> ${edited}`);
  assert.notEqual(await pic(), pic0, 'preview redrawn with the edited value');
  assert.equal(await ev(() => window.thistleFlow.ws.activeSample().spill.matrix[0][1]), before, 'not applied yet');
  assert.match(await page.textContent('.comp-status'), /not applied/);
  assert.match(await page.textContent('.comp-focus-wrap'), /→/);
  await page.locator('.matrix input[data-i="1"][data-j="0"]').fill('0.3');
  // the preview redraws on the next animation frame
  await page.waitForFunction(() => /: 0\.3 /.test(document.querySelector('.comp-focus-wrap').textContent), null, { timeout: 5000 });
  // edits not yet applied survive switching tabs
  await page.click('.tabs [data-tab=gating]'); await page.click('.tabs [data-tab=comp]');
  assert.equal(await page.inputValue('.matrix input[data-i="1"][data-j="0"]'), '0.3');
  await page.click('#compView [data-view=raw]');
  await page.waitForTimeout(100);
  await page.screenshot({ path: OUT + '/g-comp-raw.png' });
  await page.click('#compView [data-view=edited]');
  // overlay: uncompensated events under the compensated ones, in the grid and the large plot
  const pic1 = await pic();
  await page.check('#compOverlay');
  await page.waitForTimeout(150);
  assert.notEqual(await pic(), pic1, 'overlay redraws the preview');
  await page.screenshot({ path: OUT + '/g-comp-overlay.png' });
  await page.uncheck('#compOverlay');
  // heat map: larger values are shaded
  assert.notEqual(await page.locator('.matrix input[data-i="0"][data-j="1"]').evaluate(e => e.style.background), '');
  await page.click('button:has-text("↺ Reset edits")');
  assert.equal(+(await page.inputValue('.matrix input[data-i="0"][data-j="1"]')), +before.toFixed(5));
  await page.locator('.matrix input[data-i="0"][data-j="1"]').fill(String(before - 0.05));
  await page.click('button:has-text("Apply to this sample")');
  assert.ok(Math.abs(await ev(() => window.thistleFlow.ws.activeSample().spill.matrix[0][1]) - (before - 0.05)) < 1e-9, 'applied');
  assert.equal(await page.textContent('.comp-status'), '');
  // the matrix stored in the FCS file can always be put back (the file is never changed)
  const fileVal = await ev(() => window.thistleFlow.ws.activeSample().spillFile.matrix[0][1]);
  assert.ok(Math.abs(fileVal - before) < 1e-12, 'the file matrix is unchanged by applying');
  await page.click('#btnCompFile');
  assert.equal(+(await page.inputValue('.matrix input[data-i="0"][data-j="1"]')), +fileVal.toFixed(5));
  assert.match(await page.textContent('.comp-status'), /not applied/);
  await page.click('button:has-text("↺ Reset edits")');
  // applying is undoable in the Compensation tab
  await page.waitForTimeout(100);
  await page.click('#btnUndo');
  assert.equal(await ev(() => window.thistleFlow.ws.activeSample().spill.matrix[0][1]), before, 'undo restores the matrix');
  await page.screenshot({ path: OUT + '/g-comp.png' });
  assert.deepEqual(errors, []);
  await page.close();
});


test('header labels, Compensation tab, Axis scales in Plots; FCS 2 warning; auto gate; exact event limit', { timeout: 180000 }, async () => {
  browser = browser || await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept('Auto'));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  const ev = f => page.evaluate(f);
  await page.goto(BASE + '/');
  const header = await page.textContent('header');
  assert.match(header, /Open FCS file\(s\)/); assert.match(header, /Save workspace/); assert.match(header, /Load workspace/);
  assert.doesNotMatch(header, /Pure JS/); assert.doesNotMatch(header, /Compensation|Axis scales/);
  assert.deepEqual(await page.$$eval('.tabs [data-tab]', b => b.map(x => x.textContent.trim())), ['Gating', 'Compensation', 'Layout & Overlays', 'Statistics', 'Properties']);
  assert.equal(await ev(() => document.getElementById('btnTransforms').closest('.tb-group').getAttribute('aria-label')), 'Plots');
  assert.equal((await page.textContent('#btnTransforms')).trim(), 'Axis scales');

  // an FCS 2.0 file: loaded, with a warning about resolution and dynamic range
  const { makeDemoFile } = await import('../../js/demo.js');
  const buf = new Uint8Array(makeDemoFile('Old.fcs', 0, 1, 3000));
  buf.set([...'FCS2.0'].map(c => c.charCodeAt(0)), 0);
  await page.setInputFiles('#fileInput', { name: 'Old.fcs', mimeType: 'application/octet-stream', buffer: Buffer.from(buf) });
  await page.waitForSelector('#modal:not([hidden])');
  assert.equal(await page.textContent('#modalTitle'), 'Older FCS format');
  assert.match(await page.textContent('#modalBody'), /Old\.fcs \(FCS2\.0\)[\s\S]*resolution and dynamic range/);
  await page.click('#modalBody button:has-text("OK")');
  assert.equal(await ev(() => window.thistleFlow.ws.samples.length), 1);

  // demo data: no warning (FCS 3.1); the event limit is exact
  await page.click('#btnDemo'); await page.waitForSelector('.plot-card canvas');
  await page.waitForTimeout(300);
  assert.equal(await page.isHidden('#modal'), true);
  await ev(() => { const ws = window.thistleFlow.ws; ws.activeId = ws.samples.find(x => /Unstim/.test(x.name)).id; window.thistleFlow.renderAll(); });
  await page.selectOption('#displayMax', '5000');
  await page.waitForTimeout(200);
  assert.deepEqual(await ev(() => [...window.thistleFlow.views.values()].filter(v => v.spec.series[0].uy).map(v => v.spec.series[0].idx.length)).then(a => [...new Set(a)]), [5000]);
  assert.match(await ev(() => [...window.thistleFlow.views.values()][0].spec.titleTail), /showing 5,000\)/);

  // auto gate: the outline follows the cursor, a click makes a polygon around that population
  await ev(() => { const ws = window.thistleFlow.ws; const s = ws.samples.find(x => /Stim_6h/.test(x.name)) || ws.samples[0]; ws.activeId = s.id; ws.plots[0].x = 'PE-A'; ws.plots[0].y = 'APC-A'; window.thistleFlow.renderAll(); });
  await page.click('[data-tool=auto]');
  const b = await page.locator('.plot-card canvas').nth(0).boundingBox();
  // the CD4+ (PE bright, APC dim) population: find its densest spot from the data
  const target = await ev(() => {
    const v = [...window.thistleFlow.views.values()][0], s = v.spec.series[0];
    let best = null, n = 0;
    for (const i of s.idx) if (s.ux[i] > 0.6 && s.uy[i] < 0.45) { n++; best = best ? [best[0] + s.ux[i], best[1] + s.uy[i]] : [s.ux[i], s.uy[i]]; }
    const u = [best[0] / n, best[1] / n];
    return [v.L.ux2px(u[0]), v.L.uy2px(u[1])];
  });
  await page.mouse.move(b.x + target[0] - 5, b.y + target[1]);
  await page.mouse.move(b.x + target[0], b.y + target[1]);
  await page.waitForFunction(() => [...window.thistleFlow.views.values()][0].preview?.poly?.length > 3, null, { timeout: 5000 });
  await page.locator('.plot-card').nth(0).screenshot({ path: OUT + '/h-auto-preview.png' });
  await page.mouse.click(b.x + target[0], b.y + target[1]);
  const g = await ev(() => window.thistleFlow.ws.engine.list().find(x => x.name === 'Auto'));
  assert.ok(g && g.type === 'polygon' && g.pts.length >= 3, 'polygon gate created');
  const st = await ev(() => { const ws = window.thistleFlow.ws, s = ws.activeSample(), g = ws.engine.list().find(x => x.name === 'Auto');
    const pop = ws.engine.population(s, g.id), pe = s.column('PE-A'), apc = s.column('APC-A');
    let cd4 = 0; for (const i of pop.idx) if (pe[i] > 1000 && apc[i] < 500) cd4++;
    return { n: pop.count, cd4 }; });
  assert.ok(st.n > 2000 && st.cd4 / st.n > 0.9, `auto gate holds the CD4 population: ${JSON.stringify(st)}`);
  assert.equal(await ev(() => window.thistleFlow.tool), 'select', 'back to Select');
  await page.locator('.plot-card').nth(0).screenshot({ path: OUT + '/h-auto.png' });
  // clicking empty space makes nothing
  await page.click('[data-tool=auto]');
  const nGates = await ev(() => window.thistleFlow.ws.engine.list().length);
  await page.mouse.click(b.x + b.width - 25, b.y + 35);
  assert.equal(await ev(() => window.thistleFlow.ws.engine.list().length), nGates);
  assert.deepEqual(errors, []);
  await page.close();
});
