// Four small FCS files for the "gate needs a channel the sample lacks" and "rare population" tests
// (statistical audit, case 14). Written with Thistle Flow's own writeFCS; same seed and recipe as the audit's
// make_fixtures.mjs, so the reference numbers below are the audit's numpy numbers.
//   S1_noCD3      no CD3 channel at all: a CD3 gate cannot be applied (not measured, NOT zero)
//   S2_CD3empty   CD3 present, nobody positive: a genuine 0
//   S3_CD3rare3   exactly 3 of 100,000 events CD3+, 2 of them CD4+ (0.003 % and 0.002 % of total)
//   S4_CD3normal  positive control: 30,000 CD3+, 20,000 CD3+CD4+
import { writeFCS } from '../../js/fcs.js';

export const N = 100000;
// Gates used by the tests: CD3+ (root) and CD4+ inside it, both 1000..262143 on a logicle axis.
export const GATES = [
  { id: 'g3', name: 'CD3+', parent: null, type: 'interval', x: 'CD3', x0: 1000, x1: 262143, color: '#0072B2' },
  { id: 'g4', name: 'CD4+', parent: 'g3', type: 'interval', x: 'CD4', x0: 1000, x1: 262143, color: '#D55E00' },
];

// Reference values computed independently with numpy from the written files (own minimal FCS reader, float32
// list mode; counts = ((CD3 >= 1000) & (CD3 < 262143)).sum() etc., % = 100 * count / denominator), see
// the audit's reference.py. null = not measurable (no CD3 channel).
export const REFERENCE = {
  S1_noCD3: { CD3: { count: null, pctParent: null, pctTotal: null }, CD4: { count: null, pctParent: null, pctTotal: null } },
  S2_CD3empty: { CD3: { count: 0, pctParent: 0, pctTotal: 0 }, CD4: { count: 0, pctParent: null /* 0 of 0 */, pctTotal: 0 } },
  S3_CD3rare3: { CD3: { count: 3, pctParent: 0.003, pctTotal: 0.003 }, CD4: { count: 2, pctParent: 66.66666666666667, pctTotal: 0.002 }, CD3median: 13284.1201171875 },
  S4_CD3normal: { CD3: { count: 30000, pctParent: 30, pctTotal: 30 }, CD4: { count: 20000, pctParent: 66.66666666666667, pctTotal: 20 } },
};

// Returns [{ name, bytes }] (bytes: ArrayBuffer of an FCS 3.1 file)
export function makeGateFixtures() {
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const neg = () => -200 + 700 * rnd();   // well below the 1000 gate edge
  const pos = () => 5000 + 50000 * rnd(); // well above it
  const make = (name, withCD3, nCD3pos, nCD3posCD4pos) => {
    const fsc = new Float32Array(N), ssc = new Float32Array(N), cd3 = new Float32Array(N), cd4 = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      fsc[i] = 20000 + 80000 * rnd(); ssc[i] = 5000 + 40000 * rnd();
      const p3 = i < nCD3pos; cd3[i] = p3 ? pos() : neg();
      cd4[i] = p3 ? (i < nCD3posCD4pos ? pos() : neg()) : (rnd() < 0.3 ? pos() : neg());
    }
    const names = withCD3 ? ['FSC-A', 'SSC-A', 'CD3', 'CD4'] : ['FSC-A', 'SSC-A', 'CD4'];
    const columns = withCD3 ? [fsc, ssc, cd3, cd4] : [fsc, ssc, cd4];
    return { name: `${name}.fcs`, bytes: writeFCS({ names, columns }) };
  };
  return [
    make('S1_noCD3', false, 30000, 20000),
    make('S2_CD3empty', true, 0, 0),
    make('S3_CD3rare3', true, 3, 2),
    make('S4_CD3normal', true, 30000, 20000),
  ];
}
