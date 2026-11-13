// Parse each FCS file with Thistle Flow's parser; write columns as float64 binary + JSON meta
import fs from 'fs';
import path from 'path';
import { parseFCS } from "../../js/fcs.js";
const [out, ...files] = process.argv.slice(2);
for (const f of files) {
  const base = path.basename(f).replace(/[^A-Za-z0-9_.-]/g, '_');
  try {
    const buf = fs.readFileSync(f);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const sets = parseFCS(ab, path.basename(f));
    const ds = sets[0];
    const meta = { file: f, nsets: sets.length, version: ds.version, events: ds.events, names: ds.params.map(p => p.name), spill: ds.spill };
    const arr = new Float64Array(ds.events * ds.params.length);
    ds.columns.forEach((c, j) => { for (let e = 0; e < ds.events; e++) arr[e * ds.params.length + j] = c[e]; });
    fs.writeFileSync(`${out}/${base}.bin`, Buffer.from(arr.buffer));
    fs.writeFileSync(`${out}/${base}.json`, JSON.stringify(meta));
  } catch (err) { fs.writeFileSync(`${out}/${base}.json`, JSON.stringify({ file: f, error: err.message })); }
}
