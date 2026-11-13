#!/usr/bin/env bash
# Cross-check Thistle Flow's calculations against independent open-source implementations:
#   FCS reading      vs flowio (FlowKit project) + the FCS standard's decoding rules
#   compensation     vs flowutils.compensate, using each file's own spillover matrix
#   Logicle/arcsinh  vs flowutils.transforms / numpy
#
# Usage (from the repository folder):
#   bash tools/validate/run.sh                      # FlowIO's collection of example files (downloaded)
#   bash tools/validate/run.sh ~/Data/run1 a.fcs    # your own files and/or folders (searched for .fcs/.lmd)
#
# Needs Node 18+, Python 3.9+ and (for the example files) git. The first run installs numpy, flowio and
# flowutils into tools/validate/.work/venv; your FCS files are only read, never changed or uploaded.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
W="$HERE/.work"; OUT="$W/out"
mkdir -p "$W"; rm -rf "$OUT"; mkdir -p "$OUT"
trap 'rm -rf "$OUT"' EXIT   # intermediate copies of your data are always removed

PY=""
for c in python3 python py; do   # the first Python 3 that really runs (on Windows "python3" can be a Store placeholder)
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "Python 3.9 or newer is needed (https://www.python.org/downloads/)"; exit 1; }
command -v node >/dev/null || { echo "Node.js is needed (https://nodejs.org/)"; exit 1; }
if [ ! -d "$W/venv" ]; then echo "Setting up Python packages (first run only)…"; "$PY" -m venv "$W/venv"; fi
VPY="$W/venv/bin/python"; [ -x "$VPY" ] || VPY="$W/venv/Scripts/python.exe"   # Windows (Git Bash)
"$VPY" -m pip -q install --disable-pip-version-check numpy flowio flowutils

FILES=()
if [ $# -eq 0 ]; then
  [ -d "$W/FlowIO" ] || git clone -q --depth 1 https://github.com/whitews/FlowIO.git "$W/FlowIO"
  set -- "$W/FlowIO/data"
fi
for p in "$@"; do
  if [ -d "$p" ]; then while IFS= read -r -d '' f; do FILES+=("$f"); done < <(find "$p" -type f \( -iname '*.fcs' -o -iname '*.lmd' \) -print0)
  elif [ -f "$p" ]; then FILES+=("$p")
  else echo "Not found: $p"; fi
done
[ ${#FILES[@]} -gt 0 ] || { echo "No .fcs or .lmd files found."; exit 1; }
echo "Checking ${#FILES[@]} file(s)…"

node "$HERE/dump_fcs.mjs" "$OUT" "${FILES[@]}"
node "$HERE/dump_comp.mjs" "$OUT" "${FILES[@]}" >/dev/null 2>&1 || true
echo
echo "== 1. Reading the files (every event, every channel)"
"$VPY" -I "$HERE/compare_fcs.py" "$OUT"
echo
echo "== 2. Compensation with each file's own spillover matrix"
"$VPY" -I "$HERE/compare_comp.py" "$OUT"
echo
echo "== 3. Display scales (Logicle, arcsinh)"
node "$HERE/dump_transforms.mjs" | "$VPY" -I "$HERE/compare_transforms.py"
