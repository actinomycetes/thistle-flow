// Thistle Flow application controller.
import { parseFCS, writeFCS } from './fcs.js';
import { Sample } from './model.js';
import { defaultTransformFor } from './transforms.js';
import { GATE_COLORS, STAT_DEFS, channelStats, populationStats } from './gates.js';
import { PlotView, buildSpec, shortLabel, fmtPct, subsampleIdx, PLOT_SIZES, EVENT_LIMITS } from './plotview.js';
import { renderPlot, prepareCanvas, SERIES_COLORS, THEMES, PLOT_KINDS, HIST_OFFSETS, normalizeKind } from './render.js';
import { renderSVG, renderPDF } from './vector.js';
import { demoFiles } from './demo.js';
import { $, $$, h, uid, esc, safeName, dateStamp, toast, openModal, closeModal, modalOpen, choose, popover, closePopover, saveFile, saveDialog, pickFile, pickFiles } from './ui.js';
import { createZip, readZip, isZip } from './zip.js';
import { Workspace } from './workspace.js';
import { renderProperties } from './properties.js';
import { FigureView } from './figureview.js';
import { APP_NAME, APP_VERSION } from './version.js';

const MODE_NAMES = { gating: 'Gating', layout: 'Layout', stats: 'Statistics', properties: 'Properties' };
const fmtEvents = n => (n ? n.toLocaleString() : 'All');

const app = {
  workspaces: [],
  ws: null,
  tool: 'select',
  views: new Map(),
  figDrawing: null, // id of the Layout figure whose Range-gate tool is active
  theme: 'light',
  toast,
};
app.version = APP_VERSION;
window.thistleFlow = app; // handy for debugging from the console

app.activeSample = () => app.ws.activeSample();

