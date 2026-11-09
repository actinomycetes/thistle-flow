// FlowLite application controller.
import { parseFCS, writeFCS } from './fcs.js';
import { Sample } from './model.js';
import { defaultTransformFor } from './transforms.js';
import { GateEngine, GATE_COLORS, STAT_DEFS, channelStats, populationStats } from './gates.js';
import { PlotView, buildSpec, shortLabel, fmtPct } from './plotview.js';
import { renderPlot, prepareCanvas, SERIES_COLORS } from './render.js';
import { demoFiles } from './demo.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};
const uid = p => p + Math.random().toString(36).slice(2, 9);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const app = {
  samples: [],
  activeId: null,
  transforms: {},
  plots: [],
  figures: [],
  views: new Map(),
  tool: 'select',
  selectedGate: null,
  focusedPlot: null,
  statsCfg: { pops: null, stats: ['count', 'pctParent', 'median'], channels: null },
  tab: 'gating',
};
app.engine = new GateEngine(ch => app.getCfg(ch));
window.flowlite = app; // handy for debugging from the console

// ---------- helpers ----------
// Display range for a channel = largest $PnR among loaded samples (log-amplified channels: 10^decades)
function channelRange(ch) {
  let r = 0, logAmp = false;
  for (const s of app.samples) {
    const p = s.params[s.channelIndex(ch)];
    if (!p) continue;
    if (p.ampE[0] > 0 && s.text['$DATATYPE'] === 'I') { logAmp = true; r = Math.max(r, Math.pow(10, p.ampE[0]) * (p.ampE[1] || 1)); }
    else r = Math.max(r, p.range || 0);
  }
  return { range: r || 262144, logAmp };
}
app.getCfg = ch => {
  if (!app.transforms[ch]) {
    const { range, logAmp } = channelRange(ch);
    app.transforms[ch] = logAmp ? { kind: 'log', min: 1, max: range, auto: true } : defaultTransformFor(ch, range);
  }
  return app.transforms[ch];
};
// Re-derive automatic (never user-edited) scales after the sample set changes
function refreshAutoTransforms() {
  for (const [ch, cfg] of Object.entries(app.transforms)) if (cfg.auto) delete app.transforms[ch];
}
app.activeSample = () => app.samples.find(s => s.id === app.activeId) || null;
app.sampleById = id => app.samples.find(s => s.id === id);
app.allChannels = () => {
  const seen = new Set(), out = [];
  for (const s of app.samples) for (const c of s.channelNames) if (!seen.has(c)) { seen.add(c); out.push(c); }
  return out;
};
app.channelLabel = ch => { const s = app.samples.find(x => x.hasChannel(ch)); return s ? s.label(ch) : ch; };
const isScatterOrTime = ch => /^(FSC|SSC|BSC|FS|SS)|TIME|EVENT|WIDTH|^SAMPLEID/i.test(ch);
app.fluorChannels = () => app.allChannels().filter(c => !isScatterOrTime(c) && !/-(H|W)$/i.test(c));

app.toast = (msg, isError = false) => {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false; t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(app._toastT); app._toastT = setTimeout(() => (t.hidden = true), isError ? 6000 : 2800);
};

function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- loading ----------
async function loadBuffers(items) {
  const errors = [];
  for (const { name, buffer } of items) {
    try {
      for (const ds of parseFCS(buffer, name)) {
        if (!ds.events) { errors.push(`${name}: no events`); continue; }
        app.samples.push(new Sample(ds));
      }
    } catch (err) {
      console.error(err); errors.push(`${name}: ${err.message}`);
    }
  }
  if (!app.activeId && app.samples.length) app.activeId = app.samples[0].id;
  refreshAutoTransforms();
  app.engine.invalidate();
  if (!app.plots.length && app.samples.length) defaultPlots();
  if (errors.length) app.toast('Could not load: ' + errors.join('; '), true);
  else app.toast(`Loaded ${items.length} file(s)`);
  renderAll();
}

async function loadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  app.toast(`Reading ${files.length} file(s)…`);
  const items = await Promise.all(files.map(async f => ({ name: f.name, buffer: await f.arrayBuffer() })));
  await loadBuffers(items);
}

function defaultPlots() {
  const s = app.samples[0];
  const chans = s.channelNames;
  const find = re => chans.find(c => re.test(c));
  const fsc = find(/^FSC.*-A$/i) || find(/^FSC/i) || find(/^FS/i) || chans[0];
  const ssc = find(/^SSC.*-A$/i) || find(/^SSC/i) || find(/^(BSC|SS)/i) || chans[1] || chans[0];
  const fl = app.fluorChannels().filter(c => s.hasChannel(c));
  app.plots.push({ id: uid('p'), pop: null, x: fsc, y: ssc, kind: 'density' });
  if (fl.length >= 2) app.plots.push({ id: uid('p'), pop: null, x: fl[0], y: fl[1], kind: 'density' });
  if (fl.length) app.plots.push({ id: uid('p'), pop: null, x: fl[0], y: null, kind: 'density' });
}

// ---------- rendering: sample list ----------
function renderSamples() {
  const ul = $('#sampleList');
  ul.innerHTML = '';
  $('#sampleCount').textContent = app.samples.length ? `(${app.samples.length})` : '';
  $('#dropHint').style.display = app.samples.length ? 'none' : '';
  for (const s of app.samples) {
    const compTag = s.spill ? h('span', { class: 'badge' + (s.compEnabled ? '' : ' off'), title: 'Compensation' }, s.compEnabled ? 'comp' : 'uncomp') : null;
    const li = h('li', { class: s.id === app.activeId ? 'active' : '', onclick: () => { app.activeId = s.id; renderAll(); } },
      h('div', { class: 'meta' },
        h('div', { class: 'name', title: s.name }, s.name),
        h('div', { class: 'sub' }, `${s.events.toLocaleString()} events · ${s.params.length} par · ${s.version}`, compTag),
        h('div', { class: 'sub', title: s.instrument }, s.instrument)),
      h('button', { class: 'icon', title: 'Keywords', onclick: e => { e.stopPropagation(); showKeywords(s); } }, 'ⓘ'),
      h('button', { class: 'icon', title: 'Remove sample', onclick: e => { e.stopPropagation(); removeSample(s.id); } }, '×'));
    ul.append(li);
  }
}

