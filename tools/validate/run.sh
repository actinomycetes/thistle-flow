#!/usr/bin/env bash
# Cross-check Thistle Flow's calculations against independent open-source implementations:
#   FCS reading      vs flowio (FlowKit project)      on FlowIO's collection of real FCS 2.0/3.0/3.1 files
#   compensation     vs flowutils.compensate          on the same files' embedded spillover matrices
#   Logicle/arcsinh  vs flowutils.transforms / numpy
# Needs Python 3.10+, Node 18+, git and internet access. Run from the repository root:  bash tools/validate/run.sh
set -euo pipefail
cd "$(dirname "$0")"
W=.work; mkdir -p "$W/out"
[ -d "$W/venv" ] || python3 -m venv "$W/venv"
"$W/venv/bin/pip" -q install numpy flowio flowutils
[ -d "$W/FlowIO" ] || git clone -q --depth 1 https://github.com/whitews/FlowIO.git "$W/FlowIO"
rm -f "$W"/out/*
find "$W/FlowIO/data" \( -iname '*.fcs' -o -iname '*.lmd' \) -print0 | xargs -0 node dump_fcs.mjs "$W/out"
find "$W/FlowIO/data" -iname '*.fcs' -print0 | xargs -0 node dump_comp.mjs "$W/out" >/dev/null 2>&1 || true
echo "== FCS values (relative difference; Time differs only by \$TIMESTEP scaling, see README)"
"$W/venv/bin/python" -I compare_fcs.py "$W/out"
echo "== Compensation"
"$W/venv/bin/python" -I compare_comp.py "$W/out"
echo "== Transforms"
node dump_transforms.mjs | "$W/venv/bin/python" -I compare_transforms.py
