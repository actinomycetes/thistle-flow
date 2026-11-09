// Every place that shows the version must agree (mirrors Thistle Plot's smoke test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '../js/version.js';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('version is beta 0.x and consistent everywhere', () => {
  assert.match(APP_VERSION, /^0\.\d+\.\d+$/, 'beta releases are 0.MINOR.PATCH');
  const v = APP_VERSION;
  const html = read('index.html');
  assert.ok(html.includes(`<title>Thistle Flow v${v} (Beta)</title>`), 'index.html <title>');
  assert.match(html, new RegExp(`id="app-version"[^>]*>v${v.replace(/\./g, '\\.')}<`), 'header version badge');
  assert.ok(/class="badge-hdr beta">BETA</.test(html), 'BETA badge');
  assert.equal(JSON.parse(read('package.json')).version, v, 'package.json');
  assert.match(read('CITATION.cff'), new RegExp(`^version: ${v.replace(/\./g, '\\.')}$`, 'm'), 'CITATION.cff');
  const help = read('help.html');
  assert.ok(help.includes(`<title>Thistle Flow v${v} (Beta)`), 'help.html title');
  assert.ok(help.includes(`Known limitations of v${v} (beta)`), 'help.html limitations heading');
  const firstRow = /<tr><td>(\d+\.\d+\.\d+) \(/.exec(help.slice(help.indexOf('id="history"')));
  assert.equal(firstRow?.[1], v, 'newest row of the version history');
  // no stale versions left in the user-facing files
  for (const [name, text] of [['index.html', html], ['help.html', help]]) {
    for (const m of text.matchAll(/v(0\.\d+\.\d+)/g)) assert.equal(m[1], v, `${name} mentions v${m[1]}`);
  }
});
