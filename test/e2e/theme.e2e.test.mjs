// Readability in both themes: text contrast (WCAG AA) and no dark-mode colours left in light mode,
// across every tab with demo data, gates and a layout figure, and the Help page; plus colour-blind-safe palettes.
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

// Readability check run inside the page: every visible text against its real (composited) background must meet
// WCAG AA (4.5:1, or 3:1 for large text), and in light mode no box may keep a dark grey/navy background (a dark-mode
// colour left hard-coded). `allow` lists CSS selectors that are dark on purpose (e.g. the BETA badge).
function themeAudit(allow) {
  const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const blend = (t, b) => [0, 1, 2].map(i => t[i] * t[3] + b[i] * (1 - t[3])).concat(1);
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const shown = el => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false; } const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; };
  const bgOf = el => { const st = []; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.backgroundImage !== 'none') return null; const c = parse(s.backgroundColor); if (c && c[3] > 0) { st.push(c); if (c[3] >= 1) break; } } let bg = [255, 255, 255, 1]; for (let i = st.length - 1; i >= 0; i--) bg = blend(st[i], bg); return bg; };
  const name = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].join('.') : '');
  const ok = el => allow.some(s => el.closest(s));
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  const low = new Set(), dark = new Set();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const el = n.parentElement, t = n.textContent.trim();
    if (!t || !el || ['SCRIPT', 'STYLE', 'OPTION'].includes(el.tagName) || ok(el) || !shown(el)) continue;
    const cs = getComputedStyle(el), fg = parse(cs.color), bg = bgOf(el); if (!fg || !bg) continue;
    const size = parseFloat(cs.fontSize), big = size >= 24 || (+cs.fontWeight >= 700 && size >= 18.66);
    const r = ratio(blend(fg, bg), bg); if (r < (big ? 3 : 4.5)) low.add(`${name(el)} "${t.slice(0, 30)}" ${r.toFixed(2)}:1`);
  }
  if (light) for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg') || ['CANVAS', 'IMG'].includes(el.tagName) || ok(el) || !shown(el)) continue;
    const c = parse(getComputedStyle(el).backgroundColor); if (!c || c[3] < 0.5) continue;
    if (lum(c) < 0.25 && Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < 120) dark.add(`${name(el)} ${getComputedStyle(el).backgroundColor}`);
  }
  return { low: [...low], dark: [...dark] };
}

// Dark on purpose in both themes: the BETA badge and the blue action buttons (white text).
const ALLOW = ['.beta', '.btn.primary', '.tools button.active'];
const audit = (page, label) => page.evaluate(`(${themeAudit})(${JSON.stringify(ALLOW)})`).then(r => {
  assert.deepEqual(r.low, [], label + ': text below WCAG AA contrast');
  assert.deepEqual(r.dark, [], label + ': dark background left in light mode');
});

test('readable in dark and light mode on every tab and in Help', { timeout: 180000 }, async () => {
  browser = await pw.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await page.goto(BASE + '/index.html');
  await page.click('#btnDemo');
  await page.waitForFunction(() => window.thistleFlow?.ws?.samples?.length === 3, null, { timeout: 30000 });
  await page.evaluate(() => { const e = window.thistleFlow.ws.engine;
    e.add({ id: 'gA', name: 'Lymphocytes', parent: null, type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 30000, x1: 75000, y0: 3000, y1: 60000, color: '#d55e00' });
    e.add({ id: 'gB', name: 'Singlets', parent: 'gA', type: 'polygon', x: 'FSC-A', y: 'FSC-H', pts: [[30000, 20000], [120000, 90000], [120000, 130000], [30000, 35000]], color: '#3a8fc4' });
    window.thistleFlow.renderAll(); });
  await page.click('button[data-tab="layout"]'); await page.click('button[data-addfig="overlay-hist"]');
  for (const theme of ['dark', 'light']) {
    if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await page.click('#btnTheme');
    for (const tab of ['gating', 'comp', 'layout', 'stats', 'properties']) {
      await page.click(`button[data-tab="${tab}"]`); await page.waitForTimeout(500); // let colour transitions finish
      await audit(page, `${theme} ${tab}`);
    }
  }
  for (const theme of ['dark', 'light']) {
    await page.goto(BASE + '/help.html'); await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(200); await audit(page, `${theme} Help`);
  }
});

test('colour-blind-safe colours: gates and overlays read on white and dark plots; density scale is viridis', async () => {
  const { GATE_COLORS } = await import('../../js/gates.js');
  const { SERIES_COLORS, LUT } = await import('../../js/render.js');
  const lum = h => { const c = typeof h === 'string' ? [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16)) : h; const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  for (const c of [...GATE_COLORS, ...SERIES_COLORS]) {
    assert.ok(ratio(c, '#ffffff') >= 3, `${c} on white`); // labels are drawn in the gate colour on a white or navy box
    assert.ok(ratio(c, '#0f172a') >= 3, `${c} on dark navy`);
  }
  assert.deepEqual(GATE_COLORS.slice(0, 2), ['#d55e00', '#3a8fc4'], 'vermillion and sky blue first (no red next to green)');
  // viridis gets steadily lighter from low to high density, so the order reads without colour vision
  for (let i = 8; i < 256; i += 8) assert.ok(lum(LUT[i]) > lum(LUT[i - 8]), `density scale lighter at ${i}`);
});