// ---------- persistence of per-viewer UI preferences (best effort) ----------
const pref = {
  get(k, d) { try { const v = localStorage.getItem('tf-' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tf-' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// ---------- theme ----------
// Same convention as Thistle Plot: dark by default, 🌙 shown in dark mode and ☀️ in light mode
function applyTheme(t) {
  app.theme = t;
  document.documentElement.dataset.theme = t;
  $('#btnTheme').textContent = t === 'dark' ? '🌙' : '☀️';
  $('#btnTheme').title = `Switch to ${t === 'dark' ? 'light' : 'dark'} mode (exports always use a white background)`;
  pref.set('theme', t);
}

// ---------- workspaces (tabs) ----------
function newWorkspace(name) {
  const ws = new Workspace(name);
  app.workspaces.push(ws);
  switchWorkspace(ws);
  return ws;
}

function switchWorkspace(ws) {
  if (app.ws) app.ws.commit();
  app.ws = ws;
  closePopover();
  renderAll();
}

function renderWsTabs() {
  const nav = $('#wsTabs');
  nav.innerHTML = '';
  for (const ws of app.workspaces) {
    nav.append(h('div', {
      class: 'ws-tab' + (ws === app.ws ? ' active' : ''),
      title: `${ws.name} — ${ws.samples.length} sample(s)${ws.dirty ? ' · unsaved changes' : ''}\nDouble-click to rename`,
      onclick: () => { if (ws !== app.ws) switchWorkspace(ws); },
      ondblclick: () => { const n = prompt('Workspace name', ws.name); if (n && n.trim()) { ws.name = n.trim(); renderWsTabs(); } },
    },
      h('span', { class: 'ws-name' }, ws.name), ws.dirty ? h('span', { class: 'ws-dirty', title: 'Unsaved changes' }, '●') : null,
      h('button', { class: 'icon', title: 'Close workspace', onclick: e => { e.stopPropagation(); closeWorkspace(ws); } }, '×')));
  }
  nav.append(h('button', { class: 'ws-add', title: 'New workspace tab (load another group of samples)', onclick: () => newWorkspace() }, '+'));
}

async function closeWorkspace(ws) {
  if (ws !== app.ws) switchWorkspace(ws);
  ws.commit();
  const choice = await choose('Close workspace', `Save “${ws.name}” before closing? Unsaved gates, settings and edits will be lost.`, [
    { label: 'Cancel', value: 'cancel' }, { label: 'Don’t save', value: 'discard' }, { label: 'Save…', value: 'save', primary: true }]);
  if (!choice || choice === 'cancel') return;
  if (choice === 'save' && !(await app.saveWorkspace(ws))) return;
  const i = app.workspaces.indexOf(ws);
  app.workspaces.splice(i, 1);
  if (!app.workspaces.length) newWorkspace();
  else switchWorkspace(app.workspaces[Math.max(0, i - 1)]);
}

// ---------- undo / redo ----------
let commitT = null;
app.scheduleCommit = (delay = 0) => {
  clearTimeout(commitT);
  commitT = setTimeout(() => { if (app.ws.commit()) renderWsTabs(); updateUndoButtons(); }, delay);
};
function updateUndoButtons() {
  const m = app.ws.tab;
  $('#btnUndo').disabled = !app.ws.canUndo(m) && app.ws.snapshot(m) === app.ws.last[m];
  $('#btnRedo').disabled = !app.ws.canRedo(m);
  $('#btnUndo').title = `Undo in ${MODE_NAMES[m]} (Ctrl+Z)`;
  $('#btnRedo').title = `Redo in ${MODE_NAMES[m]} (Ctrl+Shift+Z)`;
}
function undo() {
  const m = app.ws.tab;
  if (app.ws.undoStep(m)) renderAll(); else toast(`Nothing to undo in ${MODE_NAMES[m]}`);
}
function redo() {
  const m = app.ws.tab;
  if (app.ws.redoStep(m)) renderAll(); else toast(`Nothing to redo in ${MODE_NAMES[m]}`);
}

// ---------- loading ----------
// Parse FCS files into a workspace (no rendering). keyFor(name) can force the sample key
// (used when a missing file is located under a different name). Returns { added, errors }.
function addSamples(ws, items, keyFor) {
  const errors = [], added = [];
  for (const { name, buffer } of items) {
    try {
      const source = { name, data: new Uint8Array(buffer) };
      for (const ds of parseFCS(buffer, name)) {
        if (!ds.events) { errors.push(`${name}: no events`); continue; }
        const s = new Sample(ds);
        s.source = source;
        const k = keyFor?.(ds.name);
        if (k) s.key = k;
        ws.samples.push(s); added.push(s);
      }
    } catch (err) { console.error(err); errors.push(`${name}: ${err.message}`); }
  }
  if (!ws.activeId && ws.samples.length) ws.activeId = ws.samples[0].id;
  ws.refreshAutoTransforms();
  ws.engine.invalidate();
  ws.rebase(); ws.dirty = true; // loading data is not an undoable step
  return { added, errors };
}

const bufferOf = u8 => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer);

async function loadBuffers(items) {
  const ws = app.ws;
  const { added, errors } = addSamples(ws, items);
  if (!ws.plots.length && ws.samples.length) defaultPlots(ws);
  ws.rebase();
  if (errors.length) toast('Could not load: ' + errors.join('; '), true);
  else toast(`Loaded ${added.length} sample(s) into “${ws.name}”`);
  renderAll();
}

async function readFiles(files) {
  return Promise.all([...files].map(async f => ({ name: f.name, buffer: await f.arrayBuffer() })));
}

async function loadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  toast(`Reading ${files.length} file(s)…`);
  await loadBuffers(await readFiles(files));
}

function defaultPlots(ws) {
  const s = ws.samples[0];
  const chans = s.channelNames;
  const find = re => chans.find(c => re.test(c));
  const fsc = find(/^FSC.*-A$/i) || find(/^FSC/i) || find(/^FS/i) || chans[0];
  const ssc = find(/^SSC.*-A$/i) || find(/^SSC/i) || find(/^(BSC|SS)/i) || chans[1] || chans[0];
  const fl = ws.fluorChannels().filter(c => s.hasChannel(c));
  ws.plots.push({ id: uid('p'), pop: null, x: fsc, y: ssc, kind: 'pseudo' });
  if (fl.length >= 2) ws.plots.push({ id: uid('p'), pop: null, x: fl[0], y: fl[1], kind: 'pseudo' });
  if (fl.length) ws.plots.push({ id: uid('p'), pop: null, x: fl[0], y: null, kind: 'pseudo' });
}

// ---------- sample list ----------
function renderSamples() {
  const ws = app.ws;
  const ul = $('#sampleList');
  ul.innerHTML = '';
  $('#sampleCount').textContent = ws.samples.length ? `(${ws.samples.length})` : '';
  $('#dropHint').style.display = ws.samples.length ? 'none' : '';
  for (const s of ws.samples) {
    const compTag = s.spill ? h('span', { class: 'badge' + (s.compEnabled ? '' : ' off'), title: 'Compensation' }, s.compEnabled ? 'comp' : 'uncomp') : null;
    ul.append(h('li', { class: s.id === ws.activeId ? 'active' : '', onclick: () => { ws.activeId = s.id; renderAll(); } },
      h('div', { class: 'meta' },
        h('div', { class: 'name', title: s.name }, s.name),
        h('div', { class: 'sub' }, `${s.events.toLocaleString()} events · ${s.params.length} par · ${s.version}`, compTag),
        h('div', { class: 'sub', title: s.instrument }, s.instrument)),
      h('button', { class: 'icon', title: 'Properties', onclick: e => { e.stopPropagation(); ws.activeId = s.id; switchTab('properties'); } }, 'ⓘ'),
      h('button', { class: 'icon', title: 'Replace this sample’s FCS file (keeps gates and settings)', onclick: async e => {
        e.stopPropagation();
        const f = await pickFile('.fcs,.FCS,.lmd,.LMD');
        if (f) { await replaceSampleFile(ws, s, f); renderAll(); }
      } }, '⇄'),
      h('button', { class: 'icon', title: 'Remove sample', onclick: e => { e.stopPropagation(); removeSample(s.id); } }, '×')));
  }
}

function removeSample(id) {
  const ws = app.ws;
  ws.samples = ws.samples.filter(s => s.id !== id);
  ws.engine.invalidate(id);
  for (const f of ws.figures) if (f.series) f.series = f.series.filter(se => se.sampleId !== id);
  if (ws.activeId === id) ws.activeId = ws.samples[0]?.id || null;
  ws.rebase(); ws.dirty = true; // loading data is not an undoable step
  renderAll();
}

// ---------- gate tree ----------
function renderGateTree() {
  const ws = app.ws, eng = ws.engine;
  const root = $('#gateTree');
  root.innerHTML = '';
  const s = ws.activeSample();
  const node = g => {
    const id = g ? g.id : null;
    let pct = '', count = '';
    if (s) {
      const st = id ? populationStats(eng, s, id) : { count: s.events };
      count = st.count.toLocaleString();
      pct = id ? fmtPct(st.pctParent) : '';
    }
    const row = h('div', {
      class: 'node' + (ws.selectedGate === id && id ? ' selected' : ''),
      onclick: () => app.selectGate(id),
      ondblclick: () => { if (g) app.renameGate(g); },
      title: id ? eng.fullName(id) : 'All Events',
    },
      h('span', { class: 'swatch', style: `background:${g ? g.color : '#999'}` }),
      h('span', { class: 'gname' }, g ? g.name : 'All Events'),
      h('span', { class: 'gpct' }, pct ? `${pct} · ${count}` : count),
      h('button', { class: 'icon', title: 'Open plot of this population', onclick: e => { e.stopPropagation(); openPopulationPlot(id); } }, '＋'),
      s ? h('button', { class: 'icon', title: 'Export events of this population (FCS)', onclick: e => { e.stopPropagation(); exportPopulation(s, id); } }, '⤓') : null,
      g ? h('button', { class: 'icon', title: 'Delete gate', onclick: e => { e.stopPropagation(); deleteGate(g.id); } }, '×') : null);
    const kids = eng.children(id);
    const li = h('li', {}, row);
    if (kids.length) li.append(h('ul', {}, kids.map(node)));
    return li;
  };
  root.append(h('ul', {}, node(null)));
}

app.renameGate = g => {
  const name = prompt('Gate name', g.name);
  if (name && name.trim()) { g.name = name.trim(); renderAll(); }
};

function deleteGate(id) {
  const ws = app.ws, eng = ws.engine;
  const g = eng.get(id); if (!g) return;
  const nKids = eng.list().filter(x => eng.path(x.id).some(p => p.id === id)).length - 1;
  if (nKids > 0 && !confirm(`Delete "${g.name}" and its ${nKids} descendant gate(s)?`)) return;
  eng.remove(id);
  const exists = gid => !gid || eng.get(gid);
  ws.plots.forEach(p => { if (!exists(p.pop)) p.pop = g.parent && exists(g.parent) ? g.parent : null; });
  ws.figures.forEach(f => { if (!exists(f.pop)) f.pop = null; (f.series || []).forEach(se => { if (!exists(se.pop)) se.pop = null; }); });
  if (ws.statsCfg.pops) ws.statsCfg.pops = ws.statsCfg.pops.filter(exists);
  if (!exists(ws.selectedGate)) ws.selectedGate = null;
  renderAll();
}

function openPopulationPlot(id) {
  const ws = app.ws;
  const g = id ? ws.engine.get(id) : null;
  const base = ws.plots.find(p => p.id === ws.focusedPlot) || ws.plots[0];
  ws.plots.push({ id: uid('p'), pop: id, x: g?.x || base?.x || ws.allChannels()[0], y: g ? (g.y || null) : (base?.y ?? null), kind: 'pseudo' });
  switchTab('gating');
}

function exportPopulation(s, gateId) {
  const ws = app.ws;
  const pop = ws.engine.population(s, gateId);
  const cols = s.raw.map(c => { const o = new Float32Array(pop.count); for (let i = 0; i < pop.count; i++) o[i] = c[pop.idx[i]]; return o; });
  // carry over (edited) metadata; layout keywords are rewritten by the writer
  const extra = {};
  for (const [k, v] of Object.entries(s.text)) {
    if (Sample.isStructural(k) || /^\$P\d+[NS]$/.test(k) || /^(\$SPILLOVER|SPILL|SPILLOVER|\$COMP)$/.test(k)) continue;
    extra[k] = v;
  }
  if (s.spill) extra['$SPILLOVER'] = [s.spill.names.length, ...s.spill.names, ...s.spill.matrix.flat()].join(',');
  const popName = gateId ? ws.engine.fullName(gateId).replace(/[\\/:*?"<>|]+/g, '_') : 'All';
  extra['$FIL'] = `${s.name.replace(/\.fcs$/i, '')}_${popName}.fcs`;
  const buf = writeFCS({ names: s.channelNames, labels: s.params.map(p => p.label), columns: cols, ranges: s.params.map(p => p.range), extraText: extra });
  saveFile(extra['$FIL'], buf, 'fcs');
}

// ---------- gating tab ----------
function channelOptions(sel, { allowHist = false } = {}) {
  const ws = app.ws;
  const opts = ws.allChannels().map(c => h('option', { value: c, selected: c === sel }, ws.channelLabel(c)));
  if (allowHist) opts.push(h('option', { value: '', selected: !sel }, '— Histogram —'));
  return opts;
}
function popOptions(sel) {
  const eng = app.ws.engine;
  const out = [h('option', { value: '', selected: !sel }, 'All Events')];
  const walk = (pid, depth) => eng.children(pid).forEach(g => {
    out.push(h('option', { value: g.id, selected: g.id === sel }, '  '.repeat(depth) + g.name));
    walk(g.id, depth + 1);
  });
  walk(null, 1);
  return out;
}
function kindOptions(sel) { return PLOT_KINDS.map(([v, l]) => h('option', { value: v, selected: normalizeKind(sel) === v }, l)); }
function eventLimitOptions(sel, { withDefault = false } = {}) {
  const out = withDefault ? [h('option', { value: 'default', selected: sel === undefined || sel === null }, `Workspace default (${fmtEvents(app.ws.displayMax)})`)] : [];
  for (const n of EVENT_LIMITS) out.push(h('option', { value: n, selected: sel === n }, n ? n.toLocaleString() : 'All events'));
  return out;
}

// Plots a settings change should apply to: the whole selection if this plot is part of it
function targetsFor(p) {
  const ws = app.ws;
  return ws.selPlots.has(p.id) && ws.selPlots.size > 1 ? ws.plots.filter(q => ws.selPlots.has(q.id)) : [p];
}
function applyPlots(p, fn, { full = false } = {}) {
  const targets = targetsFor(p);
  targets.forEach(fn);
  if (full || targets.length > 1) renderGating(); else app.views.get(p.id)?.draw();
}

function renderGating() {
  const ws = app.ws;
  const grid = $('#plotGrid');
  grid.innerHTML = '';
  app.views.clear();
  const s = ws.activeSample();
  $('#activeSampleInfo').textContent = s ? `Active sample: ${s.name}` : '';
  $('#displayMax').replaceChildren(...eventLimitOptions(ws.displayMax));
  if (!ws.samples.length) {
    grid.append(h('div', { class: 'empty-state' },
      h('h2', {}, 'Lightweight flow cytometry analysis'),
      h('p', {}, 'Open or drop FCS files exported from BD (FACSDiva/FACSuite), Attune NxT, Sony spectral analysers, CytoFLEX, Cytek, etc. Everything runs locally in your browser — no data is uploaded.'),
      h('p', {}, h('button', { class: 'btn primary', onclick: () => $('#fileInput').click() }, 'Open FCS files…'), ' ',
        h('button', { class: 'btn', onclick: loadDemo }, 'Try demo data')),
      h('p', { class: 'hint' }, 'Use the + tab above to analyse another group of samples side by side.')));
    updateSelectionUI();
    return;
  }
  for (const p of ws.plots) {
    const canvas = h('canvas');
    const btnSettings = h('button', { class: 'icon', title: 'Plot settings (type, events shown, size, axis scales)' }, '⚙');
    const btnExport = h('button', { class: 'icon', title: 'Export plot (PNG / SVG / PDF)' }, '⤓');
    btnSettings.addEventListener('click', () => plotSettings(p, btnSettings));
    btnExport.addEventListener('click', () => exportMenu(btnExport, `${s.name.replace(/\.fcs$/i, '')}_${p.x}${p.y ? '_' + p.y : ''}`, () => plotComposite(p)));
    const card = h('div', {
      class: 'plot-card' + (p.id === ws.focusedPlot ? ' focused' : '') + (ws.selPlots.has(p.id) ? ' selected' : ''),
      'data-plot': p.id,
      onmousedown: e => { if (e.target.closest('.plot-head') && !e.target.closest('select,button')) app.plotClicked(p.id, e); },
    },
      h('div', { class: 'plot-head' },
        h('select', { title: 'Population (parent gate)', onchange: e => applyPlots(p, q => { q.pop = e.target.value || null; }) }, popOptions(p.pop)),
        h('select', { title: 'X axis', onchange: e => applyPlots(p, q => { q.x = e.target.value; }) }, channelOptions(p.x)),
        h('select', { title: 'Y axis', onchange: e => applyPlots(p, q => { q.y = e.target.value || null; }, { full: true }) }, channelOptions(p.y, { allowHist: true })),
        p.y ? h('select', { title: 'Plot type', onchange: e => applyPlots(p, q => { q.kind = e.target.value; }) }, kindOptions(p.kind)) : null,
        h('span', { class: 'grow' }), btnSettings, btnExport,
        h('button', { class: 'icon', title: 'Close plot', onclick: () => { ws.plots = ws.plots.filter(q => q.id !== p.id); ws.selPlots.delete(p.id); renderGating(); } }, '×')),
      canvas);
    grid.append(card);
    const view = new PlotView(app, p, canvas);
    card.style.width = (view.w + 14) + 'px';
    app.views.set(p.id, view);
    view.draw();
  }
  updateSelectionUI();
}

function plotSettings(p, anchor) {
  const n = targetsFor(p).length;
  const set = fn => applyPlots(p, fn, { full: true });
  const body = h('div', { class: 'pop-form' },
    h('div', { class: 'pop-title' }, n > 1 ? `Settings for ${n} selected plots` : 'Plot settings'),
    p.y ? h('label', {}, h('span', {}, 'Type'), h('select', { onchange: e => set(q => { if (q.y) q.kind = e.target.value; }) }, kindOptions(p.kind))) : null,
    p.y ? h('label', {}, h('span', {}, 'Events shown'), h('select', { onchange: e => set(q => { q.maxEvents = e.target.value === 'default' ? undefined : +e.target.value; }) }, eventLimitOptions(p.maxEvents, { withDefault: true }))) : null,
    h('label', {}, h('span', {}, 'Size'), h('select', { onchange: e => set(q => { q.size = e.target.value; }) },
      Object.keys(PLOT_SIZES).map(k => h('option', { value: k, selected: (p.size || 'M') === k }, `${k} (${PLOT_SIZES[k][0]}×${PLOT_SIZES[k][1]})`)))),
    p.y ? h('label', {}, h('span', {}, 'Contour step'), h('select', { onchange: e => set(q => { q.contourStep = +e.target.value; }) },
      [[0.05, '5% of events'], [0.1, '10%'], [0.2, '20%']].map(([v, l]) => h('option', { value: v, selected: (p.contourStep || 0.1) === v }, l)))) : null,
    p.y ? h('label', {}, h('span', {}, 'Outliers'), h('input', { type: 'checkbox', checked: p.outliers !== false, onchange: e => set(q => { q.outliers = e.target.checked; }) }), h('small', { class: 'hint' }, 'dots outside contours')) : null,
    !p.y ? h('label', {}, h('span', {}, 'Smooth'), h('input', { type: 'checkbox', checked: p.smooth !== false, onchange: e => set(q => { q.smooth = e.target.checked; }) })) : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: () => { closePopover(); app.openScale(p.x, 'x'); } }, 'X axis scale…'),
      p.y ? h('button', { class: 'btn small', onclick: () => { closePopover(); app.openScale(p.y, 'y'); } }, 'Y axis scale…') : null),
    h('div', { class: 'hint-box' }, n > 1 ? 'Changes apply to all selected plots.' : 'Tip: shift-click plots or drag a box around them to change several at once.'));
  popover(anchor, body);
}

// ---- plot selection (shift-click, rubber band) ----
app.plotClicked = (id, e, { keepSelection = false } = {}) => {
  const ws = app.ws;
  ws.focusedPlot = id;
  if (e && e.shiftKey && !keepSelection) { if (ws.selPlots.has(id)) ws.selPlots.delete(id); else ws.selPlots.add(id); }
  else if (!ws.selPlots.has(id)) ws.selPlots = new Set([id]);
  updateSelectionUI();
};
function updateSelectionUI() {
  const ws = app.ws;
  $$('.plot-card').forEach(c => { c.classList.toggle('selected', ws.selPlots.has(c.dataset.plot)); c.classList.toggle('focused', c.dataset.plot === ws.focusedPlot); });
  const n = ws.selPlots.size;
  const info = $('#selInfo');
  info.hidden = n < 2;
  if (n >= 2) info.replaceChildren(`${n} plots selected — settings changes apply to all `,
    h('button', { class: 'btn small', onclick: () => { ws.selPlots.clear(); updateSelectionUI(); } }, 'Clear'));
}
function setupRubberBand() {
  const grid = $('#plotGrid');
  grid.addEventListener('mousedown', e => {
    if (e.target !== grid || e.button !== 0) return;
    e.preventDefault();
    const r = grid.getBoundingClientRect();
    const start = [e.clientX - r.left + grid.scrollLeft, e.clientY - r.top + grid.scrollTop];
    const base = e.shiftKey ? new Set(app.ws.selPlots) : new Set();
    const band = h('div', { class: 'rubber-band' });
    grid.append(band);
    const move = ev => {
      const x = ev.clientX - r.left + grid.scrollLeft, y = ev.clientY - r.top + grid.scrollTop;
      const [x0, y0] = [Math.min(x, start[0]), Math.min(y, start[1])], [x1, y1] = [Math.max(x, start[0]), Math.max(y, start[1])];
      Object.assign(band.style, { left: x0 + 'px', top: y0 + 'px', width: (x1 - x0) + 'px', height: (y1 - y0) + 'px' });
      const sel = new Set(base);
      for (const c of $$('.plot-card', grid)) {
        const cx0 = c.offsetLeft, cy0 = c.offsetTop, cx1 = cx0 + c.offsetWidth, cy1 = cy0 + c.offsetHeight;
        if (cx0 < x1 && cx1 > x0 && cy0 < y1 && cy1 > y0) sel.add(c.dataset.plot);
      }
      app.ws.selPlots = sel; updateSelectionUI();
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); band.remove(); updateSelectionUI(); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    move(e);
  });
}

app.redrawAll = () => { for (const v of app.views.values()) v.draw(); renderGateTree(); };

app.selectGate = (id, { quiet = false } = {}) => {
  app.ws.selectedGate = id || null;
  $('#btnDeleteGate').disabled = !app.ws.selectedGate;
  if (!quiet) app.redrawAll(); else renderGateTree();
};

function nextColor() { return GATE_COLORS[app.ws.engine.list().length % GATE_COLORS.length]; }

app.createGate = (def, geom) => {
  const ws = app.ws, s = ws.activeSample();
  let suggestion = `Gate ${ws.engine.list().length + 1}`;
  if (geom.type === 'interval') suggestion = `${shortLabel(s, def.x)}+`;
  else if (/^FSC/i.test(def.x) && /^FSC/i.test(def.y || '')) suggestion = 'Singlets';
  else if (/^FSC/i.test(def.x) && /^SSC/i.test(def.y || '')) suggestion = ws.engine.children(def.pop).length ? 'Cells' : 'Lymphocytes';
  const name = prompt('Name this gate', suggestion);
  setTool('select'); // after drawing a gate, go back to Select so it (and its label) can be adjusted
  if (name === null) { app.redrawAll(); return; }
  const g = { id: uid('g'), name: name.trim() || suggestion, parent: def.pop || null, x: def.x, y: def.y || null, color: nextColor(), ...geom };
  ws.engine.add(g);
  ws.selectedGate = g.id;
  renderAll();
};

app.createQuadrant = (def, [cx, cy]) => {
  const ws = app.ws, s = ws.activeSample();
  const xl = shortLabel(s, def.x), yl = shortLabel(s, def.y);
  const group = uid('q');
  const color = nextColor();
  const names = { UL: `${xl}- ${yl}+`, UR: `${xl}+ ${yl}+`, LR: `${xl}+ ${yl}-`, LL: `${xl}- ${yl}-` };
  let first;
  for (const q of ['UL', 'UR', 'LR', 'LL']) {
    const g = { id: uid('g'), name: names[q], parent: def.pop || null, type: 'quad', q, group, x: def.x, y: def.y, cx, cy, color };
    ws.engine.add(g); first = first || g;
  }
  ws.selectedGate = first.id;
  setTool('select');
  renderAll();
};

// During drags only descendants of the changed gate need recomputation.
app.gateChanged = (g, { live = false } = {}) => {
  if (!g) return;
  const eng = app.ws.engine;
  const affected = new Set();
  for (const x of eng.list()) if (eng.path(x.id).some(p => p.id === g.id || (g.group && p.group === g.group))) affected.add(x.id);
  for (const sc of eng.cache.values()) for (const id of affected) sc.delete(id);
  if (live) return;
  renderAll({ keepGating: true });
};

app.drillDown = (gate, fromDef) => {
  const ws = app.ws;
  const fl = ws.fluorChannels();
  let x = fromDef.x, y = fromDef.y;
  if (/^FSC/i.test(x) && /^SSC/i.test(y || '')) {
    const fsch = ws.allChannels().find(c => /^FSC.*-H$/i.test(c));
    if (fsch && !ws.engine.list().some(g => g.parent === gate.id)) { x = fromDef.x; y = fsch; }
    else if (fl.length >= 2) { x = fl[0]; y = fl[1]; }
  } else if (/^FSC/i.test(x) && /^FSC/i.test(y || '') && fl.length >= 2) { x = fl[0]; y = fl[1]; }
  ws.plots.push({ id: uid('p'), pop: gate.id, x, y, kind: fromDef.kind || 'pseudo', maxEvents: fromDef.maxEvents, size: fromDef.size });
  renderGating();
  $('#plotGrid').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

// ---------- export (PNG / SVG / PDF) ----------
// A composite is { w, h, items: [{ spec, x, y }], texts: [{ text, x, y }] } drawn with the light theme.
function drawComposite(ctx, comp) {
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, comp.w, comp.h);
  for (const t of comp.texts || []) {
    ctx.fillStyle = '#222'; ctx.font = '600 13px Helvetica, Arial, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(t.text, t.x, t.y);
  }
  for (const it of comp.items) { ctx.save(); ctx.translate(it.x, it.y); renderPlot(ctx, it.spec); ctx.restore(); }
}
async function exportComposite(comp, baseName, fmt) {
  if (!comp || !comp.items.length) return toast('Nothing to export', true);
  const name = `${safeName(baseName)}_${dateStamp()}.${fmt}`;
  if (fmt === 'svg') return saveFile(name, renderSVG(comp.w, comp.h, ctx => drawComposite(ctx, comp)), 'svg');
  if (fmt === 'pdf') return saveFile(name, renderPDF(comp.w, comp.h, ctx => drawComposite(ctx, comp)), 'pdf');
  const scale = 3; // ~300 dpi at typical figure sizes
  const c = document.createElement('canvas'); c.width = Math.round(comp.w * scale); c.height = Math.round(comp.h * scale);
  const ctx = c.getContext('2d'); ctx.scale(scale, scale);
  drawComposite(ctx, comp);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return saveFile(name, blob, 'png');
}
function exportMenu(anchor, baseName, makeComposite) {
  const pick = fmt => { closePopover(); exportComposite(makeComposite(), baseName, fmt); };
  popover(anchor, h('div', { class: 'pop-form' }, h('div', { class: 'pop-title' }, 'Export'),
    h('button', { class: 'btn', onclick: () => pick('png') }, 'PNG (high resolution)'),
    h('button', { class: 'btn', onclick: () => pick('svg') }, 'SVG (vector)'),
    h('button', { class: 'btn', onclick: () => pick('pdf') }, 'PDF (vector)'),
    h('p', { class: 'hint' }, 'Exports use a white background. Density images are embedded as bitmaps; axes, gates, contours and text are vector.')));
}
function plotComposite(p) {
  const v = app.views.get(p.id);
  const spec = buildSpec(app.ws, app.ws.activeSample(), p, v.w, v.h, { selectedGate: null });
  return spec ? { w: v.w, h: v.h, items: [{ spec, x: 0, y: 0 }] } : null;
}

// ---------- layout / figures ----------
function addFigure(kind) {
  const ws = app.ws;
  if (!ws.samples.length) return toast('Load samples first');
  const fl = ws.fluorChannels();
  const x = fl[0] || ws.allChannels()[0];
  const pop = ws.selectedGate || null;
  const f = { id: uid('f'), kind, x, y: kind === 'overlay-hist' ? null : (fl[1] || ws.allChannels()[1]), pop, title: '', mode: 'mode', offset: 0, smooth: true, fill: true, w: 440, h: 340, plotKind: 'pseudo' };
  if (kind !== 'batch') f.series = ws.samples.map((s, i) => ({ sampleId: s.id, pop, color: SERIES_COLORS[i % SERIES_COLORS.length] }));
  else { f.w = 230; f.h = 220; f.y = ws.plots.find(p => p.id === ws.focusedPlot)?.y ?? f.y; }
  ws.figures.push(f);
  renderFigures();
}

function seriesLabel(se) {
  const ws = app.ws, s = ws.sampleById(se.sampleId);
  if (!s) return '(missing sample)';
  return se.label || (s.name.replace(/\.fcs$/i, '') + (se.pop && ws.engine.get(se.pop) ? ` · ${ws.engine.get(se.pop).name}` : ''));
}

function figureSpec(f, theme) {
  const ws = app.ws;
  const cfgX = ws.getCfg(f.x), cfgY = f.y ? ws.getCfg(f.y) : null;
  const series = [];
  const max = f.maxEvents ?? ws.displayMax;
  f.series.forEach((se, si) => {
    const s = ws.sampleById(se.sampleId);
    if (!s || !s.hasChannel(f.x) || (f.y && !s.hasChannel(f.y))) return;
    if (se.pop && !ws.engine.get(se.pop)) return;
    const pop = ws.engine.population(s, se.pop);
    const idx = f.kind === 'overlay-hist' ? pop.idx : subsampleIdx(pop.idx, max);
    series.push({ ux: s.unit(f.x, cfgX), uy: f.y ? s.unit(f.y, cfgY) : null, idx, color: se.color, label: seriesLabel(se), labelPos: se.labelPos, si });
  });
  return {
    w: f.w, h: f.h, theme, kind: f.kind === 'overlay-hist' ? 'histogram' : 'dot', title: f.title,
    x: { name: f.x, label: ws.channelLabel(f.x), cfg: cfgX }, y: f.y ? { name: f.y, label: ws.channelLabel(f.y), cfg: cfgY } : null,
    series, labels: { mode: f.labelMode || 'inside', legendPos: f.legendPos }, gateLabels: f.gateLabels !== false,
    hist: { mode: f.mode, offset: f.offset, smooth: f.smooth, fill: f.fill },
    gates: f.kind === 'overlay-hist' && f.showGates !== false ? overlayGates(f) : [],
  };
}

// The population every series of an overlay is drawn from (range gates are created under it),
// or undefined when the series mix populations.
function overlayParent(f) {
  const ws = app.ws;
  const pops = new Set((f.series || []).filter(se => ws.sampleById(se.sampleId) && (!se.pop || ws.engine.get(se.pop))).map(se => se.pop || null));
  return pops.size === 1 ? [...pops][0] : undefined;
}

// Range gates on an overlay: one gate, with the % of each overlaid sample listed in its colour
function overlayGates(f) {
  const ws = app.ws, parent = overlayParent(f);
  if (parent === undefined) return [];
  const series = f.series.filter(se => ws.sampleById(se.sampleId)?.hasChannel(f.x));
  return ws.engine.children(parent).filter(g => g.type === 'interval' && g.x === f.x).map(g => ({
    gate: g, color: g.color, text: g.name, selected: ws.selectedGate === g.id, labelPos: f.labelPos?.[g.id],
    lines: [{ text: g.name, color: g.color }, ...series.map(se => {
      const s = ws.sampleById(se.sampleId);
      return { text: `${se.label || s.name.replace(/\.fcs$/i, '')}  ${fmtPct(populationStats(ws.engine, s, g.id).pctParent)}`, color: se.color };
    })],
  }));
}

app.createFigureGate = (f, geom) => {
  const ws = app.ws, parent = overlayParent(f);
  app.figDrawing = null;
  if (parent === undefined) { toast('The series use different populations, so one gate cannot cover them all.', true); renderFigures(); return; }
  const s = ws.activeSample() || ws.samples[0];
  const suggestion = `${shortLabel(s, f.x)}+`;
  const name = prompt('Name this gate (it applies to every sample)', suggestion);
  if (name === null) { renderFigures(); return; }
  const g = { id: uid('g'), name: name.trim() || suggestion, parent, type: 'interval', x: f.x, y: null, color: nextColor(), ...geom };
  ws.engine.add(g);
  ws.selectedGate = g.id;
  renderAll();
  toast(`Gate “${g.name}” added for all samples — it also appears in the gate tree and Statistics`);
};

function batchSpec(f, s, theme) {
  const ws = app.ws;
  const pop = f.pop && ws.engine.get(f.pop) ? f.pop : null;
  const spec = buildSpec(ws, s, { pop, x: f.x, y: f.y, kind: f.plotKind, maxEvents: f.maxEvents }, f.w, f.h, {
    theme, title: `${s.name.replace(/\.fcs$/i, '')} (${ws.engine.population(s, pop).count.toLocaleString()})`,
    noGates: f.showGates === false, compactLabels: true, selectedGate: ws.selectedGate,
  });
  if (spec) {
    for (const it of spec.gates) it.labelPos = f.labelPos?.[it.gate.id]; // positions are per figure
    spec.gateLabels = f.gateLabels !== false;
  }
  return spec;
}

// Composite (for export) of a figure, laid out as on screen
function figureComposite(f, out) {
  const base = out.getBoundingClientRect();
  const items = [], texts = [];
  let W = 0, H = 0;
  if (f.kind === 'batch') {
    if (f.title) { texts.push({ text: f.title, x: 0, y: 0 }); H = 18; }
    for (const c of out.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect();
      const s = app.ws.sampleById(c.dataset.sample);
      const spec = s && batchSpec(f, s, THEMES.light);
      if (!spec) continue;
      const x = r.left - base.left, y = r.top - base.top;
      items.push({ spec, x, y }); W = Math.max(W, x + f.w); H = Math.max(H, y + f.h);
    }
  } else {
    const spec = figureSpec(f, THEMES.light);
    if (spec.series.length) items.push({ spec, x: 0, y: 0 });
    W = f.w; H = f.h;
  }
  return { w: Math.ceil(W), h: Math.ceil(H), items, texts };
}

function renderFigures() {
  const ws = app.ws;
  const root = $('#figures');
  root.innerHTML = '';
  if (!ws.figures.length) {
    root.append(h('div', { class: 'empty-state' }, h('h2', {}, 'Layouts & overlays'),
      h('p', {}, 'Build publication-style figures: overlay histograms of several samples/populations (normalised to mode, with half or full offset), overlay dot plots coloured by sample, or a batch row showing the same plot for every sample. Export each figure or the whole layout as PNG, SVG or PDF.')));
    return;
  }
  for (const f of ws.figures) root.append(figureCard(f));
}

function figureCard(f) {
  const ws = app.ws;
  const ctrl = h('div', { class: 'fig-controls' });
  const out = h('div', { class: 'fig-out' });
  const rangeRow = h('div');
  const redraw = () => { drawFigure(f, out); if (f.kind === 'overlay-hist') updateRangeRow(f, rangeRow); };
  const field = (label, el) => h('label', {}, h('span', {}, label), el);
  const resetLabelsBtn = () => h('button', { class: 'btn small', title: 'Put all labels of this figure back in their default places', onclick: () => {
    delete f.labelPos; delete f.legendPos; (f.series || []).forEach(se => delete se.labelPos); redraw();
  } }, 'Reset label positions');
  const kindName = { 'overlay-hist': 'Histogram overlay', 'overlay-dot': 'Dot-plot overlay', batch: 'Batch' }[f.kind];
  const btnExport = h('button', { class: 'btn small' }, 'Export ▾');
  btnExport.addEventListener('click', () => exportMenu(btnExport, f.title || kindName, () => figureComposite(f, out)));
  ctrl.append(h('div', { style: 'display:flex;align-items:center;gap:6px' }, h('b', { style: 'flex:1' }, kindName), btnExport,
    h('button', { class: 'icon', title: 'Remove', onclick: () => { ws.figures = ws.figures.filter(x => x !== f); renderFigures(); } }, '×')));
  ctrl.append(field('Title', h('input', { type: 'text', value: f.title, placeholder: '(optional)', oninput: e => { f.title = e.target.value; redraw(); } })));
  ctrl.append(field('X', h('select', { onchange: e => { f.x = e.target.value; redraw(); } }, channelOptions(f.x))));
  if (f.kind !== 'overlay-hist') ctrl.append(field('Y', h('select', { onchange: e => { f.y = e.target.value || null; redraw(); } }, channelOptions(f.y, { allowHist: f.kind === 'batch' }))));
  if (f.kind !== 'overlay-hist') ctrl.append(field('Events', h('select', { title: 'Events shown per plot / series', onchange: e => { f.maxEvents = e.target.value === 'default' ? undefined : +e.target.value; redraw(); } }, eventLimitOptions(f.maxEvents, { withDefault: true }))));
  if (f.kind === 'batch') {
    ctrl.append(field('Population', h('select', { onchange: e => { f.pop = e.target.value || null; redraw(); } }, popOptions(f.pop))));
    ctrl.append(field('Style', h('select', { onchange: e => { f.plotKind = e.target.value; redraw(); } }, kindOptions(f.plotKind))));
    ctrl.append(h('div', { style: 'display:flex;gap:12px' },
      h('label', {}, h('input', { type: 'checkbox', checked: f.showGates !== false, onchange: e => { f.showGates = e.target.checked; redraw(); } }), 'Gates'),
      h('label', {}, h('input', { type: 'checkbox', checked: f.gateLabels !== false, onchange: e => { f.gateLabels = e.target.checked; redraw(); } }), 'Gate labels'),
      resetLabelsBtn()));
  } else {
    if (f.kind === 'overlay-hist') {
      ctrl.append(field('Y scale', h('select', { onchange: e => { f.mode = e.target.value; redraw(); } },
        h('option', { value: 'mode', selected: f.mode === 'mode' }, 'Normalized to mode'), h('option', { value: 'count', selected: f.mode === 'count' }, 'Count'))));
      const isPreset = () => HIST_OFFSETS.some(([v]) => v === f.offset);
      const preset = h('select', { onchange: e => { if (e.target.value !== 'custom') { f.offset = +e.target.value; slider.value = f.offset; } slider.hidden = e.target.value !== 'custom' && isPreset(); redraw(); } },
        HIST_OFFSETS.map(([v, l]) => h('option', { value: v, selected: f.offset === v }, l)),
        h('option', { value: 'custom', selected: !isPreset() }, 'Custom…'));
      const slider = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: f.offset, hidden: isPreset(), title: 'Custom offset', oninput: e => { f.offset = +e.target.value; redraw(); } });
      ctrl.append(field('Offset', preset), h('label', {}, h('span', {}, ''), slider));
      ctrl.append(h('div', { style: 'display:flex;gap:12px' },
        h('label', {}, h('input', { type: 'checkbox', checked: f.smooth, onchange: e => { f.smooth = e.target.checked; redraw(); } }), 'Smooth'),
        h('label', {}, h('input', { type: 'checkbox', checked: f.fill, onchange: e => { f.fill = e.target.checked; redraw(); } }), 'Fill'),
        h('label', {}, h('input', { type: 'checkbox', checked: f.showGates !== false, onchange: e => { f.showGates = e.target.checked; redraw(); } }), 'Gates'),
        h('label', {}, h('input', { type: 'checkbox', checked: f.gateLabels !== false, onchange: e => { f.gateLabels = e.target.checked; redraw(); } }), 'Gate labels')));
      // refreshed on every redraw, so it follows changes to the series' populations
      ctrl.append(rangeRow);
    }
    ctrl.append(field('Labels', h('select', { title: 'Sample labels / legend', onchange: e => { f.labelMode = e.target.value; redraw(); } },
      [['inside', 'In the plot (drag to move)'], ['outside', 'Outside, right'], ['off', 'Off']].map(([v, l]) => h('option', { value: v, selected: (f.labelMode || 'inside') === v }, l)))),
      h('div', { style: 'display:flex;justify-content:flex-end' }, resetLabelsBtn()));
    const list = h('div', { class: 'series-list' });
    const renderSeries = () => {
      list.innerHTML = '';
      f.series.forEach((se, i) => list.append(h('div', { class: 'series-row' },
        h('input', { type: 'color', value: se.color, oninput: e => { se.color = e.target.value; redraw(); } }),
        h('select', { onchange: e => { se.sampleId = e.target.value; redraw(); } }, ws.samples.map(s => h('option', { value: s.id, selected: s.id === se.sampleId }, s.name))),
        h('select', { onchange: e => { se.pop = e.target.value || null; redraw(); } }, popOptions(se.pop)),
        h('button', { class: 'icon', title: 'Move up', onclick: () => { if (i) { [f.series[i - 1], f.series[i]] = [f.series[i], f.series[i - 1]]; renderSeries(); redraw(); } } }, '↑'),
        h('button', { class: 'icon', onclick: () => { f.series.splice(i, 1); renderSeries(); redraw(); } }, '×'))));
    };
    renderSeries();
    const popSel = h('select', {}, popOptions(f.series[0]?.pop ?? null));
    ctrl.append(h('div', {}, h('b', {}, 'Series'), ' ', h('small', { class: 'hint' }, '(sample · population)')), list,
      h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' },
        h('button', { class: 'btn small', onclick: () => {
          const s = ws.activeSample() || ws.samples[0];
          f.series.push({ sampleId: s.id, pop: f.series.at(-1)?.pop ?? null, color: SERIES_COLORS[f.series.length % SERIES_COLORS.length] });
          renderSeries(); redraw();
        } }, '+ Series'),
        h('span', { class: 'hint' }, 'Set all to'), popSel,
        h('button', { class: 'btn small', onclick: () => { f.series = ws.samples.map((s, i) => ({ sampleId: s.id, pop: popSel.value || null, color: SERIES_COLORS[i % SERIES_COLORS.length] })); renderSeries(); redraw(); } }, 'All samples'),
        h('button', { class: 'btn small', title: 'One series per child gate of the chosen population (active sample)', onclick: () => {
          const s = ws.activeSample() || ws.samples[0];
          const gates = ws.engine.list().filter(g => !popSel.value || g.parent === popSel.value);
          f.series = gates.map((g, i) => ({ sampleId: s.id, pop: g.id, color: g.color || SERIES_COLORS[i % SERIES_COLORS.length] }));
          renderSeries(); redraw();
        } }, 'Child gates')));
  }
  ctrl.append(h('div', { class: 'wh', style: 'display:flex;gap:12px' },
    field('W', h('input', { type: 'number', value: f.w, min: 150, max: 1600, step: 10, onchange: e => { f.w = +e.target.value; redraw(); } })),
    field('H', h('input', { type: 'number', value: f.h, min: 150, max: 1600, step: 10, onchange: e => { f.h = +e.target.value; redraw(); } }))));
  const card = h('div', { class: 'figure-card', 'data-fig': f.id }, ctrl, out);
  redraw();
  return card;
}