function removeSample(id) {
  app.samples = app.samples.filter(s => s.id !== id);
  app.engine.invalidate(id);
  for (const f of app.figures) if (f.series) f.series = f.series.filter(se => se.sampleId !== id);
  if (app.activeId === id) app.activeId = app.samples[0]?.id || null;
  renderAll();
}

// ---------- rendering: gate tree ----------
function renderGateTree() {
  const root = $('#gateTree');
  root.innerHTML = '';
  const s = app.activeSample();
  const node = (g) => {
    const id = g ? g.id : null;
    let pct = '', count = '';
    if (s) {
      const st = id ? populationStats(app.engine, s, id) : { count: s.events };
      count = st.count.toLocaleString();
      pct = id ? fmtPct(st.pctParent) : '';
    }
    const row = h('div', {
      class: 'node' + (app.selectedGate === id && id ? ' selected' : ''),
      onclick: () => app.selectGate(id),
      ondblclick: () => { if (g) renameGate(g); },
      title: id ? app.engine.fullName(id) : 'All Events',
    },
      h('span', { class: 'swatch', style: `background:${g ? g.color : '#999'}` }),
      h('span', { class: 'gname' }, g ? g.name : 'All Events'),
      h('span', { class: 'gpct' }, pct ? `${pct} · ${count}` : count),
      h('button', { class: 'icon', title: 'Open plot of this population', onclick: e => { e.stopPropagation(); openPopulationPlot(id); } }, '＋'),
      s ? h('button', { class: 'icon', title: 'Export events of this population (FCS)', onclick: e => { e.stopPropagation(); exportPopulation(s, id); } }, '⤓') : null,
      g ? h('button', { class: 'icon', title: 'Delete gate', onclick: e => { e.stopPropagation(); deleteGate(g.id); } }, '×') : null,
    );
    const kids = app.engine.children(id);
    const li = h('li', {}, row);
    if (kids.length) li.append(h('ul', {}, kids.map(node)));
    return li;
  };
  root.append(h('ul', {}, node(null)));
}

function renameGate(g) {
  const name = prompt('Gate name', g.name);
  if (name && name.trim()) { g.name = name.trim(); renderAll(); }
}

function deleteGate(id) {
  const g = app.engine.get(id); if (!g) return;
  const nKids = app.engine.list().filter(x => app.engine.path(x.id).some(p => p.id === id)).length - 1;
  if (nKids > 0 && !confirm(`Delete "${g.name}" and its ${nKids} descendant gate(s)?`)) return;
  app.engine.remove(id);
  const exists = gid => !gid || app.engine.get(gid);
  app.plots.forEach(p => { if (!exists(p.pop)) p.pop = g.parent && exists(g.parent) ? g.parent : null; });
  app.figures.forEach(f => { if (!exists(f.pop)) f.pop = null; (f.series || []).forEach(se => { if (!exists(se.pop)) se.pop = null; }); });
  if (app.statsCfg.pops) app.statsCfg.pops = app.statsCfg.pops.filter(exists);
  if (!exists(app.selectedGate)) app.selectedGate = null;
  renderAll();
}

function openPopulationPlot(id) {
  const g = id ? app.engine.get(id) : null;
  const base = app.plots.find(p => p.id === app.focusedPlot) || app.plots[0];
  app.plots.push({ id: uid('p'), pop: id, x: g?.x || base?.x || app.allChannels()[0], y: g ? (g.y || null) : (base?.y ?? null), kind: 'density' });
  switchTab('gating');
  renderAll();
}

