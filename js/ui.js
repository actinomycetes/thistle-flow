// Small DOM / dialog / file helpers shared by the app modules.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const h = (tag, attrs = {}, ...kids) => {
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
export const uid = p => p + Math.random().toString(36).slice(2, 9);
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const safeName = s => String(s).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'untitled';

// 2026-11-09_1412 (local time) so repeated saves do not overwrite each other
export function dateStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

let toastT;
export function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false; t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), isError ? 6000 : 2800);
}

// ---- modal ----
let modalClose = null;
export function openModal(title, body, { onClose, wide } = {}) {
  $('#modalTitle').textContent = title;
  const b = $('#modalBody'); b.innerHTML = ''; b.append(body);
  $('#modal').hidden = false;
  $('#modal .modal-box').classList.toggle('wide', !!wide);
  modalClose = onClose || null;
}
export function closeModal() {
  if ($('#modal').hidden) return;
  $('#modal').hidden = true;
  const f = modalClose; modalClose = null;
  if (f) f();
}
export const modalOpen = () => !$('#modal').hidden;

// Promise-based choice dialog: resolves with the chosen button's value (or null if dismissed)
export function choose(title, message, buttons) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; closeModal(); resolve(v); };
    const body = h('div', {}, h('p', { style: 'margin-top:0;max-width:440px;line-height:1.45' }, message),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        buttons.map(b => h('button', { class: 'btn' + (b.primary ? ' primary' : ''), onclick: () => finish(b.value) }, b.label))));
    openModal(title, body, { onClose: () => finish(null) });
  });
}

// ---- drags ----
// Track a mouse drag until the button is released. Safari/WebKit can miss the final mouseup
// (e.g. when a popover closes as the drag starts), which left drags "stuck" to the pointer, so a
// move with no button pressed, a lost window focus or a cancelled pointer also ends the drag.
// Returns a function that stops tracking without calling onEnd.
export function trackDrag(onMove, onEnd) {
  let done = false;
  const off = () => {
    window.removeEventListener('mousemove', move, true); window.removeEventListener('mouseup', end, true);
    window.removeEventListener('pointercancel', end, true); window.removeEventListener('blur', end);
    document.removeEventListener('visibilitychange', end);
  };
  const end = e => { if (done) return; done = true; off(); onEnd(e); };
  const move = e => { if (e.buttons === 0) end(e); else onMove(e); };
  window.addEventListener('mousemove', move, true); window.addEventListener('mouseup', end, true);
  window.addEventListener('pointercancel', end, true); window.addEventListener('blur', end);
  document.addEventListener('visibilitychange', end);
  return () => { if (!done) { done = true; off(); } };
}

// ---- popover (small floating panel) ----
// Placed under its anchor, or with { beside: element } next to that element (e.g. a plot card)
// so it does not cover the plot being changed.
let popEl = null, popAway = null;
export function closePopover() {
  if (popAway) { document.removeEventListener('mousedown', popAway, true); popAway = null; }
  if (popEl) { popEl.remove(); popEl = null; }
}
export function popover(anchor, content, { beside } = {}) {
  closePopover();
  popEl = h('div', { class: 'popover' }, content);
  document.body.append(popEl);
  const pw = popEl.offsetWidth, ph = popEl.offsetHeight, W = window.innerWidth, H = window.innerHeight;
  const clamp = (v, a, b) => Math.min(Math.max(v, a), Math.max(a, b));
  let left, top;
  const c = beside?.isConnected ? beside.getBoundingClientRect() : null;
  if (c && c.right + 8 + pw <= W - 8) { left = c.right + 8; top = clamp(c.top, 8, H - ph - 8); }
  else if (c && c.left - 8 - pw >= 8) { left = c.left - 8 - pw; top = clamp(c.top, 8, H - ph - 8); }
  else if (c && c.bottom + 4 + ph <= H - 8) { left = clamp(c.left, 8, W - pw - 8); top = c.bottom + 4; }
  else {
    const r = anchor.getBoundingClientRect();
    left = clamp(r.right - pw, 8, W - pw - 8);
    top = r.bottom + ph + 8 > H ? Math.max(8, r.top - ph - 4) : r.bottom + 4;
  }
  popEl.style.left = left + 'px'; popEl.style.top = top + 'px';
  const el = popEl;
  setTimeout(() => {
    if (popEl !== el) return;
    popAway = e => { if (popEl && !popEl.contains(e.target) && e.target !== anchor) closePopover(); };
    document.addEventListener('mousedown', popAway, true);
  });
  return popEl;
}