function updateRangeRow(f, row) {
  const drawing = app.figDrawing === f.id;
  const parent = overlayParent(f);
  const why = !f.series?.length ? 'Add series first' : 'The series use different populations; set them all to one (e.g. with “Set all to”)';
  row.replaceChildren(
    h('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' },
      h('button', {
        class: 'btn small' + (drawing ? ' primary' : ''), disabled: parent === undefined,
        title: parent === undefined ? why : 'Drag across the histogram to draw one range gate that applies to every sample',
        onclick: () => { app.figDrawing = drawing ? null : f.id; renderFigures(); },
      }, drawing ? '↔ Drawing… (Esc to cancel)' : '↔ Range gate'),
      h('span', { class: 'hint' }, parent === undefined ? why : `gate goes under ${app.ws.engine.fullName(parent)}`)),
    drawing ? h('div', { class: 'hint-box' }, 'Drag across the overlay. The gate is shared by all samples, so each sample’s % is shown in its colour. Drag the label to move it, or the gate ends to adjust.') : '');
}

function drawFigure(f, out) {
  const ws = app.ws, theme = THEMES[app.theme];
  out.innerHTML = '';
  if (f.kind === 'batch') {
    const grid = h('div', { class: 'batch-grid' });
    if (f.title) out.append(h('div', { class: 'fig-title' }, f.title));
    for (const s of ws.samples) {
      const c = h('canvas', { 'data-sample': s.id, title: 'Drag a gate label to move it (in every plot of this figure)' });
      grid.append(c);
      new FigureView(app, f, c, () => batchSpec(f, s, theme) || `${s.name}: channel missing`, { onLabelDone: () => drawFigure(f, out) }).draw();
    }
    out.append(grid);
    return;
  }
  const c = h('canvas');
  out.append(c);
  const view = new FigureView(app, f, c, () => { const spec = figureSpec(f, theme); return spec.series.length ? spec : 'No series with this channel'; },
    { editable: f.kind === 'overlay-hist' });
  view.draw();
}