function exportPopulation(s, gateId) {
  const pop = app.engine.population(s, gateId);
  const cols = s.raw.map(c => { const o = new Float32Array(pop.count); for (let i = 0; i < pop.count; i++) o[i] = c[pop.idx[i]]; return o; });
  const extra = {};
  for (const k of ['$CYT', '$CYTSN', '$DATE', '$BTIM', '$ETIM', '$SRC', '$SPILLOVER', 'SPILL']) if (s.text[k]) extra[k] = s.text[k];
  if (s.spill) extra['$SPILLOVER'] = [s.spill.names.length, ...s.spill.names, ...s.spill.matrix.flat()].join(',');
  delete extra['SPILL'];
  const popName = gateId ? app.engine.fullName(gateId).replace(/[\\/:*?"<>|]+/g, '_') : 'All';
  extra['$FIL'] = `${s.name.replace(/\.fcs$/i, '')}_${popName}.fcs`;
  const buf = writeFCS({ names: s.channelNames, labels: s.params.map(p => p.label), columns: cols, ranges: s.params.map(p => p.range), extraText: extra });
  download(extra['$FIL'], buf);
}

// ---------- gating tab ----------
function channelOptions(sel, { allowHist = false } = {}) {
  const opts = app.allChannels().map(c => h('option', { value: c, selected: c === sel }, app.channelLabel(c)));
  if (allowHist) opts.push(h('option', { value: '', selected: !sel }, '— Histogram —'));
  return opts;
}
function popOptions(sel) {
  const out = [h('option', { value: '', selected: !sel }, 'All Events')];
  const walk = (pid, depth) => app.engine.children(pid).forEach(g => {
    out.push(h('option', { value: g.id, selected: g.id === sel }, '  '.repeat(depth) + g.name));
    walk(g.id, depth + 1);
  });
  walk(null, 1);
  return out;
}

function renderGating() {
  const grid = $('#plotGrid');
  grid.innerHTML = '';
  app.views.clear();
  const s = app.activeSample();
  $('#activeSampleInfo').textContent = s ? `Active sample: ${s.name}` : '';
  if (!app.samples.length) {
    grid.append(h('div', { class: 'empty-state' },
      h('h2', {}, 'Lightweight flow cytometry analysis'),
      h('p', {}, 'Open or drop FCS files exported from BD (FACSDiva/FACSuite), Attune NxT, Sony spectral analysers, CytoFLEX, Cytek, etc. Everything runs locally in your browser — no data is uploaded.'),
      h('p', {}, h('button', { class: 'btn primary', onclick: () => $('#fileInput').click() }, 'Open FCS files…'), ' ',
        h('button', { class: 'btn', onclick: loadDemo }, 'Try demo data'))));
    return;
  }
  for (const p of app.plots) {
    const canvas = h('canvas');
    const card = h('div', { class: 'plot-card' + (p.id === app.focusedPlot ? ' focused' : '') + (app.tool === 'select' ? ' tool-select' : '') },
      h('div', { class: 'plot-head' },
        h('select', { title: 'Population (parent gate)', onchange: e => { p.pop = e.target.value || null; renderAll(); } }, popOptions(p.pop)),
        h('select', { title: 'X axis', onchange: e => { p.x = e.target.value; drawPlot(p.id); } }, channelOptions(p.x)),
        h('select', { title: 'Y axis', onchange: e => { p.y = e.target.value || null; renderGating(); } }, channelOptions(p.y, { allowHist: true })),
        p.y ? h('select', { title: 'Plot type', onchange: e => { p.kind = e.target.value; drawPlot(p.id); } },
          h('option', { value: 'density', selected: p.kind !== 'dot' }, 'Pseudocolor'),
          h('option', { value: 'dot', selected: p.kind === 'dot' }, 'Dot')) : null,
        h('span', { class: 'grow' }),
        h('button', { class: 'icon', title: 'Axis scales', onclick: () => openTransforms(p.x) }, '⚙'),
        h('button', { class: 'icon', title: 'Save PNG', onclick: () => canvas.toBlob(b => download(`${s.name}_${p.x}${p.y ? '_' + p.y : ''}.png`, b)) }, '⤓'),
        h('button', { class: 'icon', title: 'Close plot', onclick: () => { app.plots = app.plots.filter(q => q.id !== p.id); renderGating(); } }, '×')),
      canvas);
    grid.append(card);
    const view = new PlotView(app, p, canvas, 370, 340);
    app.views.set(p.id, view);
    view.draw();
  }
}

function drawPlot(id) { app.views.get(id)?.draw(); }
app.redrawAll = () => { for (const v of app.views.values()) v.draw(); renderGateTree(); };

app.focusPlot = id => {
  if (app.focusedPlot === id) return;
  app.focusedPlot = id;
  $$('.plot-card').forEach((c, i) => c.classList.toggle('focused', app.plots[i]?.id === id));
};

app.selectGate = (id, { quiet = false } = {}) => {
  app.selectedGate = id || null;
  $('#btnDeleteGate').disabled = !app.selectedGate;
  if (!quiet) app.redrawAll(); else renderGateTree();
};

function nextColor() { return GATE_COLORS[app.engine.list().length % GATE_COLORS.length]; }

app.createGate = (def, geom) => {
  const s = app.activeSample();
  let suggestion = `Gate ${app.engine.list().length + 1}`;
  if (geom.type === 'interval') suggestion = `${shortLabel(s, def.x)}+`;
  else if (/^FSC/i.test(def.x) && /^FSC/i.test(def.y || '')) suggestion = 'Singlets';
  else if (/^FSC/i.test(def.x) && /^SSC/i.test(def.y || '')) suggestion = app.engine.children(def.pop).length ? 'Cells' : 'Lymphocytes';
  const name = prompt('Name this gate', suggestion);
  if (name === null) { app.redrawAll(); return; }
  const g = { id: uid('g'), name: name.trim() || suggestion, parent: def.pop || null, x: def.x, y: def.y || null, color: nextColor(), ...geom };
  app.engine.add(g);
  app.selectedGate = g.id;
  $('#btnDeleteGate').disabled = false;
  renderAll();
};

app.createQuadrant = (def, [cx, cy]) => {
  const s = app.activeSample();
  const xl = shortLabel(s, def.x), yl = shortLabel(s, def.y);
  const group = uid('q');
  const color = nextColor();
  const names = { UL: `${xl}- ${yl}+`, UR: `${xl}+ ${yl}+`, LR: `${xl}+ ${yl}-`, LL: `${xl}- ${yl}-` };
  let first;
  for (const q of ['UL', 'UR', 'LR', 'LL']) {
    const g = { id: uid('g'), name: names[q], parent: def.pop || null, type: 'quad', q, group, x: def.x, y: def.y, cx, cy, color };
    app.engine.add(g); first = first || g;
  }
  app.selectedGate = first.id;
  renderAll();
};

// During drags only descendants of the changed gate need recomputation.
app.gateChanged = (g, { live = false } = {}) => {
  if (!g) return;
  const affected = new Set();
  for (const x of app.engine.list()) {
    if (app.engine.path(x.id).some(p => p.id === g.id || (g.group && p.group === g.group))) affected.add(x.id);
  }
  for (const sc of app.engine.cache.values()) for (const id of affected) sc.delete(id);
  if (live) return;
  renderAll({ keepGating: true });
};

app.drillDown = (gate, fromDef) => {
  // open a plot of the population inside the gate (FlowJo-style double click)
  const fl = app.fluorChannels();
  let x = fromDef.x, y = fromDef.y;
  if (/^FSC/i.test(x) && /^SSC/i.test(y || '')) {
    const fsch = app.allChannels().find(c => /^FSC.*-H$/i.test(c));
    if (fsch && !app.engine.list().some(g => g.parent === gate.id)) { x = fromDef.x; y = fsch; }
    else if (fl.length >= 2) { x = fl[0]; y = fl[1]; }
  } else if (/^FSC/i.test(x) && /^FSC/i.test(y || '') && fl.length >= 2) { x = fl[0]; y = fl[1]; }
  app.plots.push({ id: uid('p'), pop: gate.id, x, y, kind: 'density' });
  renderGating();
  $('#plotGrid').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

// ---------- layout / figures ----------
function addFigure(kind) {
  if (!app.samples.length) return app.toast('Load samples first');
  const fl = app.fluorChannels();
  const x = fl[0] || app.allChannels()[0];
  const pop = app.selectedGate || null;
  const f = { id: uid('f'), kind, x, y: kind === 'overlay-hist' ? null : (fl[1] || app.allChannels()[1]), pop, title: '', mode: 'mode', offset: 0, smooth: true, fill: true, w: 440, h: 340, plotKind: 'density' };
  if (kind !== 'batch') f.series = app.samples.map((s, i) => ({ sampleId: s.id, pop, color: SERIES_COLORS[i % SERIES_COLORS.length] }));
  else { f.w = 230; f.h = 220; f.y = app.plots.find(p => p.id === app.focusedPlot)?.y ?? f.y; }
  app.figures.push(f);
  renderFigures();
}

function seriesLabel(se) {
  const s = app.sampleById(se.sampleId);
  if (!s) return '(missing sample)';
  return se.label || (s.name.replace(/\.fcs$/i, '') + (se.pop ? ` · ${app.engine.get(se.pop)?.name}` : ''));
}

function figureSpec(f) {
  const cfgX = app.getCfg(f.x), cfgY = f.y ? app.getCfg(f.y) : null;
  const series = [];
  for (const se of f.series) {
    const s = app.sampleById(se.sampleId);
    if (!s || !s.hasChannel(f.x) || (f.y && !s.hasChannel(f.y))) continue;
    if (se.pop && !app.engine.get(se.pop)) continue;
    const pop = app.engine.population(s, se.pop);
    series.push({ ux: s.unit(f.x, cfgX), uy: f.y ? s.unit(f.y, cfgY) : null, idx: pop.idx, color: se.color, label: seriesLabel(se) });
  }
  return {
    w: f.w, h: f.h, kind: f.kind === 'overlay-hist' ? 'histogram' : 'dot', title: f.title,
    x: { name: f.x, label: app.channelLabel(f.x), cfg: cfgX }, y: f.y ? { name: f.y, label: app.channelLabel(f.y), cfg: cfgY } : null,
    series, showLegend: !(f.kind === 'overlay-hist' && f.offset > 0),
    hist: { mode: f.mode, offset: f.offset, smooth: f.smooth, fill: f.fill },
  };
}

function renderFigures() {
  const root = $('#figures');
  root.innerHTML = '';
  if (!app.figures.length) {
    root.append(h('div', { class: 'empty-state' }, h('h2', {}, 'Layouts & overlays'),
      h('p', {}, 'Build publication-style figures: overlay histograms of several samples/populations (normalised to mode, optionally staggered), overlay dot plots coloured by sample, or a batch row showing the same plot for every sample. Export each figure or the whole layout as PNG.')));
    return;
  }
  for (const f of app.figures) root.append(figureCard(f));
}

function figureCard(f) {
  const ctrl = h('div', { class: 'fig-controls' });
  const out = h('div', {});
  const redraw = () => drawFigure(f, out);
  const field = (label, el) => h('label', {}, h('span', {}, label), el);
  const kindName = { 'overlay-hist': 'Histogram overlay', 'overlay-dot': 'Dot-plot overlay', batch: 'Batch' }[f.kind];
  ctrl.append(h('div', { style: 'display:flex;align-items:center;gap:6px' }, h('b', { style: 'flex:1' }, kindName),
    h('button', { class: 'btn small', onclick: () => out.querySelectorAll('canvas').length === 1 ? out.querySelector('canvas').toBlob(b => download(`${f.title || kindName}.png`, b)) : figureToCanvas(out).toBlob(b => download(`${f.title || kindName}.png`, b)) }, 'PNG'),
    h('button', { class: 'icon', title: 'Remove', onclick: () => { app.figures = app.figures.filter(x => x !== f); renderFigures(); } }, '×')));
  ctrl.append(field('Title', h('input', { type: 'text', value: f.title, placeholder: '(optional)', oninput: e => { f.title = e.target.value; redraw(); } })));
  ctrl.append(field('X', h('select', { onchange: e => { f.x = e.target.value; redraw(); } }, channelOptions(f.x))));
  if (f.kind !== 'overlay-hist') ctrl.append(field('Y', h('select', { onchange: e => { f.y = e.target.value || null; redraw(); } }, channelOptions(f.y, { allowHist: f.kind === 'batch' }))));
  if (f.kind === 'batch') {
    ctrl.append(field('Population', h('select', { onchange: e => { f.pop = e.target.value || null; redraw(); } }, popOptions(f.pop))));
    ctrl.append(field('Style', h('select', { onchange: e => { f.plotKind = e.target.value; redraw(); } },
      h('option', { value: 'density', selected: f.plotKind !== 'dot' }, 'Pseudocolor'), h('option', { value: 'dot', selected: f.plotKind === 'dot' }, 'Dot'))));
    ctrl.append(field('Show gates', h('input', { type: 'checkbox', checked: f.showGates !== false, onchange: e => { f.showGates = e.target.checked; redraw(); } })));
  } else {
    if (f.kind === 'overlay-hist') {
      ctrl.append(field('Y scale', h('select', { onchange: e => { f.mode = e.target.value; redraw(); } },
        h('option', { value: 'mode', selected: f.mode === 'mode' }, 'Normalized to mode'), h('option', { value: 'count', selected: f.mode === 'count' }, 'Count'))));
      ctrl.append(field('Offset', h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: f.offset, oninput: e => { f.offset = +e.target.value; redraw(); } })));
      ctrl.append(h('div', { style: 'display:flex;gap:12px' },
        h('label', {}, h('input', { type: 'checkbox', checked: f.smooth, onchange: e => { f.smooth = e.target.checked; redraw(); } }), 'Smooth'),
        h('label', {}, h('input', { type: 'checkbox', checked: f.fill, onchange: e => { f.fill = e.target.checked; redraw(); } }), 'Fill')));
    }
    const list = h('div', { class: 'series-list' });
    const renderSeries = () => {
      list.innerHTML = '';
      f.series.forEach((se, i) => list.append(h('div', { class: 'series-row' },
        h('input', { type: 'color', value: se.color, oninput: e => { se.color = e.target.value; redraw(); } }),
        h('select', { onchange: e => { se.sampleId = e.target.value; redraw(); } }, app.samples.map(s => h('option', { value: s.id, selected: s.id === se.sampleId }, s.name))),
        h('select', { onchange: e => { se.pop = e.target.value || null; redraw(); } }, popOptions(se.pop)),
        h('button', { class: 'icon', title: 'Move up', onclick: () => { if (i) { [f.series[i - 1], f.series[i]] = [f.series[i], f.series[i - 1]]; renderSeries(); redraw(); } } }, '↑'),
        h('button', { class: 'icon', onclick: () => { f.series.splice(i, 1); renderSeries(); redraw(); } }, '×'))));
    };
    renderSeries();
    const popSel = h('select', {}, popOptions(f.series[0]?.pop ?? null));
    ctrl.append(h('div', {}, h('b', {}, 'Series'), ' ', h('small', { class: 'hint' }, '(sample · population)')), list,
      h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' },
        h('button', { class: 'btn small', onclick: () => {
          const s = app.activeSample() || app.samples[0];
          f.series.push({ sampleId: s.id, pop: f.series.at(-1)?.pop ?? null, color: SERIES_COLORS[f.series.length % SERIES_COLORS.length] });
          renderSeries(); redraw();
        } }, '+ Series'),
        h('span', { class: 'hint' }, 'Set all to'), popSel,
        h('button', { class: 'btn small', onclick: () => { f.series = app.samples.map((s, i) => ({ sampleId: s.id, pop: popSel.value || null, color: SERIES_COLORS[i % SERIES_COLORS.length] })); renderSeries(); redraw(); } }, 'All samples'),
        h('button', { class: 'btn small', onclick: () => {
          const s = app.activeSample() || app.samples[0];
          const gates = app.engine.list().filter(g => !popSel.value || g.parent === popSel.value);
          f.series = gates.map((g, i) => ({ sampleId: s.id, pop: g.id, color: g.color || SERIES_COLORS[i % SERIES_COLORS.length] }));
          renderSeries(); redraw();
        }, title: 'One series per child gate of the chosen population (active sample)' }, 'Child gates')));
  }
  ctrl.append(h('div', { class: 'wh', style: 'display:flex;gap:12px' },
    field('W', h('input', { type: 'number', value: f.w, min: 150, max: 1600, step: 10, onchange: e => { f.w = +e.target.value; redraw(); } })),
    field('H', h('input', { type: 'number', value: f.h, min: 150, max: 1600, step: 10, onchange: e => { f.h = +e.target.value; redraw(); } }))));
  const card = h('div', { class: 'figure-card' }, ctrl, out);
  redraw();
  return card;
}

