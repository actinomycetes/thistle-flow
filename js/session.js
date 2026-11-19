// Keeps a copy of the open workspaces (and their FCS files) in this browser's IndexedDB so a refresh or a
// closed tab does not lose the analysis (as in Thistle Notebook). The data stays on this device; .tflow files
// remain the way to keep and share work. Files are stored once each and shared by later saves.
const DB = 'thistle-flow-session', VER = 1;
let dbp = null;

function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = t => new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('storage aborted')); });

export const sessionSupported = () => { try { return typeof indexedDB !== 'undefined' && !!indexedDB; } catch { return false; } };

// meta: { workspaces: [{ data, files: [{ key, name }], dirty }], active, savedAt, appVersion }
// newFiles: Map key -> Uint8Array not stored yet; every other stored file not listed in meta is removed.
export async function writeSession(meta, newFiles) {
  const t = (await db()).transaction(['kv', 'files'], 'readwrite');
  const fs = t.objectStore('files');
  for (const [k, v] of newFiles) fs.put(v, k);
  const keep = new Set(meta.workspaces.flatMap(w => w.files.map(f => f.key)));
  const keys = await req(fs.getAllKeys());
  for (const k of keys) if (!keep.has(k)) fs.delete(k);
  t.objectStore('kv').put(meta, 'session');
  return done(t);
}

// Returns { meta, files: Map key -> Uint8Array } or null when nothing is kept.
export async function readSession() {
  const d = await db();
  const meta = await req(d.transaction('kv').objectStore('kv').get('session'));
  if (!meta?.workspaces?.length) return null;
  const fs = d.transaction('files').objectStore('files');
  const files = new Map();
  for (const w of meta.workspaces) for (const f of w.files) if (!files.has(f.key)) {
    const v = await req(fs.get(f.key));
    if (v) files.set(f.key, v);
  }
  return { meta, files };
}

export async function clearSession() {
  const t = (await db()).transaction(['kv', 'files'], 'readwrite');
  t.objectStore('kv').clear(); t.objectStore('files').clear();
  return done(t);
}
