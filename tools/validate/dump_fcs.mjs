// Read each FCS file with Thistle Flow's parser and save the values (float64) + a JSON summary.
// Usage: node dump_fcs.mjs <outDir> <file.fcs>...
import fs from 'fs';
import path from 'path';
import { parseFCS } from '../../js/fcs.js';
const [out, ...files] = process.argv.slice(2);
files.forEach((f, i) => {
  const base = `${String(i).padStart(4, '0')}_${path.basename(f).replace(/[^A-Za-z0-9_.-]/g, '_')}`; // unique, even for same-named files
  try {
    const buf = fs.readFileSync(f);
    const sets = parseFCS(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), path.basename(f));
    const ds = sets[0];
    const arr = new Float64Array(ds.events * ds.params.length);
    ds.columns.forEach((c, j) => { for (let e = 0; e < ds.events; e++) arr[e * ds.params.length + j] = c[e]; });
    fs.writeFileSync(`${out}/${base}.bin`, Buffer.from(arr.buffer));
    fs.writeFileSync(`${out}/${base}.json`, JSON.stringify({ file: f, nsets: sets.length, version: ds.version, events: ds.events,
      names: ds.params.map(p => p.name), warnings: [...(ds.warnings || []), ...(sets.length > 1 ? [`${sets.length} data sets in the file; the first was compared`] : [])] }));
  } catch (err) { fs.writeFileSync(`${out}/${base}.json`, JSON.stringify({ file: f, error: err.message })); }
});
