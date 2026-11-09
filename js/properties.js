// Properties tab: acquisition information from the FCS TEXT segment, with editing.
// Edits live in the workspace (and undo history) and are written into exported FCS files;
// the original files are never modified.
import { h, toast, saveFile, dateStamp, safeName } from './ui.js';
import { Sample } from './model.js';

// Each field lists the keywords different instruments use for it (first present wins; edits create the first)
export const ACQ_FIELDS = [
  ['Instrument', ['$CYT']],
  ['Serial number', ['$CYTSN', 'CYTOMETER CONFIG NAME']],
  ['Software', ['CREATOR', 'SOFTWARE', '$SYS', 'APPLICATION']],
  ['Acquisition date', ['$DATE']],
  ['Start time', ['$BTIM']],
  ['End time', ['$ETIM']],
  ['Operator', ['$OP', 'EXPORT USER NAME']],
  ['Institution', ['$INST']],
  ['Experiment', ['EXPERIMENT NAME', 'EXPERIMENT_NAME', '$EXP', '$PROJ']],
  ['Specimen', ['$SRC', 'SAMPLE ID', 'SAMPLE_NAME', '$SMNO']],
  ['Tube / sample name', ['TUBE NAME', 'TUBE_NAME', '$FIL']],
  ['Plate / well', ['PLATE NAME', '$PLATENAME', 'WELL ID', '$WELLID']],
  ['Volume', ['$VOL', 'VOL']],
  ['Comment', ['$COM']],
  ['Events ($TOT)', ['$TOT']],
  ['Lost events', ['$LOST']],
  ['Time step', ['$TIMESTEP']],
];

const CHANNEL_COLS = [['Voltage', 'V'], ['Gain', 'G'], ['Range', 'R'], ['Bits', 'B'], ['Ampl.', 'E'], ['Filter', 'F'], ['Laser (nm)', 'L'], ['Detector', 'T']];

export function fieldKey(s, keys) { return keys.find(k => s.text[k] !== undefined) || keys[0]; }

function duration(s) {
  const t = k => { const m = /^(\d+):(\d+):(\d+)/.exec(s.text[k] || ''); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null; };
  const a = t('$BTIM'), b = t('$ETIM');
  if (a === null || b === null) return '';
  let d = b - a; if (d < 0) d += 86400;
  return `${Math.floor(d / 60)} min ${d % 60} s`;
}

function lasers(s) {
  const out = [];
  for (let i = 1; i <= 10; i++) {
    const name = s.text[`LASER${i}NAME`] || s.text[`#LASER${i}COLOR`] || s.text[`LASER${i}`];
    const wl = s.text[`LASER${i}WAVELENGTH`] || s.text[`#LASER${i}WAVELENGTH`];
    if (name || wl) out.push([name, wl && `${wl} nm`].filter(Boolean).join(' '));
  }
  if (!out.length) {
    const wls = [...new Set(s.params.map((p, i) => s.text[`$P${i + 1}L`]).filter(Boolean))];
    if (wls.length) out.push(wls.map(w => `${w} nm`).join(', '));
  }
  return out.join(' · ');
}