function layoutComposite() {
  const gap = 24;
  let y = 0, W = 0;
  const items = [], texts = [];
  for (const card of $$('#figures .figure-card')) {
    const f = app.ws.figures.find(x => x.id === card.dataset.fig);
    if (!f) continue;
    const c = figureComposite(f, card.querySelector('.fig-out'));
    if (!c.items.length) continue;
    c.items.forEach(it => items.push({ ...it, y: it.y + y }));
    c.texts.forEach(t => texts.push({ ...t, y: t.y + y }));
    W = Math.max(W, c.w); y += c.h + gap;
  }
  return { w: W, h: Math.max(0, y - gap), items, texts };
}

// ---------- statistics ----------
function statsColumns() {
  const ws = app.ws, cfg = ws.statsCfg;
  const pops = (cfg.pops ?? [null, ...ws.engine.list().map(g => g.id)]).filter(pid => !pid || ws.engine.get(pid));
  const chans = cfg.channels ?? ws.fluorChannels();
  const cols = [];
  for (const pid of pops) {
    const pname = ws.engine.fullName(pid);
    for (const sk of cfg.stats) {
      const def = STAT_DEFS.find(d => d.key === sk);
      if (!def) continue;
      if (!def.perChannel) { if (pid === null && sk === 'pctParent') continue; cols.push({ pid, stat: sk, ch: null, label: `${pname} | ${def.label}` }); }
      else for (const ch of chans) cols.push({ pid, stat: sk, ch, label: `${pname} | ${def.label} | ${ws.channelLabel(ch)}` });
    }
  }
  return cols;
}

