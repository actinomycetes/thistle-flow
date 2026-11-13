// FCS 2.0 / 3.0 / 3.1 / 3.2 parser.
// Handles BD (FACSDiva: Fortessa, Canto, Symphony), Thermo Attune NxT, Sony (SA3800/ID7000/SH800),
// Cytek, Beckman CytoFLEX and other list-mode files.

const DEC = new TextDecoder('latin1');
const UTF8 = new TextDecoder('utf-8', { fatal: false });

function asciiInt(bytes, start, end) {
  const s = DEC.decode(bytes.subarray(start, end)).trim();
  return s === '' ? 0 : parseInt(s, 10);
}

// Parse TEXT segment into a key -> value map (keys upper-cased).
export function parseText(bytes, start, end) {
  // Prefer UTF-8 (FCS 3.1+ allows it); fall back to latin1 on replacement chars.
  let raw = UTF8.decode(bytes.subarray(start, end + 1));
  if (raw.includes('�')) raw = DEC.decode(bytes.subarray(start, end + 1));
  const delim = raw[0];
  const tokens = [];
  let cur = '';
  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === delim) {
      if (raw[i + 1] === delim && i + 1 < raw.length - 1) { cur += delim; i++; continue; } // escaped delimiter
      tokens.push(cur); cur = '';
    } else cur += ch;
  }
  if (cur.length) tokens.push(cur);
  const text = {};
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    text[tokens[i].trim().toUpperCase()] = tokens[i + 1].trim();
  }
  return text;
}

// Parse a spillover keyword: "n,name1,...,nameN,v11,v12,...,vNN"
export function parseSpillover(str) {
  if (!str) return null;
  const parts = str.split(',').map(s => s.trim());
  const n = parseInt(parts[0], 10);
  if (!(n > 0) || parts.length < 1 + n + n * n) return null;
  const names = parts.slice(1, 1 + n);
  const vals = parts.slice(1 + n, 1 + n + n * n).map(Number);
  const matrix = [];
  for (let r = 0; r < n; r++) matrix.push(vals.slice(r * n, r * n + n));
  if (matrix.flat().some(v => !Number.isFinite(v))) return null;
  // some exporters write percentages (diagonal 100): use fractions (diagonal 1)
  if (matrix.every((r, i) => Math.abs(r[i] - 100) < 1e-6)) for (const r of matrix) for (let j = 0; j < n; j++) r[j] /= 100;
  return { names, matrix };
}

// $PnR to write for decoded values in an exported (float) file: log channels span f2..f2*10^f1,
// linear integer channels with a gain span R/gain.
export function exportRanges(params) {
  return params.map(p => {
    const [f1, f2] = p.ampE || [0, 0];
    if (f1 > 0) return (f2 > 0 ? f2 : 1) * Math.pow(10, f1);
    if (p.int && p.gain && p.gain !== 1) return p.range / p.gain;
    return p.range;
  });
}

function byteOrderIsLittle(byteord) {
  if (!byteord) return true;
  const b = byteord.replace(/\s/g, '');
  if (b === '1,2,3,4' || b === '1,2' || b === '1,2,3,4,5,6,7,8' || b === '1') return true;
  if (b === '4,3,2,1' || b === '2,1' || b === '8,7,6,5,4,3,2,1') return false;
  // Mixed orders (e.g. 3,4,1,2) are essentially never used; assume little-endian if starts with 1.
  return b.startsWith('1');
}

