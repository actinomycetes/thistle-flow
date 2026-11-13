import json, sys, os, glob, numpy as np, flowio
out = sys.argv[1]
for meta_f in sorted(f for f in glob.glob(out + '/*.json') if not f.endswith('.comp.json')):
    m = json.load(open(meta_f)); f = m['file']; name = os.path.basename(f)
    if 'error' in m:
        print(f'{name}: TF ERROR {m["error"]}'); continue
    tf = np.fromfile(meta_f[:-5] + '.bin', dtype=np.float64).reshape(m['events'], len(m['names']))
    try:
        fd = flowio.FlowData(f, ignore_offset_discrepancy=True)
    except Exception as e:
        print(f'{name}: flowio error {e}'); continue
    try: ref = fd.as_array(preprocess=True)
    except Exception:
        # flowio cannot preprocess (e.g. $TIMESTEP is not a number): decode its raw values per the FCS
        # standard instead ($PnR bit mask, $PnE log amplification, $PnG gain for integer data)
        t = fd.text; ref = fd.as_array(preprocess=False).astype(float)
        for i in range(ref.shape[1]):
            f1, f2 = [float(v) for v in t.get(f'p{i+1}e', '0,0').split(',')]
            r = float(t[f'p{i+1}r']); g = float(t.get(f'p{i+1}g', '1') or 1) or 1
            if t.get('datatype', 'F').upper() == 'I':
                v = np.bitwise_and(ref[:, i].astype(np.int64), 2 ** int(np.ceil(np.log2(r))) - 1).astype(float) if r > 1 else ref[:, i]
                ref[:, i] = (f2 if f2 > 0 else 1) * 10 ** (f1 * v / r) if f1 > 0 else v / g
    raw = fd.as_array(preprocess=False)
    ver = fd.header['version']
    line = f'{name} (FCS{ver}, {fd.event_count} ev, {fd.channel_count} ch): TF {m["events"]} ev'
    if ref.shape != tf.shape:
        print(line, 'SHAPE', ref.shape, tf.shape); continue
    worst = []
    for j, n in enumerate(m['names']):
        a, b = tf[:, j], ref[:, j]
        rel = np.max(np.abs(a - b) / np.maximum(1e-9, np.abs(b))) if len(b) else 0
        # time is scaled by $TIMESTEP in flowio preprocessing; TF keeps raw time
        rel_raw = np.max(np.abs(a - raw[:, j]) / np.maximum(1e-9, np.abs(raw[:, j]))) if len(b) else 0
        worst.append((min(rel, rel_raw), n, rel, rel_raw))
    worst.sort(reverse=True)
    print(line, '| worst rel. diff vs flowio (preprocessed / raw):', ', '.join(f'{n} {r:.2e}/{rr:.2e}' for _, n, r, rr in worst[:3]))
