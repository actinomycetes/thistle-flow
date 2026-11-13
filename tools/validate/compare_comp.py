import json, glob, sys, numpy as np, flowio
from flowutils import compensate
for mf in glob.glob(sys.argv[1] + '/*.comp.json'):
    m = json.load(open(mf)); tf = np.fromfile(mf[:-5] + '.bin').reshape(m['n'], -1)
    fd = flowio.FlowData(m['file'], ignore_offset_discrepancy=True)
    ev = fd.as_array(preprocess=False)[:m['n']].astype(np.float64)
    # flowutils: compensate(events, spill_matrix, fluoro_indices) -> (data @ inv(spill)) on those columns
    ref = compensate.compensate(ev.copy(), np.array(m['spill'], dtype=float), m['idx'])[:, m['idx']]
    print(mf.split('/')[-1], 'channels', len(m['idx']), 'max rel diff vs flowutils', f"{np.max(np.abs(tf-ref)/np.maximum(1, np.abs(ref))):.2e}")