export function renderProperties(app, root) {
  const ws = app.ws;
  root.innerHTML = '';
  if (!ws.samples.length) { root.append(h('div', { class: 'empty-state' }, h('h2', {}, 'Properties'), h('p', {}, 'Load FCS files to see acquisition information.'))); return; }
  const s = ws.activeSample() || ws.samples[0];
  const editInput = (value, onCommit, opts = {}) => h('input', {
    type: 'text', value: value ?? '', class: 'prop-input' + (opts.edited ? ' edited' : ''), readOnly: !!opts.readOnly,
    title: opts.readOnly ? 'Describes the data layout; read-only' : (opts.edited ? 'Edited (original: ' + (opts.orig ?? '—') + ')' : 'Click to edit'),
    onchange: e => { try { onCommit(e.target.value); app.metaChanged(); } catch (err) { toast(err.message, true); e.target.value = value ?? ''; } },
  });
  const isEdited = k => k in s.edits.kw;

  // header
  root.append(h('div', { class: 'prop-head' },
    h('label', {}, 'Sample ', h('select', { onchange: e => { ws.activeId = e.target.value; app.renderAll(); } },
      ws.samples.map(x => h('option', { value: x.id, selected: x === s }, x.name)))),
    h('label', {}, 'Display name ', editInput(s.name, v => s.rename(v.trim()), { edited: !!s.edits.name, orig: s.key })),
    h('span', { class: 'hint' }, `${s.version} · ${s.text['$DATATYPE'] || '?'} data · byte order ${s.text['$BYTEORD'] || '?'} · file ${s.fileName}`),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn', onclick: () => exportAcquisitionCSV(ws) }, 'Export summary CSV (all samples)'),
    h('button', { class: 'btn danger', disabled: !Object.keys(s.edits.kw).length && !Object.keys(s.edits.labels).length && !s.edits.name, onclick: () => { s.applyEdits({}); app.metaChanged(); } }, 'Reset edits')));

  // acquisition summary
  const acq = h('table', { class: 'prop-table' });
  for (const [label, keys] of ACQ_FIELDS) {
    const k = fieldKey(s, keys);
    acq.append(h('tr', {}, h('th', {}, label), h('td', {}, editInput(s.text[k], v => s.setKeyword(k, v), { readOnly: Sample.isStructural(k), edited: isEdited(k), orig: s.textOrig[k] })), h('td', { class: 'hint' }, k)));
  }
  acq.append(h('tr', {}, h('th', {}, 'Duration'), h('td', {}, duration(s) || '—'), h('td', { class: 'hint' }, 'from $BTIM/$ETIM')));
  acq.append(h('tr', {}, h('th', {}, 'Lasers'), h('td', {}, lasers(s) || '—'), h('td', {})));
  acq.append(h('tr', {}, h('th', {}, 'Compensation'), h('td', {}, s.spill ? `${s.spill.names.length}×${s.spill.names.length} matrix, ${s.compEnabled ? 'applied' : 'not applied'}` : 'none in file'), h('td', {})));

  // channels
  const ch = h('table', { class: 'prop-table channels' },
    h('tr', {}, h('th', {}, '#'), h('th', {}, 'Channel ($PnN)'), h('th', {}, 'Marker / label ($PnS)'), CHANNEL_COLS.map(([l]) => h('th', {}, l))));
  s.params.forEach((p, i) => {
    ch.append(h('tr', {},
      h('td', {}, String(i + 1)), h('td', {}, p.name),
      h('td', {}, editInput(p.label, v => s.setLabel(p.name, v), { edited: p.name in s.edits.labels, orig: s.labelsOrig[i] })),
      CHANNEL_COLS.map(([, c]) => {
        const k = `$P${i + 1}${c}`;
        return h('td', {}, Sample.isStructural(k) ? (s.text[k] ?? '') : editInput(s.text[k], v => s.setKeyword(k, v), { edited: isEdited(k), orig: s.textOrig[k] }));
      })));
  });

  // all keywords
  const filter = h('input', { type: 'search', placeholder: 'Filter keywords…', value: app._kwFilter || '', oninput: e => { app._kwFilter = e.target.value; drawKw(); } });
  const kwTable = h('table', { class: 'prop-table kw' });
  const drawKw = () => {
    kwTable.innerHTML = '';
    const f = (app._kwFilter || '').toLowerCase();
    for (const k of Object.keys(s.text).sort()) {
      if (f && !k.toLowerCase().includes(f) && !String(s.text[k]).toLowerCase().includes(f)) continue;
      kwTable.append(h('tr', {}, h('th', {}, k), h('td', {}, editInput(s.text[k], v => s.setKeyword(k, v), { readOnly: Sample.isStructural(k), edited: isEdited(k), orig: s.textOrig[k] }))));
    }
  };
  drawKw();
  const newKey = h('input', { type: 'text', placeholder: 'NEW KEYWORD', style: 'width:150px' });
  const newVal = h('input', { type: 'text', placeholder: 'value', style: 'width:220px' });

  root.append(
    h('div', { class: 'prop-grid' },
      h('section', {}, h('h3', {}, 'Acquisition'), acq),
      h('section', {}, h('h3', {}, 'Channels ',
        h('button', { class: 'btn small', title: 'Copy these marker labels to every sample that has the same channel', onclick: () => {
          let n = 0;
          for (const o of ws.samples) if (o !== s) s.params.forEach(p => { if (o.hasChannel(p.name) && o.params[o.channelIndex(p.name)].label !== p.label) { o.setLabel(p.name, p.label); n++; } });
          app.metaChanged(); toast(`Copied labels (${n} change${n === 1 ? '' : 's'})`);
        } }, 'Apply labels to all samples')), h('div', { class: 'scroll-x' }, ch)),
      h('section', { class: 'span2' }, h('h3', {}, 'All keywords'),
        h('div', { class: 'row' }, filter, h('span', { class: 'grow' }), newKey, newVal,
          h('button', { class: 'btn small', onclick: () => {
            if (!newKey.value.trim()) return;
            try { s.setKeyword(newKey.value, newVal.value); app.metaChanged(); } catch (err) { toast(err.message, true); }
          } }, 'Add')),
        h('div', { class: 'kw-wrap' }, kwTable))),
    h('p', { class: 'hint' }, 'Edits are kept in the workspace (save it to keep them) and written into FCS files exported from the gate tree. The original files are never changed. Keywords that describe the data layout are read-only.'));
}

function exportAcquisitionCSV(ws) {
  const cols = ['Sample', 'File', ...ACQ_FIELDS.map(f => f[0]), 'Duration', 'Lasers'];
  const rows = ws.samples.map(s => [s.name, s.fileName, ...ACQ_FIELDS.map(([, keys]) => s.text[fieldKey(s, keys)] ?? ''), duration(s), lasers(s)]);
  const q = c => (/[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c);
  const csv = [cols, ...rows].map(r => r.map(q).join(',')).join('\n');
  saveFile(`${safeName(ws.name)}_acquisition_${dateStamp()}.csv`, csv, 'csv');
}