function drawFigure(f, out) {
  out.innerHTML = '';
  if (f.kind === 'batch') {
    const grid = h('div', { class: 'batch-grid' });
    if (f.title) out.append(h('div', { style: 'font-weight:600;margin-bottom:4px' }, f.title));
    for (const s of app.samples) {
      const c = h('canvas');
      const spec = buildSpec(app, s, { pop: f.pop, x: f.x, y: f.y, kind: f.plotKind }, f.w, f.h,
        { title: `${s.name.replace(/\.fcs$/i, '')} (${app.engine.population(s, f.pop).count.toLocaleString()})`, noGates: f.showGates === false, compactLabels: true });
      const ctx = prepareCanvas(c, f.w, f.h);
      if (spec) renderPlot(ctx, spec); else { ctx.fillStyle = '#888'; ctx.fillText(`${s.name}: channel missing`, 10, 20); }
      grid.append(c);
    }
    out.append(grid);
    return;
  }
  const c = h('canvas');
  const ctx = prepareCanvas(c, f.w, f.h);
  const spec = figureSpec(f);
  if (!spec.series.length) { ctx.fillStyle = '#888'; ctx.font = '12px system-ui'; ctx.fillText('No series with this channel', 20, 30); }
  else renderPlot(ctx, spec);
  out.append(c);
}

