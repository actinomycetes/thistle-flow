import json, sys, numpy as np
from flowutils import transforms
d = json.load(sys.stdin); xs = np.array(d['xs'], dtype=float)
for o in d['out']:
    ref = transforms.logicle(xs.reshape(-1, 1).copy(), [0], t=o['T'], m=o['M'], w=o['W'], a=o['A']).ravel()
    fwd = np.array(o['fwd']); inv = np.array(o['inv'])
    rt = np.max(np.abs(inv - xs) / np.maximum(1, np.abs(xs)))
    dd = np.max(np.abs(fwd - ref))
    print(f"{'OK   ' if dd < 1e-6 and rt < 1e-5 else 'CHECK'}  Logicle T={o['T']:<7} W={o['W']:<4} M={o['M']} A={o['A']:<5} largest difference {dd:.1e} display units (round trip {rt:.1e})")
for a in d['as']:
    cof = a['cof']; smin = np.arcsinh(-1000/cof); smax = np.arcsinh(262144/cof)
    ref = (np.arcsinh(xs/cof) - smin) / (smax - smin)
    dd = np.max(np.abs(np.array(a['fwd']) - ref))
    print(f"{'OK   ' if dd < 1e-9 else 'CHECK'}  arcsinh cofactor {cof}: largest difference {dd:.1e}")