function statsMatrix() {
  const ws = app.ws;
  const cols = statsColumns();
  const rows = ws.samples.map(s => {
    const cache = new Map();
    return [s.name, ...cols.map(c => {
      if (!c.ch) {
        const st = c.pid ? populationStats(ws.engine, s, c.pid) : { count: s.events, pctTotal: 100, pctParent: NaN };
        return st[c.stat];
      }
      if (!s.hasChannel(c.ch)) return NaN;
      const key = (c.pid || '') + '|' + c.ch;
      if (!cache.has(key)) cache.set(key, channelStats(s.column(c.ch), ws.engine.population(s, c.pid).idx));
      return cache.get(key)[c.stat];
    })];
  });
  return { cols, rows };
}

const fmtStat = (v, stat) => !Number.isFinite(v) ? '' : stat === 'count' ? String(v) : /pct|cv|rcv/i.test(stat) ? v.toFixed(2) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toPrecision(4);

function renderStatsControls() {
  const ws = app.ws;
  const box = $('#statsControls');
  box.innerHTML = '';
  const cfg = ws.statsCfg;
  const allPops = [null, ...ws.engine.list().map(g => g.id)];
  const pops = cfg.pops ?? allPops;
  const chans = cfg.channels ?? ws.fluorChannels();
  box.append(
    h('fieldset', {}, h('legend', {}, 'Populations'), allPops.map(pid => h('label', {}, h('input', {
      type: 'checkbox', checked: pops.includes(pid),
      onchange: e => { const cur = new Set(cfg.pops ?? allPops); e.target.checked ? cur.add(pid) : cur.delete(pid); cfg.pops = allPops.filter(p => cur.has(p)); renderStatsTable(); },
    }), ws.engine.fullName(pid)))),
    h('fieldset', {}, h('legend', {}, 'Statistics'), STAT_DEFS.map(d => h('label', {}, h('input', {
      type: 'checkbox', checked: cfg.stats.includes(d.key),
      onchange: e => { cfg.stats = STAT_DEFS.map(x => x.key).filter(k => k === d.key ? e.target.checked : cfg.stats.includes(k)); renderStatsTable(); },
    }), d.label))),
    h('fieldset', {}, h('legend', {}, 'Channels (for MFI etc.)'), ws.allChannels().map(ch => h('label', {}, h('input', {
      type: 'checkbox', checked: chans.includes(ch),
      onchange: e => { const cur = new Set(cfg.channels ?? ws.fluorChannels()); e.target.checked ? cur.add(ch) : cur.delete(ch); cfg.channels = ws.allChannels().filter(c => cur.has(c)); renderStatsTable(); },
    }), ws.channelLabel(ch)))),
    h('div', { style: 'display:flex;flex-direction:column;gap:6px' },
      h('button', { class: 'btn primary', onclick: exportStatsCSV }, 'Export CSV…'),
      h('button', { class: 'btn', onclick: copyStats }, 'Copy (for Excel/Prism)'),
      h('label', {}, 'Layout ', h('select', { onchange: e => { cfg.layout = e.target.value; renderStatsTable(); } },
        [['long', 'Long: row per sample × population'], ['wide', 'Wide: row per sample'], ['transposed', 'Transposed: column per sample']]
          .map(([v, l]) => h('option', { value: v, selected: (cfg.layout || 'long') === v }, l)))),
      h('div', { class: 'hint-box', style: 'max-width:240px' }, 'MFI values are computed on compensated data (when compensation is on). Geo. mean uses positive events only.')));
}