// Compose all canvases inside an element into one canvas (row-wrapped as laid out on screen)
function figureToCanvas(root) {
  const canvases = [...root.querySelectorAll('canvas')];
  const base = root.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const rects = canvases.map(c => c.getBoundingClientRect());
  const W = Math.max(...rects.map(r => r.right - base.left)), H = Math.max(...rects.map(r => r.bottom - base.top));
  const out = document.createElement('canvas');
  out.width = W * dpr; out.height = H * dpr;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
  canvases.forEach((c, i) => ctx.drawImage(c, (rects[i].left - base.left) * dpr, (rects[i].top - base.top) * dpr, rects[i].width * dpr, rects[i].height * dpr));
  return out;
}

function exportLayout() {
  if (!app.figures.length) return app.toast('No figures in the layout');
  // stack figure outputs vertically
  const outs = $$('#figures .figure-card > div:last-child').map(figureToCanvas);
  const W = Math.max(...outs.map(c => c.width)), gap = 20 * (window.devicePixelRatio || 1);
  const H = outs.reduce((s, c) => s + c.height + gap, gap);
  const big = document.createElement('canvas'); big.width = W + 2 * gap; big.height = H;
  const ctx = big.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, big.width, big.height);
  let y = gap; for (const c of outs) { ctx.drawImage(c, gap, y); y += c.height + gap; }
  big.toBlob(b => download('FlowLite_layout.png', b));
}

// ---------- statistics ----------
function statsColumns() {
  const cfg = app.statsCfg;
  const pops = cfg.pops ?? [null, ...app.engine.list().map(g => g.id)];
  const chans = cfg.channels ?? app.fluorChannels();
  const cols = [];
  for (const pid of pops) {
    const pname = app.engine.fullName(pid);
    for (const sk of cfg.stats) {
      const def = STAT_DEFS.find(d => d.key === sk);
      if (!def) continue;
      if (!def.perChannel) { if (pid === null && sk === 'pctParent') continue; cols.push({ pid, stat: sk, ch: null, label: `${pname} | ${def.label}` }); }
      else for (const ch of chans) cols.push({ pid, stat: sk, ch, label: `${pname} | ${def.label} | ${app.channelLabel(ch)}` });
    }
  }
  return cols;
}

function statsMatrix() {
  const cols = statsColumns();
  const rows = app.samples.map(s => {
    const cache = new Map();
    return [s.name, ...cols.map(c => {
      if (c.pid && !app.engine.get(c.pid)) return NaN;
      if (!c.ch) {
        const st = c.pid ? populationStats(app.engine, s, c.pid) : { count: s.events, pctTotal: 100, pctParent: NaN };
        return st[c.stat];
      }
      if (!s.hasChannel(c.ch)) return NaN;
      const key = (c.pid || '') + '|' + c.ch;
      if (!cache.has(key)) cache.set(key, channelStats(s.column(c.ch), app.engine.population(s, c.pid).idx));
      return cache.get(key)[c.stat];
    })];
  });
  return { cols, rows };
}

