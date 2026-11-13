# Checking Thistle Flow's calculations (with your own FCS files)

`tools/validate/run.sh` reads FCS files with Thistle Flow's own code and compares every value with independent,
widely used open-source software:

| Check | Reference |
|---|---|
| 1. Reading the files: every event of every channel | [flowio](https://github.com/whitews/FlowIO) (FlowKit project), decoded by the FCS standard's rules |
| 2. Compensation with each file's own spillover matrix | `flowutils.compensate` (FlowKit project) |
| 3. Display scales (biexponential/Logicle, arcsinh) | `flowutils.transforms`, numpy |

Each line says **OK** or **CHECK**. OK means the values agree to better than one part in a million (differences of
about 6×10⁻⁸ are the normal rounding of 32-bit numbers in FCS files). Your files are only read: they are not changed,
not uploaded, and the temporary copies of their values are deleted when the check ends.

## Step by step

### 1. Install the tools (once)
- **Node.js** (the LTS version) from https://nodejs.org
- **Python 3** from https://www.python.org/downloads/ (on Windows tick *Add python.exe to PATH* in the installer)
- **Git** from https://git-scm.com (on Windows this also installs **Git Bash**, used below)

On a Mac you can check what is there by typing `node -v`, `python3 --version` and `git --version` in Terminal.

### 2. Get Thistle Flow's code (once)
Open **Terminal** (Mac) or **Git Bash** (Windows) and type:
```bash
git clone https://github.com/actinomycetes/thistle-flow.git
cd thistle-flow
```
Later, to update it: `cd thistle-flow` then `git pull`.

### 3. Run the check on your files
Give one or more folders (searched, with their subfolders, for `.fcs` and `.lmd` files) and/or single files.
Paths with spaces need quotes. On a Mac you can drag a folder from Finder into the Terminal window to type its path.
```bash
bash tools/validate/run.sh "/path/to/your/FCS folder"
```
Examples: `bash tools/validate/run.sh ~/Desktop/Fortessa_2026-11-01` (Mac),
`bash tools/validate/run.sh "/c/Users/you/Documents/FCS files"` (Git Bash on Windows: `C:\` is written `/c/`).
The first run takes a few minutes to set up the Python packages (needs internet); later runs start at once.
Without a path, the check uses a public collection of example files from many instruments.

### 4. Read the result
```
== 1. Reading the files (every event, every channel)
OK     Specimen_001_Tube_001.fcs (FCS3.1, 40,000 events, 14 channels): largest difference 5.9e-08
         note: differs from flowio preprocessing only in Time (Time units / gain on float data; see README)
...
12 file(s) OK, 0 to check
== 2. Compensation with each file's own spillover matrix
OK     Specimen_001_Tube_001.fcs: 8 channels, first 20,000 events, largest difference 6.0e-08
== 3. Display scales (Logicle, arcsinh)
OK     Logicle T=262144 W=0.5 ...
```
- **OK** on every line: Thistle Flow reads and compensates these files exactly like the reference software.
- **note:** lines explain intended differences or problems found in a file (below). They are not errors.
- **CHECK**: please send that line (not the file, unless you are allowed to share it) to the maintainer.
- A file missing from section 2 has no spillover matrix, or its matrix names channels that are not in the file.

Known, intended differences (shown as notes):
- **Time** stays in the instrument's units; flowio converts it to seconds with `$TIMESTEP`.
- **`$PnG` gain on floating-point data** is not applied (FCS 3.2 restricts `$PnG` to integer data); flowio divides by it.
- **HEADER and TEXT data offsets disagree**: FCS 3 files use `$BEGINDATA`/`$ENDDATA` from TEXT.
- Files with **several data sets**: the first one is compared.

### What this does not check
It checks reading, compensation and scales: the numbers every analysis is built on. It does not check your gates or
the final percentages and MFIs against the program you use now. For that, gate one or two samples the same way in both
programs and compare Count, % Parent and Median in Thistle Flow's Statistics tab; small differences in % come from
gates not drawn identically, not from the calculation.

(`npm run validate -- <paths>` does the same as `bash tools/validate/run.sh <paths>`.)