function readDataset(bytes, offset) {
  const header = DEC.decode(bytes.subarray(offset, offset + 6));
  if (!/^FCS\d\.\d/.test(header)) throw new Error('Not an FCS file (bad header: "' + header + '")');
  const version = header;
  const textStart = asciiInt(bytes, offset + 10, offset + 18) + offset;
  const textEnd = asciiInt(bytes, offset + 18, offset + 26) + offset;
  let dataStart = asciiInt(bytes, offset + 26, offset + 34);
  let dataEnd = asciiInt(bytes, offset + 34, offset + 42);

  const text = parseText(bytes, textStart, textEnd);
  const warnings = [];

  // FCS 3: $BEGINDATA/$ENDDATA in TEXT are required and are used when the HEADER offsets are 0
  // (large files) or disagree with them; FCS 2 has only the HEADER offsets.
  const tb = parseInt(text['$BEGINDATA'] || '0', 10), te = parseInt(text['$ENDDATA'] || '0', 10);
  if (/^FCS3/.test(version) && tb > 0 && te >= tb) {
    if (dataStart && (dataStart !== tb || dataEnd !== te)) warnings.push(`HEADER data offsets (${dataStart}–${dataEnd}) disagree with $BEGINDATA/$ENDDATA (${tb}–${te}); the TEXT values were used`);
    dataStart = tb; dataEnd = te;
  } else if (!dataStart || !dataEnd) { dataStart = tb; dataEnd = te; }
  dataStart += offset; dataEnd += offset;

  const mode = (text['$MODE'] || 'L').toUpperCase();
  if (mode !== 'L') throw new Error(`Unsupported $MODE "${mode}" (only list mode is supported)`);

  const nPar = parseInt(text['$PAR'], 10);
  const nTot = parseInt(text['$TOT'], 10);
  const datatype = (text['$DATATYPE'] || 'F').toUpperCase();
  const little = byteOrderIsLittle(text['$BYTEORD']);

  const params = [];
  for (let i = 1; i <= nPar; i++) {
    const N = text[`$P${i}N`] || `P${i}`;
    const S = text[`$P${i}S`] || '';
    const B = parseInt(text[`$P${i}B`] || '32', 10);
    const R = parseFloat(text[`$P${i}R`] || '262144');
    const E = (text[`$P${i}E`] || '0,0').split(',').map(Number);
    const G = parseFloat(text[`$P${i}G`] || '1') || 1; // 0 means no gain
    const dispRaw = text[`P${i}DISPLAY`] || '';
    params.push({ index: i - 1, name: N, label: S, bits: B, range: R, ampE: E, gain: G, display: dispRaw.toUpperCase() });
  }

  let events = Number.isFinite(nTot) ? nTot : 0;
  // the data segment must hold $TOT events of the stated size; never read past it (or past the file)
  const bytesPerEvent = (datatype === 'F' ? 4 * nPar : datatype === 'D' ? 8 * nPar : params.reduce((a, p) => a + p.bits / 8, 0));
  const segment = Math.min(dataEnd, bytes.length - 1) - dataStart + 1;
  if (bytesPerEvent > 0 && events * bytesPerEvent > segment) {
    const fit = Math.max(0, Math.floor(segment / bytesPerEvent));
    warnings.push(`$TOT says ${events} events but the data segment holds only ${fit}; ${fit} events were read`);
    events = fit;
  }
  const columns = params.map(() => new Float32Array(events));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (datatype === 'F' || datatype === 'D') {
    const size = datatype === 'F' ? 4 : 8;
    let p = dataStart;
    for (let e = 0; e < events; e++) {
      for (let c = 0; c < nPar; c++) {
        columns[c][e] = size === 4 ? dv.getFloat32(p, little) : dv.getFloat64(p, little);
        p += size;
      }
    }
  } else if (datatype === 'I') {
    const widths = params.map(pr => pr.bits);
    if (widths.some(w => w % 8 !== 0)) throw new Error('Non byte-aligned integer data is not supported');
    const masks = params.map(pr => {
      const r = pr.range;
      // mask to the smallest power of two >= range (FCS spec); guard huge widths
      if (!(r > 1) || pr.bits > 32) return null; // $PnR 1 (or missing): nothing to mask
      const bitsNeeded = Math.ceil(Math.log2(r));
      return bitsNeeded >= 32 ? null : (2 ** bitsNeeded) - 1;
    });
    let p = dataStart;
    for (let e = 0; e < events; e++) {
      for (let c = 0; c < nPar; c++) {
        const w = widths[c];
        let v;
        if (w === 8) v = dv.getUint8(p);
        else if (w === 16) v = dv.getUint16(p, little);
        else if (w === 32) v = dv.getUint32(p, little);
        else if (w === 64) v = Number(dv.getBigUint64(p, little));
        else throw new Error(`Unsupported integer width ${w}`);
        p += w / 8;
        const m = masks[c];
        if (m !== null && w <= 32) v = v & m;
        columns[c][e] = v;
      }
    }
    // Apply log amplification ($PnE) / gain ($PnG) for integer data
    params.forEach((pr, c) => {
      const [f1, f2raw] = pr.ampE;
      const col = columns[c];
      if (f1 > 0) {
        const f2 = f2raw > 0 ? f2raw : 1;
        const r = pr.range;
        for (let e = 0; e < events; e++) col[e] = f2 * Math.pow(10, f1 * col[e] / r);
      } else if (pr.gain !== 1) {
        for (let e = 0; e < events; e++) col[e] /= pr.gain;
      }
    });
  } else if (datatype === 'A') {
    throw new Error('ASCII ($DATATYPE=A) data is not supported');
  } else {
    throw new Error(`Unknown $DATATYPE "${datatype}"`);
  }

  // Spillover: FCS3.1 $SPILLOVER, BD "SPILL", some exporters "SPILLOVER" / "$COMP" (first one that reads)
  let spill = null, spillNote = null;
  for (const k of ['$SPILLOVER', 'SPILL', 'SPILLOVER', '$COMP']) { if (text[k] && (spill = parseSpillover(text[k]))) break; }
  if (!spill && text['$COMP']) {
    // FCS 3.0 $COMP lists only n and the n×n values, without channel names, so which channels it
    // refers to is not stated: not applied, and the user is told
    spillNote = 'This file has an FCS 3.0 $COMP matrix without channel names, so it was not applied. Enter the matrix in the Compensation tab (Import CSV) if it is needed.';
    warnings.push(spillNote);
  }

  const next = parseInt(text['$NEXTDATA'] || '0', 10);
  params.forEach(p => { p.int = datatype === 'I'; });
  return { version, text, params, columns, events, spill, spillNote, warnings, next: next > 0 ? offset + next : 0 };
}