const fmtStat = (v, stat) => !Number.isFinite(v) ? '' : stat === 'count' ? String(v) : /pct|cv|rcv/i.test(stat) ? v.toFixed(2) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toPrecision(4);

function renderStatsControls() {
  const box = $('#statsControls');
  box.innerHTML = '';
  const cfg = app.statsCfg;
  const allPops = [null, ...app.engine.list().map(g => g.id)];
  const pops = cfg.pops ?? allPops;
  const chans = cfg.channels ?? app.fluorChannels();
  box.append(
    h('fieldset', {}, h('legend', {}, 'Populations'), allPops.map(pid => h('label', {}, h('input', {
      type: 'checkbox', checked: pops.includes(pid),
      onchange: e => { const cur = new Set(cfg.pops ?? allPops); e.target.checked ? cur.add(pid) : cur.delete(pid); cfg.pops = allPops.filter(p => cur.has(p)); renderStatsTable(); },
    }), app.engine.fullName(pid)))),
    h('fieldset', {}, h('legend', {}, 'Statistics'), STAT_DEFS.map(d => h('label', {}, h('input', {
      type: 'checkbox', checked: cfg.stats.includes(d.key),
      onchange: e => { cfg.stats = STAT_DEFS.map(x => x.key).filter(k => k === d.key ? e.target.checked : cfg.stats.includes(k)); renderStatsTable(); },
    }), d.label))),
    h('fieldset', {}, h('legend', {}, 'Channels (for MFI etc.)'), app.allChannels().map(ch => h('label', {}, h('input', {
      type: 'checkbox', checked: chans.includes(ch),
      onchange: e => { const cur = new Set(cfg.channels ?? app.fluorChannels()); e.target.checked ? cur.add(ch) : cur.delete(ch); cfg.channels = app.allChannels().filter(c => cur.has(c)); renderStatsTable(); },
    }), app.channelLabel(ch)))),
    h('div', { style: 'display:flex;flex-direction:column;gap:6px' },
      h('button', { class: 'btn primary', onclick: exportStatsCSV }, 'Export CSV'),
      h('button', { class: 'btn', onclick: copyStats }, 'Copy (for Excel/Prism)'),
      h('label', {}, 'Layout ', h('select', { onchange: e => { cfg.layout = e.target.value; renderStatsTable(); } },
        [['long', 'Long: row per sample × population'], ['wide', 'Wide: row per sample'], ['transposed', 'Transposed: column per sample']]
          .map(([v, l]) => h('option', { value: v, selected: (cfg.layout || 'long') === v }, l)))),
      h('span', { class: 'hint', style: 'max-width:220px' }, 'MFI values are computed on compensated data (when compensation is on). Geo. mean uses positive events only.')),
  );
}

function statsTableData() {
  const { cols, rows } = statsMatrix();
  const layoutMode = app.statsCfg.layout || 'long';
  if (layoutMode === 'long') {
    // one row per (sample, population); columns = statistic [channel]
    const pops = [...new Set(cols.map(c => c.pid))];
    const statCols = [];
    for (const c of cols) { const k = c.stat + '|' + (c.ch || ''); if (!statCols.some(x => x.k === k)) statCols.push({ k, stat: c.stat, ch: c.ch, label: c.label.split(' | ').slice(1).join(' | ') }); }
    const header = ['Sample', 'Population', ...statCols.map(c => c.label)];
    const body = [];
    rows.forEach(r => pops.forEach(pid => {
      body.push([r[0], app.engine.fullName(pid), ...statCols.map(sc => {
        const ci = cols.findIndex(c => c.pid === pid && c.stat === sc.stat && (c.ch || '') === (sc.ch || ''));
        return ci < 0 ? '' : fmtStat(r[ci + 1], sc.stat);
      })]);
    }));
    return [header, ...body];
  }
  const header = ['Sample', ...cols.map(c => c.label)];
  const body = rows.map(r => [r[0], ...r.slice(1).map((v, i) => fmtStat(v, cols[i].stat))]);
  if (layoutMode === 'wide') return [header, ...body];
  return header.map((_, i) => [header[i], ...body.map(r => r[i])]);
}