function statsTableData() {
  const ws = app.ws;
  const { cols, rows } = statsMatrix();
  const layoutMode = ws.statsCfg.layout || 'long';
  if (layoutMode === 'long') {
    const pops = [...new Set(cols.map(c => c.pid))];
    const statCols = [];
    for (const c of cols) { const k = c.stat + '|' + (c.ch || ''); if (!statCols.some(x => x.k === k)) statCols.push({ k, stat: c.stat, ch: c.ch, label: c.label.split(' | ').slice(1).join(' | ') }); }
    const header = ['Sample', 'Population', ...statCols.map(c => c.label)];
    const body = [];
    rows.forEach(r => pops.forEach(pid => {
      body.push([r[0], ws.engine.fullName(pid), ...statCols.map(sc => {
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
  if (!app.ws.samples.length) { t.innerHTML = '<tr><td>No samples loaded.</td></tr>'; return; }
  const [head, ...body] = statsTableData();
  t.innerHTML = '<thead><tr>' + head.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>' +
    body.map(r => '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('') + '</tbody>';
}

function exportStatsCSV() {
  const rows = statsTableData();
  const csv = rows.map(r => r.map(c => /[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\n');
  saveFile(`${safeName(app.ws.name)}_statistics_${dateStamp()}.csv`, csv, 'csv');
}
function copyStats() {
  const tsv = statsTableData().map(r => r.join('\t')).join('\n');
  navigator.clipboard.writeText(tsv).then(() => toast('Table copied'), () => toast('Clipboard not available', true));
}

// ---------- compensation & axis scales ----------
function openComp() {
  const ws = app.ws;
  if (!ws.samples.length) return toast('Load samples first');
  let s = ws.activeSample();
  const body = h('div');
  const draw = () => {
    body.innerHTML = '';
    body.append(h('div', { class: 'row' }, h('label', {}, 'Sample'),
      h('select', { onchange: e => { s = ws.sampleById(e.target.value); draw(); } }, ws.samples.map(x => h('option', { value: x.id, selected: x === s }, x.name)))));
    if (!s.spill) {
      body.append(h('p', {}, 'This file has no embedded spillover matrix ($SPILLOVER / SPILL). Spectral instruments (e.g. Sony ID7000/SA3800) usually export already-unmixed data, which needs no compensation.'),
        h('button', { class: 'btn', onclick: () => {
          const ch = ws.fluorChannels().filter(c => s.hasChannel(c));
          s.setSpill({ names: ch, matrix: ch.map((_, i) => ch.map((_, j) => (i === j ? 1 : 0))) });
          s.setCompEnabled(true); afterDataChange(); draw();
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
        h('tr', {}, h('th', {}, ''), s.spill.names.map(n => h('th', {}, ws.channelLabel(n)))),
        s.spill.names.map((n, i) => h('tr', {}, h('th', {}, ws.channelLabel(n)), inputs[i].map(inp => h('td', {}, inp)))))),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => { s.setSpill({ names: s.spill.names, matrix: m }); afterDataChange(); toast('Matrix applied'); } }, 'Apply to this sample'),
        h('button', { class: 'btn', onclick: () => {
          let n = 0;
          for (const o of ws.samples) if (s.spill.names.every(c => o.hasChannel(c))) { o.setSpill({ names: [...s.spill.names], matrix: m.map(r => [...r]) }); o.setCompEnabled(true); n++; }
          afterDataChange(); toast(`Matrix applied to ${n} sample(s)`);
        } }, 'Apply to all samples'),
        h('button', { class: 'btn', onclick: () => {
          const csv = [['', ...s.spill.names].join(','), ...s.spill.names.map((n, i) => [n, ...m[i]].join(','))].join('\n');
          saveFile(`spillover_${safeName(s.name)}_${dateStamp()}.csv`, csv, 'csv');
        } }, 'Export CSV'),
        h('label', { class: 'btn' }, 'Import CSV', h('input', { type: 'file', accept: '.csv,.txt', hidden: true, onchange: async e => {
          try {
            const rows = (await e.target.files[0].text()).trim().split(/\r?\n/).map(l => l.split(/[,\t]/).map(x => x.trim().replace(/^"|"$/g, '')));
            const names = rows[0].slice(1); const mat = rows.slice(1).map(r => r.slice(1).map(Number));
            if (!names.every(c => s.hasChannel(c))) throw new Error('matrix channels not found in sample: ' + names.filter(c => !s.hasChannel(c)).join(', '));
            if (mat.length !== names.length || mat.some(r => r.length !== names.length || r.some(v => !Number.isFinite(v)))) throw new Error('matrix must be square and numeric');
            s.setSpill({ names, matrix: mat }); s.setCompEnabled(true); afterDataChange(); draw();
          } catch (err) { toast('Import failed: ' + err.message, true); }
        } }))));
  };
  draw();
  openModal('Compensation', body, { wide: true });
}

function afterDataChange() { app.ws.engine.invalidate(); app.scheduleCommit(); renderAll(); }

app.openScale = (ch, axis) => openTransforms(ch, axis);

function openTransforms(initial, axis) {
  const ws = app.ws;
  if (!ws.samples.length) return toast('Load samples first');
  let ch = initial || ws.allChannels()[0];
  const body = h('div');
  const draw = () => {
    const cfg = { ...ws.getCfg(ch) };
    delete cfg.auto; // anything applied from this dialog is a user choice
    body.innerHTML = '';
    const apply = () => { ws.transforms[ch] = { ...cfg }; afterTransform(); };
    const num = (key, label, step = 'any') => h('div', { class: 'row' }, h('label', {}, label), h('input', { type: 'number', step, value: cfg[key], onchange: e => { cfg[key] = parseFloat(e.target.value); apply(); } }));
    body.append(
      axis ? h('p', { class: 'hint', style: 'margin-top:0' }, `Scales are set per channel, so every plot (and gate) using ${ws.channelLabel(ch)} follows this setting.`) : null,
      h('div', { class: 'row' }, h('label', {}, 'Channel'), h('select', { onchange: e => { ch = e.target.value; draw(); } }, channelOptions(ch))),
      h('div', { class: 'row' }, h('label', {}, 'Scale'), h('select', { onchange: e => {
        const kind = e.target.value;
        const { range } = ws.channelRange(ch);
        ws.transforms[ch] = kind === 'logicle' ? (({ auto, ...c }) => c)(defaultTransformFor('FL', range)) : kind === 'arcsinh' ? { kind, cofactor: 150, min: -1000, max: range } : kind === 'log' ? { kind, min: 10, max: range } : { kind, min: 0, max: range };
        afterTransform(); draw();
      } }, [['linear', 'Linear'], ['log', 'Log'], ['logicle', 'Biexponential (Logicle)'], ['arcsinh', 'Arcsinh']].map(([v, l]) => h('option', { value: v, selected: cfg.kind === v }, l)))));
    if (cfg.kind === 'linear' || cfg.kind === 'log') body.append(num('min', 'Minimum'), num('max', 'Maximum'));
    if (cfg.kind === 'arcsinh') body.append(num('cofactor', 'Cofactor'), num('min', 'Minimum'), num('max', 'Maximum'));
    if (cfg.kind === 'logicle') body.append(num('T', 'Top (T)'), num('W', 'Width basis (W)', 0.05), num('M', 'Decades (M)', 0.1), num('A', 'Extra neg. decades (A)', 0.1),
      h('p', { class: 'hint' }, 'Increase W to compress the region around zero (more linear area for spread-out negatives).'));
    body.append(h('div', { class: 'row' },
      cfg.kind === 'logicle' ? h('button', { class: 'btn', title: 'Estimate W from the 5th percentile of negative values in the active sample (Parks et al. 2006)', onclick: () => {
        const s = ws.activeSample(); const col = s?.column(ch); if (!col) return;
        const negs = []; for (let i = 0; i < col.length; i++) if (col[i] < 0) negs.push(col[i]);
        if (negs.length < 20) { toast('Too few negative events to estimate W'); return; }
        negs.sort((a, b) => a - b);
        const r = negs[Math.floor(negs.length * 0.05)];
        cfg.W = +Math.max(0, Math.min((cfg.M / 2) - 0.01, (cfg.M - Math.log10(cfg.T / Math.abs(r))) / 2)).toFixed(2);
        apply(); draw();
      } }, 'Auto W') : null,
      h('button', { class: 'btn', onclick: () => { for (const c of ws.fluorChannels()) ws.transforms[c] = { ...cfg }; afterTransform(); toast('Applied to all fluorescence channels'); } }, 'Apply to all fluorescence channels'),
      h('button', { class: 'btn primary', onclick: closeModal }, 'Done')));
  };
  draw();
  openModal(axis ? `${axis.toUpperCase()} axis scale` : 'Axis scales', body);
}

function afterTransform() { app.ws.engine.invalidate(); app.scheduleCommit(); renderAll(); }

// ---------- workspace files & templates ----------
const fmtMB = n => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

// Workspace + original FCS files in one zip: workspace.json, fcs/<file>
async function workspaceBundle(ws) {
  const files = ws.sourceFiles();
  const used = new Set(), entryOf = new Map();
  for (const f of files) {
    let name = `fcs/${f.name}`, k = 2;
    while (used.has(name.toLowerCase())) name = `fcs/${f.name.replace(/(\.[^.]*)?$/, m => ` (${k++})${m}`)}`;
    used.add(name.toLowerCase()); entryOf.set(f, name);
  }
  const data = ws.serialize();
  data.files = files.map(f => ({ entry: entryOf.get(f), name: f.name }));
  return createZip([{ name: 'workspace.json', data: JSON.stringify(data, null, 1) }, ...files.map(f => ({ name: entryOf.get(f), data: f.data }))]);
}

app.saveWorkspace = async (ws = app.ws) => {
  ws.commit();
  const files = ws.sourceFiles();
  const canBundle = ws.samples.length > 0 && ws.samples.every(s => s.source);
  const size = files.reduce((t, f) => t + f.data.length, 0);
  const include = h('input', { type: 'checkbox', checked: canBundle, disabled: !canBundle });
  const name = await saveDialog({
    title: 'Save workspace', baseName: `${ws.name}`, ext: () => (include.checked ? 'zip' : 'json'),
    note: 'A workspace stores gates, scales, plots, layouts, statistics settings, compensation and metadata edits. With the FCS files included it is one .zip that reopens with all its samples; without them it is a small .json that needs the FCS files next to it.',
    extra: h('label', { class: 'row' }, include, canBundle
      ? ` Include the ${files.length} FCS file${files.length === 1 ? '' : 's'} (${fmtMB(size)} before compression)`
      : ' Include the FCS files (not available: no samples loaded)'),
    makeData: async () => (include.checked ? new Blob([await workspaceBundle(ws)], { type: 'application/zip' }) : JSON.stringify(ws.serialize(), null, 1)),
  });
  if (name) { ws.dirty = false; renderWsTabs(); }
  return name;
};

// Pick the tab to load a workspace into: the current one if it is empty or already holds
// these samples, otherwise a new tab.
function targetWorkspace(data) {
  const ws = app.ws;
  const keys = Workspace.savedKeys(data);
  const matches = keys.filter(k => ws.samples.some(s => s.key === k || s.name === k));
  if (!ws.samples.length || matches.length) return ws;
  return newWorkspace(data.name);
}

async function loadWorkspaceFile(file) {
  try {
    const u8 = new Uint8Array(await file.arrayBuffer());
    if (isZip(u8)) return await loadBundle(u8);
    const data = JSON.parse(new TextDecoder().decode(u8));
    if (data.kind === 'template') return applyTemplateData(data);
    const ws = targetWorkspace(data);
    const missing = ws.deserialize(data);
    ws.rebase(); ws.dirty = false;
    renderAll();
    if (missing.length) locateDialog(ws, data, missing);
    else toast('Workspace loaded');
  } catch (err) { console.error(err); toast('Could not load workspace: ' + err.message, true); }
}

async function loadBundle(u8) {
  toast('Opening workspace bundle…');
  const entries = await readZip(u8);
  const wsEntry = entries.find(e => e.name === 'workspace.json');
  if (!wsEntry) throw new Error('this zip is not a Thistle Flow workspace (no workspace.json)');
  const data = JSON.parse(new TextDecoder().decode(wsEntry.data));
  const ws = app.ws.samples.length ? newWorkspace(data.name) : app.ws;
  const names = new Map((data.files || []).map(f => [f.entry, f.name]));
  const items = entries.filter(e => e.name.startsWith('fcs/')).map(e => ({ name: names.get(e.name) || e.name.slice(4), buffer: bufferOf(e.data) }));
  const { errors } = addSamples(ws, items);
  const missing = ws.deserialize(data);
  ws.rebase(); ws.dirty = false;
  renderAll();
  if (errors.length) toast('Could not read: ' + errors.join('; '), true);
  else if (missing.length) locateDialog(ws, data, missing);
  else toast(`Workspace “${ws.name}” opened with ${ws.samples.length} sample(s)`);
}

// Missing FCS files: browsers cannot open files next to the workspace on their own, so the user
// picks the folder (all matching file names are loaded) or each file (any name).
function locateDialog(ws, data, missingKeys) {
  const want = new Set(missingKeys);
  const fileOf = new Map((data.version >= 2 ? data.samples || [] : []).map(e => [e.key, e.file || e.key.replace(/ \[\d+\]$/, '')]));
  const baseOf = k => (fileOf.get(k) || k.replace(/ \[\d+\]$/, '')).toLowerCase();
  const body = h('div');
  const finish = msg => {
    const still = ws.deserialize(data);
    ws.rebase(); ws.dirty = false;
    want.clear(); still.forEach(k => want.add(k));
    renderAll();
    draw();
    if (msg) toast(msg);
    if (!want.size) { closeModal(); toast('All samples found — workspace complete'); }
  };
  const loadMatching = async files => {
    const fcs = files.filter(f => /\.(fcs|lmd)$/i.test(f.name));
    const byName = new Map(fcs.map(f => [f.name.toLowerCase(), f]));
    const pick = new Set();
    for (const k of want) { const f = byName.get(baseOf(k)); if (f) pick.add(f); }
    if (!pick.size) { toast(`None of the ${fcs.length} FCS file(s) there has a matching name`, true); return; }
    const { errors } = addSamples(ws, await readFiles([...pick]));
    if (errors.length) toast('Could not load: ' + errors.join('; '), true);
    finish(`Loaded ${pick.size} file(s)`);
  };
  const draw = () => {
    body.replaceChildren(
      h('div', { class: 'hint-box', style: 'margin:0 0 10px;max-width:560px' },
        'This workspace was saved without its FCS files, and a browser cannot open files next to it by itself. ',
        h('b', {}, 'Choose the folder'), ' that holds the FCS files (every file with a matching name is loaded), or choose each file. A file with a different name can be assigned with ', h('b', {}, 'Choose…'), '.'),
      want.size ? h('table', { class: 'prop-table', style: 'max-width:560px' },
        h('tr', {}, h('th', {}, 'Missing sample'), h('th', {}, 'Expected file'), h('th', {})),
        [...want].map(k => h('tr', {}, h('td', {}, k), h('td', { class: 'hint' }, fileOf.get(k) || k.replace(/ \[\d+\]$/, '')),
          h('td', {}, h('button', { class: 'btn small', onclick: async () => {
            const f = await pickFile('.fcs,.FCS,.lmd,.LMD');
            if (!f) return;
            const { errors } = addSamples(ws, await readFiles([f]), name => {
              const m = / \[(\d+)\]$/.exec(k), dm = / \[(\d+)\]$/.exec(name);
              return (m ? m[1] : '1') === (dm ? dm[1] : '1') ? k : null; // assign the matching dataset to this key
            });
            if (errors.length) toast('Could not load: ' + errors.join('; '), true);
            finish(`Assigned ${f.name} to ${k}`);
          } }, 'Choose…'))))) : h('p', {}, 'All samples found.'),
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px' },
        h('button', { class: 'btn primary', onclick: async () => loadMatching(await pickFiles({ folder: true })) }, '📂 Choose folder…'),
        h('button', { class: 'btn', onclick: async () => loadMatching(await pickFiles({ accept: '.fcs,.FCS,.lmd,.LMD' })) }, 'Choose files…'),
        h('button', { class: 'btn', onclick: closeModal }, want.size ? 'Later' : 'Done')));
  };
  draw();
  openModal(`Find the FCS files for “${ws.name}”`, body, { wide: true });
}

// Swap a sample's data file, keeping its identity (gates, figures, edits) where the channels allow
async function replaceSampleFile(ws, old, file, key) {
  try {
    const buffer = await file.arrayBuffer();
    const sets = parseFCS(buffer, file.name);
    const m = / \[(\d+)\]$/.exec(old.key);
    const ds = sets[m ? Math.min(sets.length, +m[1]) - 1 : 0];
    const ns = new Sample(ds);
    ns.id = old.id;
    ns.source = { name: file.name, data: new Uint8Array(buffer) };
    if (key) ns.key = key;
    if (old.spill && old.spill.names.every(c => ns.hasChannel(c))) { ns.setSpill(old.spill); ns.setCompEnabled(old.compEnabled); }
    ns.applyEdits({ ...old.edits, name: null });
    const missingCh = old.channelNames.filter(c => !ns.hasChannel(c));
    ws.samples[ws.samples.indexOf(old)] = ns;
    ws.engine.invalidate(old.id);
    ws.refreshAutoTransforms();
    ws.rebase(); ws.dirty = true;
    toast(missingCh.length ? `Replaced with ${file.name}. Channels not in the new file: ${missingCh.join(', ')}` : `Replaced ${old.name} with ${file.name}`, missingCh.length > 0);
  } catch (err) { toast('Could not replace the file: ' + err.message, true); }
}

async function saveTemplate() {
  const ws = app.ws;
  const includeComp = h('input', { type: 'checkbox', checked: !!ws.activeSample()?.spill });
  await saveDialog({
    title: 'Save analysis template', baseName: `${ws.name}_template`, ext: 'json',
    note: 'A template holds the gates, axis scales, plots, layout figures, statistics settings and marker labels — no sample data and no file references — so it can be applied to new samples in any workspace.',
    extra: h('label', { class: 'row' }, includeComp, ' Include the compensation matrix of the active sample'),
    makeData: () => JSON.stringify(ws.template({ includeComp: includeComp.checked }), null, 1),
  });
}

async function applyTemplate() {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  try { await applyTemplateData(JSON.parse(await file.text())); } catch (err) { toast('Could not apply template: ' + err.message, true); }
}
async function applyTemplateData(t) {
  const ws = app.ws;
  if (t.kind !== 'template') throw new Error('this file is a workspace, not a template (use Load workspace)');
  if (ws.engine.list().length || ws.figures.length) {
    const ok = await choose('Apply template', `Replace the gates, plots and figures in “${ws.name}” with the template “${t.name || 'template'}”? You can undo this.`,
      [{ label: 'Cancel', value: false }, { label: 'Replace', value: true, primary: true }]);
    if (!ok) return;
  }
  const { compApplied } = ws.applyTemplate(t, SERIES_COLORS);
  app.scheduleCommit();
  renderAll();
  toast(`Template applied${t.compensation ? ` (compensation set on ${compApplied} sample(s))` : ''}`);
}

// ---------- tabs, tools, render ----------
function switchTab(tab) {
  app.ws.tab = tab;
  closePopover();
  renderAll();
}

function renderTab() {
  const tab = app.ws.tab;
  $$('.tabs button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + tab));
  if (tab === 'gating') renderGating();
  else if (tab === 'layout') renderFigures();
  else if (tab === 'stats') { renderStatsControls(); renderStatsTable(); }
  else renderProperties(app, $('#propsRoot'));
}

function renderAll({ keepGating = false } = {}) {
  renderWsTabs();
  renderSamples();
  renderGateTree();
  if (keepGating && app.ws.tab === 'gating') app.redrawAll(); else renderTab();
  $('#btnDeleteGate').disabled = !app.ws.selectedGate;
  updateUndoButtons();
}
app.renderAll = renderAll;
app.metaChanged = () => { app.ws.engine.invalidate(); app.scheduleCommit(); renderAll(); };

function setTool(t) {
  app.tool = t;
  $$('#tools button').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  for (const v of app.views.values()) v.cancel();
}
app.setTool = setTool;

async function loadDemo() {
  await loadBuffers(demoFiles().map(f => ({ name: f.name, buffer: f.buffer })));
}

// ---------- resizable panes ----------
function setupSplitters() {
  const side = $('#sidebar'), samples = $('#secSamples');
  const w = pref.get('sidebarW', null), sh = pref.get('samplesH', null);
  if (w) side.style.width = w + 'px';
  if (sh) samples.style.height = sh + 'px';
  const drag = (el, onMove, onEnd) => el.addEventListener('mousedown', e => {
    e.preventDefault();
    document.body.classList.add('resizing');
    const up = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', up); document.body.classList.remove('resizing'); onEnd(); };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', up);
  });
  drag($('#mainSplit'), e => { side.style.width = Math.max(180, Math.min(window.innerWidth * 0.6, e.clientX - side.getBoundingClientRect().left)) + 'px'; },
    () => pref.set('sidebarW', side.offsetWidth));
  drag($('#sideSplit'), e => { samples.style.height = Math.max(80, Math.min(side.clientHeight - 120, e.clientY - samples.getBoundingClientRect().top)) + 'px'; },
    () => pref.set('samplesH', samples.offsetHeight));
  $('#mainSplit').addEventListener('dblclick', () => { side.style.width = ''; pref.set('sidebarW', null); });
  $('#sideSplit').addEventListener('dblclick', () => { samples.style.height = ''; pref.set('samplesH', null); });
}

// ---------- wire up ----------
$('#fileInput').addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });
$('#wsInput').addEventListener('change', e => { if (e.target.files[0]) loadWorkspaceFile(e.target.files[0]); e.target.value = ''; });
$('#btnDemo').addEventListener('click', loadDemo);
$('#btnComp').addEventListener('click', openComp);
$('#btnTransforms').addEventListener('click', () => openTransforms(app.ws.plots.find(p => p.id === app.ws.focusedPlot)?.x));
$('#btnSaveWs').addEventListener('click', () => app.saveWorkspace());
$('#btnSaveTpl').addEventListener('click', saveTemplate);
$('#btnApplyTpl').addEventListener('click', applyTemplate);
$('#btnTheme').addEventListener('click', () => { applyTheme(app.theme === 'dark' ? 'light' : 'dark'); renderTab(); });
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);
$('#displayMax').addEventListener('change', e => { app.ws.displayMax = +e.target.value; renderGating(); });
$('#btnAddPlot').addEventListener('click', () => {
  const ws = app.ws;
  if (!ws.samples.length) return toast('Load samples first');
  const base = ws.plots.find(p => p.id === ws.focusedPlot) || ws.plots.at(-1);
  ws.plots.push({ id: uid('p'), pop: ws.selectedGate || base?.pop || null, x: base?.x || ws.allChannels()[0], y: base ? base.y : ws.allChannels()[1], kind: base?.kind || 'pseudo', size: base?.size });
  renderGating();
});
$('#btnDeleteGate').addEventListener('click', () => app.ws.selectedGate && deleteGate(app.ws.selectedGate));
$('#btnExportLayout').addEventListener('click', e => {
  if (!app.ws.figures.length) return toast('No figures in the layout');
  exportMenu(e.currentTarget, `${app.ws.name}_layout`, layoutComposite);
});
$$('.tabs button[data-tab]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$$('#tools button').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
$$('[data-addfig]').forEach(b => b.addEventListener('click', () => addFigure(b.dataset.addfig)));
$('#modalClose').addEventListener('click', closeModal);
$('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });

// Any user interaction may have changed the analysis; commit() records it for undo if so.
for (const ev of ['change', 'click', 'mouseup', 'keyup', 'drop']) document.addEventListener(ev, () => app.scheduleCommit(0));
document.addEventListener('input', () => app.scheduleCommit(600));

document.addEventListener('keydown', e => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'F1') { e.preventDefault(); window.open($('#helpLink').href, '_blank', 'noopener'); return; }
  if (mod && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); app.saveWorkspace(); return; }
  if (typing) return;
  if (e.key === 'Escape') {
    if (modalOpen()) { closeModal(); return; }
    closePopover();
    for (const v of app.views.values()) v.cancel();
    if (app.figDrawing) { app.figDrawing = null; renderFigures(); }
    if (app.ws.selPlots.size) { app.ws.selPlots.clear(); updateSelectionUI(); }
    return;
  }
  if (modalOpen()) return;
  if (mod && e.key.toLowerCase() === 'a' && app.ws.tab === 'gating') { e.preventDefault(); app.ws.selPlots = new Set(app.ws.plots.map(p => p.id)); updateSelectionUI(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    if (app.ws.selectedGate) deleteGate(app.ws.selectedGate);
    else if (app.ws.tab === 'gating' && app.ws.selPlots.size) {
      const n = app.ws.selPlots.size;
      if (n > 1 && !confirm(`Close ${n} selected plots?`)) return;
      app.ws.plots = app.ws.plots.filter(p => !app.ws.selPlots.has(p.id)); app.ws.selPlots.clear(); renderGating();
    }
    return;
  }
  if (mod || e.altKey) return;
  const map = { v: 'select', r: 'rect', p: 'polygon', e: 'ellipse', q: 'quad', i: 'interval' };
  if (map[e.key.toLowerCase()] && app.ws.tab === 'gating') setTool(map[e.key.toLowerCase()]);
});

window.addEventListener('beforeunload', e => {
  app.ws.commit();
  if (app.workspaces.some(w => w.dirty)) { e.preventDefault(); e.returnValue = ''; }
});

// drag & drop (into the current workspace tab)
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const files = [...e.dataTransfer.files];
  const isWs = f => /\.(json|zip)$/i.test(f.name);
  const wsFile = files.find(isWs);
  loadFiles(files.filter(f => !isWs(f))).then(() => wsFile && loadWorkspaceFile(wsFile));
});

applyTheme(pref.get('theme', 'dark'));
$('#app-version').textContent = `v${APP_VERSION}`;
document.title = `${APP_NAME} v${APP_VERSION} (Beta)`;
setupSplitters();
setupRubberBand();
newWorkspace('Workspace 1');
