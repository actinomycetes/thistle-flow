// Usage: node tools/inspect.mjs file1.fcs [file2.fcs ...]  — prints a parse summary for each file
import { readFileSync } from 'node:fs';
import { parseFCS } from '../js/fcs.js';
for (const f of process.argv.slice(2)) {
  try {
    const b = readFileSync(f);
    const sets = parseFCS(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), f.split('/').pop());
    for (const ds of sets) {
      const med = ds.columns.slice(0, 4).map(c => { const s = Float32Array.from(c).sort(); return s[s.length >> 1]; });
      console.log(`OK  ${ds.name} | ${ds.version} ${ds.text['$DATATYPE']} ${ds.text['$BYTEORD']} | ${ds.instrument} | ${ds.events} ev x ${ds.params.length} par | spill:${ds.spill ? ds.spill.names.length : 0} | ${ds.params.slice(0, 6).map(p => p.name + (p.label ? `(${p.label})` : '')).join(', ')} | medians ${med.map(v => +v.toFixed(1)).join(', ')}`);
    }
  } catch (e) { console.log(`ERR ${f}: ${e.message}`); }
}