function renderStatsTable() {
  const t = $('#statsTable');
  if (!app.samples.length) { t.innerHTML = '<tr><td>No samples loaded.</td></tr>'; return; }
  const [head, ...body] = statsTableData();
  t.innerHTML = '<thead><tr>' + head.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>' +
    body.map(r => '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('') + '</tbody>';
}

function exportStatsCSV() {
  const rows = statsTableData();
  const csv = rows.map(r => r.map(c => /[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\n');
  download('FlowLite_statistics.csv', csv, 'text/csv');
}
function copyStats() {
  const tsv = statsTableData().map(r => r.join('\t')).join('\n');
  navigator.clipboard.writeText(tsv).then(() => app.toast('Table copied'), () => app.toast('Clipboard not available', true));
}

// ---------- modals ----------
function openModal(title, body) {
  $('#modalTitle').textContent = title;
  const b = $('#modalBody'); b.innerHTML = ''; b.append(body);
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; }

function showKeywords(s) {
  const rows = Object.entries(s.text).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v)));
  openModal(`Keywords — ${s.name}`, h('table', { class: 'kw-table' }, rows));
}

function openComp() {
  if (!app.samples.length) return app.toast('Load samples first');
  let s = app.activeSample();
  const body = h('div');
  const draw = () => {
    body.innerHTML = '';
    body.append(h('div', { class: 'row' }, h('label', {}, 'Sample'),
      h('select', { onchange: e => { s = app.sampleById(e.target.value); draw(); } }, app.samples.map(x => h('option', { value: x.id, selected: x === s }, x.name)))));
    if (!s.spill) {
      body.append(h('p', {}, 'This file has no embedded spillover matrix ($SPILLOVER / SPILL). Spectral instruments (e.g. Sony ID7000/SA3800) usually export already-unmixed data, which needs no compensation.'),
        h('button', { class: 'btn', onclick: () => {
          const ch = app.fluorChannels().filter(c => s.hasChannel(c));
          s.setSpill({ names: ch, matrix: ch.map((_, i) => ch.map((_, j) => (i === j ? 1 : 0))) });
          s.setCompEnabled(true); draw();
        } }, 'Create editable identity matrix'));
      return;
    }
    const missing = s.spillMissing();
    if (missing.length) body.append(h('p', { style: 'color:var(--danger)' },
      `The embedded matrix refers to channel(s) not found in this file: ${missing.join(', ')}. Compensation cannot be applied until the names match (edit via Import CSV).`));
    const m = s.spill.matrix.map(r => [...r]);
    const inputs = m.map((row, i) => row.map((v, j) => h('input', {
      type: 'text', value: +v.toFixed(5), class: i !== j && v !== 0 ? 'nz' : '',
      onchange: e => { const val = parseFloat(e.target.value); if (Number.isFinite(val)) m[i][j] = val; e.target.className = i !== j && m[i][j] !== 0 ? 'nz' : ''; },
    })));
    body.append(
      h('div', { class: 'row' }, h('label', {}, 'Compensation'), h('label', {}, h('input', { type: 'checkbox', checked: s.compEnabled, onchange: e => { s.setCompEnabled(e.target.checked); afterDataChange(); } }), ' apply to this sample')),
      h('p', { class: 'hint' }, 'Spillover fractions: row = fluorochrome (source), column = detector. Diagonal should be 1.'),
      h('div', { style: 'overflow:auto;max-height:50vh' }, h('table', { class: 'matrix' },
        h('tr', {}, h('th', {}, ''), s.spill.names.map(n => h('th', {}, app.channelLabel(n)))),
        s.spill.names.map((n, i) => h('tr', {}, h('th', {}, app.channelLabel(n)), inputs[i].map(inp => h('td', {}, inp)))))),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => { s.setSpill({ names: s.spill.names, matrix: m }); afterDataChange(); app.toast('Matrix applied'); } }, 'Apply to this sample'),
        h('button', { class: 'btn', onclick: () => {
          let n = 0;
          for (const o of app.samples) if (s.spill.names.every(c => o.hasChannel(c))) { o.setSpill({ names: [...s.spill.names], matrix: m.map(r => [...r]) }); o.setCompEnabled(true); n++; }
          afterDataChange(); app.toast(`Matrix applied to ${n} sample(s)`);
        } }, 'Apply to all samples'),
        h('button', { class: 'btn', onclick: () => {
          const csv = [['', ...s.spill.names].join(','), ...s.spill.names.map((n, i) => [n, ...m[i]].join(','))].join('\n');
          download('spillover.csv', csv, 'text/csv');
        } }, 'Export CSV'),
        h('label', { class: 'btn' }, 'Import CSV', h('input', { type: 'file', accept: '.csv,.txt', hidden: true, onchange: async e => {
          try {
            const rows = (await e.target.files[0].text()).trim().split(/\r?\n/).map(l => l.split(/[,\t]/).map(x => x.trim().replace(/^"|"$/g, '')));
            const names = rows[0].slice(1); const mat = rows.slice(1).map(r => r.slice(1).map(Number));
            if (!names.every(c => s.hasChannel(c))) throw new Error('matrix channels not found in sample: ' + names.filter(c => !s.hasChannel(c)).join(', '));
            if (mat.length !== names.length || mat.some(r => r.length !== names.length || r.some(v => !Number.isFinite(v)))) throw new Error('matrix must be square and numeric');
            s.setSpill({ names, matrix: mat }); s.setCompEnabled(true); afterDataChange(); draw();
          } catch (err) { app.toast('Import failed: ' + err.message, true); }
        } }))));
  };
  draw();
  openModal('Compensation', body);
}

function afterDataChange() {
  app.engine.invalidate();
  renderAll();
}

function openTransforms(initial) {
  if (!app.samples.length) return app.toast('Load samples first');
  let ch = initial || app.allChannels()[0];
  const body = h('div');
  const draw = () => {
    const cfg = { ...app.getCfg(ch) };
    delete cfg.auto; // anything applied from this dialog is a user choice
    body.innerHTML = '';
    const num = (key, label, step = 'any') => h('div', { class: 'row' }, h('label', {}, label), h('input', { type: 'number', step, value: cfg[key], onchange: e => { cfg[key] = parseFloat(e.target.value); } }));
    body.append(
      h('div', { class: 'row' }, h('label', {}, 'Channel'), h('select', { onchange: e => { ch = e.target.value; draw(); } }, channelOptions(ch))),
      h('div', { class: 'row' }, h('label', {}, 'Scale'), h('select', { onchange: e => {
        const kind = e.target.value;
        const { range } = channelRange(ch);
        app.transforms[ch] = kind === 'logicle' ? (({ auto, ...c }) => c)(defaultTransformFor('FL', range)) : kind === 'arcsinh' ? { kind, cofactor: 150, min: -1000, max: range } : kind === 'log' ? { kind, min: 10, max: range } : { kind, min: 0, max: range };
        afterTransform(); draw();
      } }, [['linear', 'Linear'], ['log', 'Log'], ['logicle', 'Biexponential (Logicle)'], ['arcsinh', 'Arcsinh']].map(([v, l]) => h('option', { value: v, selected: cfg.kind === v }, l)))),
    );
    if (cfg.kind === 'linear' || cfg.kind === 'log') body.append(num('min', 'Minimum'), num('max', 'Maximum'));
    if (cfg.kind === 'arcsinh') body.append(num('cofactor', 'Cofactor'), num('min', 'Minimum'), num('max', 'Maximum'));
    if (cfg.kind === 'logicle') body.append(num('T', 'Top (T)'), num('W', 'Width basis (W)', 0.05), num('M', 'Decades (M)', 0.1), num('A', 'Extra neg. decades (A)', 0.1),
      h('p', { class: 'hint' }, 'Increase W to compress the region around zero (more linear area for spread-out negatives).'));
    body.append(h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => { app.transforms[ch] = cfg; afterTransform(); } }, 'Apply'),
      cfg.kind === 'logicle' ? h('button', { class: 'btn', title: 'Estimate W from the 5th percentile of negative values in the active sample (Parks et al. 2006)', onclick: () => {
        const s = app.activeSample(); const col = s?.column(ch); if (!col) return;
        const negs = []; for (let i = 0; i < col.length; i++) if (col[i] < 0) negs.push(col[i]);
        if (negs.length < 20) { app.toast('Too few negative events to estimate W'); return; }
        negs.sort((a, b) => a - b);
        const r = negs[Math.floor(negs.length * 0.05)];
        const W = Math.max(0, Math.min((cfg.M / 2) - 0.01, (cfg.M - Math.log10(cfg.T / Math.abs(r))) / 2));
        cfg.W = +W.toFixed(2); app.transforms[ch] = cfg; afterTransform(); draw();
      } }, 'Auto W') : null,
      h('button', { class: 'btn', onclick: () => { for (const c of app.fluorChannels()) app.transforms[c] = { ...cfg }; afterTransform(); app.toast('Applied to all fluorescence channels'); } }, 'Apply to all fluorescence channels')));
  };
  draw();
  openModal('Axis scales', body);
}

