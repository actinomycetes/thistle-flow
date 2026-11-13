// Compensate each file with its own spillover matrix using Thistle Flow, and save the compensated
// values of the matrix channels (first 20,000 events). Usage: node dump_comp.mjs <outDir> <file.fcs>...
import fs from 'fs';
import path from 'path';
import { parseFCS } from '../../js/fcs.js';
import { Sample } from '../../js/model.js';
const [out, ...files] = process.argv.slice(2);
files.forEach((f, i) => {
  const base = `${String(i).padStart(4, '0')}_${path.basename(f).replace(/[^A-Za-z0-9_.-]/g, '_')}`;
  try {
    const buf = fs.readFileSync(f);
    const ds = parseFCS(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), path.basename(f))[0];
    if (!ds.spill) return;
    const s = new Sample(ds);
    s.setCompEnabled(true);
    if (s.spillMissing().length || !s.isCompensated(s.spill.names[0])) return; // matrix not usable with this file
    const names = s.spill.names, n = Math.min(ds.events, 20000);
    const arr = new Float64Array(n * names.length);
    names.forEach((nm, j) => { const c = s.column(nm); for (let e = 0; e < n; e++) arr[e * names.length + j] = c[e]; });
    fs.writeFileSync(`${out}/${base}.comp.bin`, Buffer.from(arr.buffer));
    fs.writeFileSync(`${out}/${base}.comp.json`, JSON.stringify({ file: f, names, idx: names.map(nm => s.channelIndex(nm)), n, spill: s.spill.matrix }));
  } catch { /* reported by the reading check */ }
});
