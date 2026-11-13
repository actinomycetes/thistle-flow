"""FCS-standard decoding of the raw values flowio reads (shared by the comparison scripts)."""
import numpy as np


def standard_decode(fd):
    t = fd.text
    raw = fd.as_array(preprocess=False).astype(float)
    ref = raw.copy()
    integer = t.get('datatype', 'F').upper() == 'I'
    for i in range(ref.shape[1]):
        f1, f2 = [float(v) for v in (t.get(f'p{i+1}e', '0,0') or '0,0').split(',')[:2]]
        r = float(t.get(f'p{i+1}r', '262144'))
        g = float(t.get(f'p{i+1}g', '1') or 1) or 1
        if integer:
            v = raw[:, i]
            if r > 1:
                v = np.bitwise_and(v.astype(np.int64), 2 ** int(np.ceil(np.log2(r))) - 1).astype(float)
            ref[:, i] = (f2 if f2 > 0 else 1) * 10 ** (f1 * v / r) if f1 > 0 else v / g
    return ref
