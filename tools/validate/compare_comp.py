"""Compare Thistle Flow's compensated values (dump_comp.mjs) with flowutils.compensate on the same
decoded data and the same spillover matrix."""
import json, glob, sys, os, warnings
import numpy as np, flowio
from flowutils import compensate
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fcsref import standard_decode

warnings.filterwarnings('ignore')
TOL = 1e-6
files = sorted(glob.glob(sys.argv[1] + '/*.comp.json'))
if not files:
    print('No file with a usable spillover matrix (nothing to compare).')
for mf in files:
    m = json.load(open(mf)); name = os.path.basename(m['file'])
    tf = np.fromfile(mf[:-5] + '.bin').reshape(m['n'], -1)
    fd = flowio.FlowData(m['file'], ignore_offset_discrepancy=True, ignore_offset_error=True)
    ev = standard_decode(fd)[:m['n']]
    # flowutils: data on the matrix channels multiplied by the inverse of the spillover matrix
    ref = compensate.compensate(ev.copy(), np.array(m['spill'], dtype=float), m['idx'])[:, m['idx']]
    d = float(np.max(np.abs(tf - ref) / np.maximum(1, np.abs(ref))))
    print(f"{'OK   ' if d <= TOL else 'CHECK'}  {name}: {len(m['idx'])} channels, first {m['n']:,} events, largest difference {d:.1e}")