// Returns an array of datasets (most files contain exactly one).
export function parseFCS(arrayBuffer, fileName = 'sample.fcs') {
  const bytes = new Uint8Array(arrayBuffer);
  const out = [];
  let offset = 0;
  const seen = new Set();
  while (true) {
    const ds = readDataset(bytes, offset);
    ds.fileName = fileName;
    out.push(ds);
    if (!ds.next || seen.has(ds.next) || ds.next >= bytes.length) break;
    seen.add(ds.next);
    offset = ds.next;
  }
  out.forEach((ds, i) => {
    const base = ds.text['$FIL'] || fileName;
    ds.name = out.length > 1 ? `${fileName} [${i + 1}]` : fileName;
    ds.instrument = [ds.text['$CYT'], ds.text['$CYTSN']].filter(Boolean).join(' ') || 'Unknown cytometer';
    ds.originalName = base;
  });
  return out;
}

// Minimal FCS 3.1 writer (float32, little-endian). Used for demo data, tests and gated-population export.
export function writeFCS({ names, labels = [], columns, extraText = {}, ranges = [] }) {
  const nPar = names.length;
  const nTot = columns[0].length;
  const kw = {
    '$BEGINANALYSIS': '0', '$ENDANALYSIS': '0', '$BEGINSTEXT': '0', '$ENDSTEXT': '0',
    '$BYTEORD': '1,2,3,4', '$DATATYPE': 'F', '$MODE': 'L', '$NEXTDATA': '0',
    '$PAR': String(nPar), '$TOT': String(nTot),
  };
  names.forEach((n, i) => {
    kw[`$P${i + 1}N`] = n;
    if (labels[i]) kw[`$P${i + 1}S`] = labels[i];
    kw[`$P${i + 1}B`] = '32';
    kw[`$P${i + 1}E`] = '0,0';
    kw[`$P${i + 1}R`] = String(ranges[i] || 262144);
  });
  Object.assign(kw, extraText);
  const delim = '|';
  const esc = s => String(s).split(delim).join(delim + delim);
  const build = (beginData, endData) => {
    const k = { ...kw, '$BEGINDATA': String(beginData).padStart(12, '0'), '$ENDDATA': String(endData).padStart(12, '0') };
    let t = delim;
    for (const [key, v] of Object.entries(k)) t += esc(key) + delim + esc(v === '' ? ' ' : v) + delim;
    return t;
  };
  const enc = new TextEncoder();
  const textStart = 58;
  let textBytes = enc.encode(build(0, 0));
  const dataLen = nTot * nPar * 4;
  const dataStart = textStart + textBytes.length;
  const dataEnd = dataStart + dataLen - 1;
  // FCS 3.1: offsets are 0 when there is no data segment
  textBytes = enc.encode(dataLen ? build(dataStart, dataEnd) : build(0, 0)); // same length due to padding
  const textEnd = textStart + textBytes.length - 1;
  const pad = (n) => String(n).padStart(8, ' ');
  const fitsHeader = dataEnd <= 99999999;
  const header = 'FCS3.1    ' + pad(textStart) + pad(textEnd) +
    pad(fitsHeader && dataLen ? dataStart : 0) + pad(fitsHeader && dataLen ? dataEnd : 0) + pad(0) + pad(0);
  const buf = new ArrayBuffer(dataStart + dataLen);
  const u8 = new Uint8Array(buf);
  u8.set(enc.encode(header), 0);
  u8.set(textBytes, textStart);
  const dv = new DataView(buf);
  let p = dataStart;
  for (let e = 0; e < nTot; e++) for (let c = 0; c < nPar; c++) { dv.setFloat32(p, columns[c][e], true); p += 4; }
  return buf;
}
