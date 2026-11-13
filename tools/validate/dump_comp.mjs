import fs from 'fs'; import path from 'path';
import { parseFCS } from '../../js/fcs.js';
import { Sample } from '../../js/model.js';
const out = process.argv[2];
for (const f of process.argv.slice(3)) {
  const buf = fs.readFileSync(f); const ds = parseFCS(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), path.basename(f))[0];
  if (!ds.spill) continue;
  const s = new Sample(ds); s.setCompEnabled(true); if (!s.spill || s.spillMissing().length || !s.isCompensated(s.spill.names[0])) { console.log("skip", f); continue; }
  const names = s.spill.names; const n = Math.min(ds.events, 20000);
  const arr = new Float64Array(n * names.length);
  names.forEach((nm, j) => { const c = s.column(nm); for (let e = 0; e < n; e++) arr[e * names.length + j] = c[e]; });
  const base = path.basename(f).replace(/[^A-Za-z0-9_.-]/g, '_');
  fs.writeFileSync(`${out}/${base}.comp.bin`, Buffer.from(arr.buffer));
  fs.writeFileSync(`${out}/${base}.comp.json`, JSON.stringify({ file: f, names, idx: names.map(nm => s.channelIndex(nm)), n, spill: s.spill.matrix }));
  console.log('comp', base, names.length, 'channels');
}
