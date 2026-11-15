// Saved files follow the Thistle suite convention: .tflow, with { app, format, appVersion, kind } first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFCS } from '../js/fcs.js';
import { Sample } from '../js/model.js';
import { makeDemoFile } from '../js/demo.js';
import { Workspace, fileHeader, fileFormat, checkThistleFlowFile, FILE_EXT, FILE_FORMAT } from '../js/workspace.js';
import { APP_VERSION } from '../js/version.js';

function ws1() {
  const ws = new Workspace('T');
  const [ds] = parseFCS(makeDemoFile('a.fcs', 0.3, 5, 3000), 'a.fcs');
  ws.samples.push(new Sample(ds)); ws.activeId = ws.samples[0].id; ws.rebase();
  ws.engine.add({ id: 'g', name: 'Cells', parent: null, type: 'rect', x: 'FSC-A', y: 'SSC-A', x0: 1, x1: 2, y0: 1, y1: 2 });
  return ws;
}

test('workspaces and templates start with the Thistle Flow header and are saved as .tflow', () => {
  assert.equal(FILE_EXT, 'tflow');
  for (const data of [ws1().serialize(), ws1().template()]) {
    assert.deepEqual(Object.keys(data).slice(0, 4), ['app', 'format', 'appVersion', 'kind']);
    assert.equal(data.app, 'Thistle Flow'); assert.equal(data.format, FILE_FORMAT); assert.equal(data.appVersion, APP_VERSION);
    assert.ok(Number.isInteger(data.format));
  }
  assert.equal(fileHeader('template').kind, 'template');
});

test('files saved by earlier versions (ThistleFlow .json/.zip, FlowLite) still open', () => {
  const now = ws1().serialize();
  const old = { ...now, app: 'ThistleFlow', version: 2 }; delete old.format;
  const ws = new Workspace('X'); const [ds] = parseFCS(makeDemoFile('a.fcs', 0.3, 5, 3000), 'a.fcs'); ws.samples.push(new Sample(ds));
  assert.deepEqual(ws.deserialize(old), []);
  assert.equal(ws.engine.get('g').name, 'Cells');
  assert.equal(fileFormat(old), 2); assert.equal(fileFormat({ app: 'FlowLite' }), 1); assert.equal(fileFormat(now), 3);
  const tpl = { ...ws1().template(), app: 'ThistleFlow', version: 1 }; delete tpl.format;
  assert.doesNotThrow(() => new Workspace('Y').applyTemplate(tpl, ['#000']));
  assert.doesNotThrow(() => checkThistleFlowFile({ app: 'FlowLite' }));
});

test('files from other Thistle apps get a plain message naming the right app', () => {
  assert.throws(() => checkThistleFlowFile({ app: 'Thistle Plot', format: 1 }), /This is a Thistle Plot project; open it in Thistle Plot \(https:\/\/actinomycetes\.github\.io\/thistle-plot\/\)\./);
  assert.throws(() => new Workspace('Z').deserialize({ app: 'Thistle Plot' }), /Thistle Plot project/);
  assert.throws(() => checkThistleFlowFile({ app: 'Thistle Cell' }), /saved by Thistle Cell; open it in that app/);
  assert.throws(() => checkThistleFlowFile({ hello: 1 }), /not a Thistle Flow file/);
});

test('tab icon: the Thistle Flow thistle (dotted head) with the laser-and-cell badge, the same in app and Help', async () => {
  const fs = await import('node:fs');
  const icon = f => decodeURIComponent(/rel="icon"[^>]*href="data:image\/svg\+xml,([^"]*)"/.exec(fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8'))[1]);
  const a = icon('index.html'), b = icon('help.html');
  assert.equal(a, b);
  assert.match(a, /viewBox="0 0 32 32"/);
  assert.match(a, /<circle cx="9\.7" cy="12\.7" r="\.95"\/>/, 'dotted thistle head, as in the header logo');
  assert.match(a, /stroke="#ef4444"/, 'red laser beam');
  assert.match(a, /fill="#22d3ee"/, 'cyan cell');
  // fully percent-encoded (no raw spaces or quotes), which Safari on iPad reads reliably
  for (const f of ['index.html', 'help.html']) {
    const html = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.match(html, /rel="icon"[^>]*href="data:image\/svg\+xml,%3Csvg[^ '"]*"/, f + ': encoded tab icon');
    assert.match(html, /rel="apple-touch-icon" href="data:image\/png;base64,iVBOR/, f + ': PNG icon for Safari');
    // the header logo (top left) is the same icon as the tab
    const logo = /<svg class="app-logo"[^>]*viewBox="0 0 32 32"[^>]*>([\s\S]*?)<\/svg>/.exec(html);
    assert.ok(logo, f + ': header logo');
    assert.equal(logo[1], a.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, ''), f + ': header logo matches the tab icon');
  }
});