// "Done" for a popover: commits a value still being typed (its change event), then closes.
// mousedown is cancelled so the click lands on this button even if the panel redraws on change.
export function doneButton(label = 'Done') {
  return h('div', { class: 'pop-actions' }, h('button', {
    class: 'btn small primary',
    onmousedown: e => e.preventDefault(),
    onclick: () => { document.activeElement?.blur?.(); closePopover(); },
  }, label));
}

// ---- saving files ----
export const canPickLocation = () => typeof window.showSaveFilePicker === 'function';

const MIME = {
  json: ['application/json', 'Workspace / template (JSON)'], csv: ['text/csv', 'CSV table'], png: ['image/png', 'PNG image'],
  svg: ['image/svg+xml', 'SVG vector image'], pdf: ['application/pdf', 'PDF document'], fcs: ['application/octet-stream', 'FCS file'],
  zip: ['application/zip', 'Workspace with FCS files (zip)'],
};

function downloadBlob(name, blob) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// Save a file. Where the browser supports it (Chrome/Edge), a native dialog lets the user pick
// the folder and name; elsewhere the browser's download handling applies.
// Returns the saved file name, or null if the user cancelled.
// data may be a function (sync or async) so slow content (e.g. a zip) is built after the
// location is chosen: browsers only allow the picker shortly after a click.
export async function saveFile(name, data, ext) {
  ext = ext || (name.split('.').pop() || '').toLowerCase();
  const [mime, desc] = MIME[ext] || ['application/octet-stream', 'File'];
  const toBlob = async () => { const d = typeof data === 'function' ? await data() : data; return d instanceof Blob ? d : new Blob([d], { type: mime }); };
  if (canPickLocation()) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: desc, accept: { [mime]: ['.' + ext] } }] });
      const blob = await toBlob();
      const w = await handle.createWritable(); await w.write(blob); await w.close();
      return handle.name;
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      console.warn('Save picker unavailable, falling back to download:', err);
    }
  }
  downloadBlob(name, await toBlob());
  return name;
}

// Save dialog with an editable, date-stamped file name (workspaces, templates).
// makeData() is called after the user confirms. Resolves with the saved name or null.
// ext may be a function (e.g. .zip or .json depending on a checkbox in `extra`); makeData may be async.
export function saveDialog({ title, baseName, ext = 'json', note, extra, makeData }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; resolve(v); };
    const extOf = () => (typeof ext === 'function' ? ext() : ext);
    const suffixEl = h('span', { class: 'hint' }, `.${extOf()}`);
    const input = h('input', { type: 'text', value: `${safeName(baseName)}_${dateStamp()}`, style: 'flex:1;min-width:280px' });
    let saving = false;
    const go = async () => {
      const e = extOf();
      const name = safeName(input.value.replace(/\.(json|zip)$/i, '')) + '.' + e;
      saving = true;
      closeModal();
      try {
        const saved = await saveFile(name, makeData, e);
        if (saved) toast(`Saved ${saved}`);
        finish(saved);
      } catch (err) { toast('Could not save: ' + err.message, true); finish(null); }
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    const body = h('div', {},
      note ? h('div', { class: 'hint-box', style: 'margin:0 0 8px;max-width:520px' }, note) : null,
      h('div', { class: 'row' }, h('label', {}, 'File name'), input, suffixEl),
      extra || null,
      h('p', { class: 'hint' }, canPickLocation()
        ? 'Next, choose the folder to save in. The date and time are added so earlier saves are not overwritten.'
        : 'Your browser saves to its Downloads folder (or asks where, depending on its settings). The date and time are added so earlier saves are not overwritten.'),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn', onclick: () => { closeModal(); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: go }, canPickLocation() ? 'Choose location…' : 'Save')));
    body.addEventListener('change', () => { suffixEl.textContent = `.${extOf()}`; });
    openModal(title, body, { onClose: () => { if (!saving) finish(null); } });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

// Pick several files, or a whole folder (folder=true; works in Chrome, Edge, Firefox and Safari)
export function pickFiles({ accept = '', folder = false } = {}) {
  return new Promise(resolve => {
    const inp = h('input', { type: 'file', accept, multiple: true, hidden: true, onchange: () => { resolve([...inp.files]); inp.remove(); } });
    if (folder) inp.setAttribute('webkitdirectory', '');
    // no 'cancel' handler: Firefox may report cancel before the chosen files arrive
    document.body.append(inp); inp.click();
  });
}

// Read a user-picked text file
export function pickFile(accept) {
  return new Promise(resolve => {
    const inp = h('input', { type: 'file', accept, hidden: true, onchange: () => { resolve(inp.files[0] || null); inp.remove(); } });
    document.body.append(inp); inp.click();
  });
}