function afterTransform() { app.engine.invalidate(); renderAll(); }

// ---------- workspace ----------
function saveWorkspace() {
  const byId = id => app.sampleById(id)?.name;
  const ws = {
    app: 'FlowLite', version: 1, saved: new Date().toISOString(),
    transforms: app.transforms,
    gates: app.engine.toJSON(),
    plots: app.plots,
    figures: app.figures.map(f => ({ ...f, series: f.series?.map(se => ({ ...se, sampleName: byId(se.sampleId) })) })),
    statsCfg: app.statsCfg,
    compensation: Object.fromEntries(app.samples.map(s => [s.name, { enabled: s.compEnabled, spill: s.spill }])),
    samples: app.samples.map(s => s.name),
  };
  download('FlowLite_workspace.json', JSON.stringify(ws, null, 1), 'application/json');
}

async function loadWorkspace(file) {
  try {
    const ws = JSON.parse(await file.text());
    if (ws.app !== 'FlowLite') throw new Error('not a FlowLite workspace');
    app.transforms = ws.transforms || {};
    app.engine.load(ws.gates || []);
    app.plots = ws.plots || [];
    app.statsCfg = ws.statsCfg || app.statsCfg;
    const byName = n => app.samples.find(s => s.name === n);
    app.figures = (ws.figures || []).map(f => ({ ...f, series: f.series?.map(se => ({ ...se, sampleId: byName(se.sampleName)?.id })).filter(se => se.sampleId) }));
    for (const [name, c] of Object.entries(ws.compensation || {})) {
      const s = byName(name); if (!s) continue;
      if (c.spill) s.setSpill(c.spill);
      s.setCompEnabled(!!c.enabled && !!s.spill);
    }
    const missing = (ws.samples || []).filter(n => !byName(n));
    app.selectedGate = null;
    afterDataChange();
    app.toast(missing.length ? `Workspace loaded. Not loaded yet: ${missing.join(', ')} — open those FCS files and reload the workspace.` : 'Workspace loaded');
  } catch (err) { app.toast('Could not load workspace: ' + err.message, true); }
}

// ---------- tabs, tools, render ----------
function switchTab(tab) {
  app.tab = tab;
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + tab));
  renderTab();
}

function renderTab() {
  if (app.tab === 'gating') renderGating();
  else if (app.tab === 'layout') renderFigures();
  else { renderStatsControls(); renderStatsTable(); }
}

function renderAll({ keepGating = false } = {}) {
  renderSamples();
  renderGateTree();
  if (keepGating && app.tab === 'gating') app.redrawAll(); else renderTab();
  $('#btnDeleteGate').disabled = !app.selectedGate;
}

function setTool(t) {
  app.tool = t;
  $$('#tools button').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  $$('.plot-card').forEach(c => c.classList.toggle('tool-select', t === 'select'));
  for (const v of app.views.values()) v.cancel();
}

async function loadDemo() {
  await loadBuffers(demoFiles().map(f => ({ name: f.name, buffer: f.buffer })));
}

// ---------- wire up ----------
$('#fileInput').addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });
$('#wsInput').addEventListener('change', e => { if (e.target.files[0]) loadWorkspace(e.target.files[0]); e.target.value = ''; });
$('#btnDemo').addEventListener('click', loadDemo);
$('#btnComp').addEventListener('click', openComp);
$('#btnTransforms').addEventListener('click', () => openTransforms(app.plots.find(p => p.id === app.focusedPlot)?.x));
$('#btnSaveWs').addEventListener('click', saveWorkspace);
$('#btnAddPlot').addEventListener('click', () => {
  if (!app.samples.length) return app.toast('Load samples first');
  const base = app.plots.find(p => p.id === app.focusedPlot) || app.plots.at(-1);
  app.plots.push({ id: uid('p'), pop: app.selectedGate || base?.pop || null, x: base?.x || app.allChannels()[0], y: base ? base.y : app.allChannels()[1], kind: 'density' });
  renderGating();
});
$('#btnDeleteGate').addEventListener('click', () => app.selectedGate && deleteGate(app.selectedGate));
$('#btnExportLayout').addEventListener('click', exportLayout);
$$('.tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$$('#tools button').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
$$('[data-addfig]').forEach(b => b.addEventListener('click', () => addFigure(b.dataset.addfig)));
$('#modalClose').addEventListener('click', closeModal);
$('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });

document.addEventListener('keydown', e => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if (e.key === 'Escape') { closeModal(); for (const v of app.views.values()) v.cancel(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && app.selectedGate) { e.preventDefault(); deleteGate(app.selectedGate); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const map = { v: 'select', r: 'rect', p: 'polygon', e: 'ellipse', q: 'quad', i: 'interval' };
  if (map[e.key.toLowerCase()] && app.tab === 'gating') setTool(map[e.key.toLowerCase()]);
});

// drag & drop
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const files = [...e.dataTransfer.files];
  const ws = files.find(f => f.name.endsWith('.json'));
  loadFiles(files.filter(f => !f.name.endsWith('.json'))).then(() => ws && loadWorkspace(ws));
});

renderAll();
