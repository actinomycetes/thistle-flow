"""Compare the event values Thistle Flow reads (dump_fcs.mjs) with an independent reading.

Reference: flowio reads the raw values from the file; they are then decoded by the FCS standard's rules
(integer bit mask from $PnR, log amplification $PnE, gain $PnG for integer data only, as FCS 3.2 says).
flowio's own preprocessing is also shown: it differs on purpose for Time ($TIMESTEP, seconds) and for
$PnG on floating-point data.
"""
import json, sys, os, glob, warnings
import numpy as np, flowio
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fcsref import standard_decode

warnings.filterwarnings('ignore')
TOL = 1e-6   # relative; float32 storage gives ~6e-8


def rel(a, b):
    return float(np.max(np.abs(a - b) / np.maximum(1.0, np.abs(b)))) if len(b) else 0.0


ok = check = 0
for mf in sorted(f for f in glob.glob(sys.argv[1] + '/*.json') if not f.endswith('.comp.json')):
    m = json.load(open(mf)); name = os.path.basename(m['file'])
    if 'error' in m:
        print(f'CHECK  {name}: Thistle Flow could not read it: {m["error"]}'); check += 1; continue
    try:
        fd = flowio.FlowData(m['file'], ignore_offset_discrepancy=True, ignore_offset_error=True)
    except Exception as e:
        try:
            fd = flowio.read_multiple_data_sets(m['file'], ignore_offset_discrepancy=True, ignore_offset_error=True)[0]
        except Exception as e2:
            print(f'  ?    {name}: flowio could not read it ({e2}); Thistle Flow read {m["events"]} events'); continue
    tf = np.fromfile(mf[:-5] + '.bin', dtype=np.float64).reshape(m['events'], len(m['names']))
    ref = standard_decode(fd)
    if ref.shape != tf.shape:
        print(f'CHECK  {name}: {tf.shape[0]} events × {tf.shape[1]} channels in Thistle Flow, {ref.shape[0]} × {ref.shape[1]} in flowio'); check += 1; continue
    worst = max(((rel(tf[:, j], ref[:, j]), n) for j, n in enumerate(m['names'])), default=(0, ''))
    notes = list(m.get('warnings') or [])
    try:
        pre = fd.as_array(preprocess=True)
        diff = [n for j, n in enumerate(m['names']) if rel(tf[:, j], pre[:, j]) > TOL]
        if diff:
            notes.append('differs from flowio preprocessing only in ' + ', '.join(diff[:4]) + (' …' if len(diff) > 4 else '')
                         + ' (Time units / gain on float data; see README)')
    except Exception:
        pass
    verdict = 'OK   ' if worst[0] <= TOL else 'CHECK'
    ok += worst[0] <= TOL; check += worst[0] > TOL
    print(f'{verdict}  {name} (FCS{fd.header["version"]}, {tf.shape[0]:,} events, {tf.shape[1]} channels): '
          f'largest difference {worst[0]:.1e}' + (f' in {worst[1]}' if worst[0] > TOL else ''))
    for n in notes:
        print(f'         note: {n}')
print(f'\n{ok} file(s) OK, {check} to check' + ('' if not check else ' (send the CHECK lines to the maintainer)'))
