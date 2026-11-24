// Tab icon when Thistle Flow is shown inside another page (Thistle Notebook embeds it in a same-site frame): the embedded
// copy drops its icon links so the host tab keeps its own icon (Orion showed another app's icon on the host tab).
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
  if (req.url.startsWith('/__host')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Host</title><iframe id="f" src="/?nosession" style="width:1200px;height:800px"></iframe>'); }
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}`;
let browser;
after(async () => { await browser?.close(); server.close(); });

test('embedded Thistle Flow drops its tab icon; on its own it keeps it', { timeout: 60000 }, async () => {
  browser = await pw.launch();
  const page = await browser.newPage();
  await page.goto(BASE + '/?nosession');
  await page.waitForFunction(() => window.thistleFlow);
  const icons = () => document.querySelectorAll('link[rel="icon"],link[rel="apple-touch-icon"]').length;
  assert.equal(await page.evaluate(icons), 2, 'Flow on its own keeps its icon and touch icon');
  await page.goto(BASE + '/__host');
  const frame = await (await page.waitForSelector('#f')).contentFrame();
  await frame.waitForFunction(() => window.thistleFlow);
  assert.equal(await frame.evaluate(icons), 0, 'embedded Flow has no icon links');
});
