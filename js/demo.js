// Synthetic demo data: a small T-cell activation experiment written as real FCS 3.1 files
// (with an embedded $SPILLOVER matrix), so the full parse -> compensate -> gate path is exercised.
import { writeFCS } from './fcs.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
}

export const DEMO_CHANNELS = ['FSC-A', 'FSC-H', 'SSC-A', 'FITC-A', 'PE-A', 'PE-Cy7-A', 'APC-A', 'BV421-A', 'Time'];
export const DEMO_LABELS = ['', '', '', 'CD3', 'CD4', 'CD69', 'CD8', 'Live-Dead', ''];
const FL = ['FITC-A', 'PE-A', 'PE-Cy7-A', 'APC-A', 'BV421-A'];
// rows = source dye, cols = detector
const SPILL = [
  [1, 0.18, 0.01, 0, 0.0],
  [0.02, 1, 0.06, 0.004, 0],
  [0, 0.03, 1, 0.012, 0],
  [0, 0, 0.025, 1, 0],
  [0.035, 0.01, 0, 0, 1],
];

export function makeDemoFile(name, activation, seed, n = 40000) {
  const r = rng(seed);
  const gauss = () => { const u = r(), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const logn = (mu, sd) => Math.pow(10, mu + sd * gauss());
  const neg = () => 60 + 120 * gauss();
  const cols = DEMO_CHANNELS.map(() => new Float32Array(n));
  for (let e = 0; e < n; e++) {
    const p = r();
    let fsc, ssc, fscH, true5 = [neg(), neg(), neg(), neg(), neg()];
    if (p < 0.12) { // debris
      fsc = Math.abs(8000 + 6000 * gauss()); ssc = Math.abs(5000 + 5000 * gauss()); fscH = fsc * 0.9;
      true5[4] = logn(3.2, 0.4);
    } else if (p < 0.17) { // doublets
      fsc = 120000 + 15000 * gauss(); ssc = 40000 + 10000 * gauss(); fscH = fsc * 0.5;
    } else if (p < 0.33) { // monocytes
      fsc = 105000 + 12000 * gauss(); ssc = 75000 + 12000 * gauss(); fscH = fsc * 0.88;
      true5[0] = neg(); true5[1] = logn(2.9, 0.2); // CD4 dim on monocytes
    } else { // lymphocytes
      fsc = 60000 + 7000 * gauss(); ssc = 22000 + 5000 * gauss(); fscH = fsc * 0.9 + 1500 * gauss();
      if (r() < 0.08) true5[4] = logn(3.8, 0.2); // dead
      if (r() < 0.68) { // T cells
        true5[0] = logn(3.6, 0.15);
        const t = r();
        if (t < 0.6) true5[1] = logn(3.9, 0.15);
        else if (t < 0.9) true5[3] = logn(3.7, 0.18);
        if (r() < activation) true5[2] = logn(3.4 + 0.3 * activation, 0.25);
      }
    }
    // apply spillover: detector = sum(dye * spill[dye][det])
    for (let d = 0; d < 5; d++) {
      let s = 0;
      for (let k = 0; k < 5; k++) s += true5[k] * SPILL[k][d];
      cols[3 + d][e] = s + 30 * gauss();
    }
    cols[0][e] = Math.min(262143, fsc); cols[1][e] = Math.min(262143, fscH); cols[2][e] = Math.min(262143, ssc);
    cols[8][e] = e / n * 6000;
  }
  const spillStr = [5, ...FL, ...SPILL.flat()].join(',');
  return writeFCS({
    names: DEMO_CHANNELS, labels: DEMO_LABELS, columns: cols,
    extraText: { '$CYT': 'Thistle Flow Demo Cytometer', '$FIL': name, '$SPILLOVER': spillStr, '$DATE': '09-NOV-2026' },
  });
}

export function demoFiles() {
  return [
    ['Unstimulated.fcs', 0.03, 11],
    ['Stim_6h.fcs', 0.35, 22],
    ['Stim_24h.fcs', 0.7, 33],
  ].map(([name, act, seed]) => ({ name, buffer: makeDemoFile(name, act, seed) }));
}
