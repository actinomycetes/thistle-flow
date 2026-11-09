# Thistle Flow

Sister project of [Thistle Plot](https://github.com/actinomycetes/thistle-plot).

**Hosted copy:** https://actinomycetes.github.io/thistle-flow/

A lightweight, browser-based alternative to FlowJo for everyday flow cytometry analysis.
Load FCS files from any cytometer, gate hierarchically, compute statistics and MFIs for many
samples at once, and build overlay figures. Nothing to install and no build step. All processing
happens on your computer and no data is uploaded.

## Running it

**Option A: single file, no server.**
```bash
npm run build        # writes dist/thistle-flow.html
```
Then double-click `dist/thistle-flow.html`. You can copy this one 120 KB file to any lab PC.

**Option B: development server.** The app uses ES modules, so it needs `http://` instead of opening the file directly:
```bash
npm start            # python3 -m http.server 8080
```
Then open http://localhost:8080. Click **Load demo data** to try it without your own files.

Tests: `npm test` runs the parser, Logicle, compensation and gating checks in Node 18+.

## Features

| Area | What you get |
|---|---|
| **File support** | FCS 2.0 / 3.0 / 3.1 / 3.2. Float, double and integer data in both byte orders. `$PnE` log-amplified integer channels (legacy FACSCalibur/FACScan) are decoded. Files with multiple datasets (`$NEXTDATA`, e.g. Beckman `.LMD`) are split into separate samples. TEXT segments can be UTF-8 or Latin-1. |
| **Verified to parse** | BD FACSDiva (Aria/Fortessa-class), BD Accuri C6+, FACSCalibur, FACScan, Thermo **Attune NxT**, **Sony** S1400EXi, Bio-Rad S3, Beckman Navios and FC500, plus the synthetic demo files |
| **Compensation** | Reads the embedded `$SPILLOVER` / `SPILL` / `$COMP` matrix. Channel names are matched by `$PnN`, then by `$PnS`. Sony `APPLY_COMPENSATION=FALSE` is respected. You can edit the matrix, apply it to all samples, and import or export it as CSV. Spectral files (Sony ID7000/SA3800, Cytek) are usually already unmixed. |
| **Axis scales** | Linear, Log, **Biexponential (Logicle**, Parks/Moore reference algorithm) and Arcsinh (with cofactor). Scales are set per channel. The top of the scale defaults to the instrument's `$PnR` range. The Logicle dialog has an **Auto W** button. |
| **Plots** | Pseudocolor density, dot plots and histograms. Off-scale events pile up on the axes, as in FlowJo. Each plot can be saved as PNG. |
| **Gates** | Rectangle, Polygon, Ellipse, Quadrant (4 linked gates) and Range (on histograms). Gates form a hierarchy. You can drag a gate to move it, drag its vertices or handles to reshape it, and double-click inside a gate to open a plot of that population. Gates are **shared by all samples** (like a FlowJo group), so you gate once and get results for every sample. |
| **Statistics** | Count, % Parent, % Total, **Median (MFI)**, Mean, Geometric mean, SD, CV, robust SD and robust CV, for any population and channel. Choose a long, wide or transposed table. Export as CSV or copy straight into Excel/Prism. |
| **Layout & overlays** | Histogram overlays of any mix of sample and population: normalised to mode or by count, **staggered offset**, smoothing, fill and custom colours. You can also overlay dot plots coloured by series, or use **Batch** view (the same plot for every sample, with gate %). Export single figures or the whole layout as PNG. |
| **Export / save** | Export the events of any population as a new FCS 3.1 file. Save the workspace (gates, scales, plots, figures, compensation) to JSON and reload it later onto the same files. |

### Keyboard shortcuts (Gating tab)
`V` select · `R` rectangle · `P` polygon · `E` ellipse · `Q` quadrant · `I` range ·
`Delete` delete the selected gate · `Esc` cancel drawing (right-click also cancels a polygon).
To close a polygon, double-click or click its first point.

## Notes on accuracy
* MFIs and other statistics use **compensated, untransformed** values, matching FlowJo's defaults.
  The geometric mean ignores events ≤ 0. For populations that contain many negative values, use the median.
* Gate membership is tested in the displayed (transformed) coordinate space. This means a polygon
  covers the same region you drew. If you later change a channel's scale, straight polygon edges
  follow the new scale.
* Dragging a gate vertex onto an axis extends the gate past that edge, so piled-up off-scale events are included.

## Architecture
Plain JavaScript (ES modules) with no dependencies. Drawing uses Canvas 2D.

```
js/fcs.js         FCS parser + minimal FCS 3.1 writer
js/transforms.js  linear / log / arcsinh / Logicle (+ LUT-accelerated) and axis ticks
js/model.js       Sample: compensation (spillover inverse) and cached transformed columns
js/gates.js       gate hierarchy, membership masks (cached per sample), statistics
js/render.js      density / dot / histogram / overlay / gate rendering
js/plotview.js    interactive plot: drawing and editing gates
js/demo.js        synthetic T-cell activation dataset (written as real FCS files)
js/app.js         UI controller: samples, gate tree, tabs, modals, workspace I/O
tools/build.mjs   bundles everything into dist/thistle-flow.html
tools/inspect.mjs CLI: node tools/inspect.mjs file.fcs → parse summary
```

Rough performance on a laptop, for 1,000,000 events × 20 channels: parse about 0.1 s, compensation (17×17) about 0.5 s,
Logicle transform about 80 ms per channel, polygon gate about 70 ms. All of these results are cached.

## Not (yet) included
* Per-sample gate adjustments (gates are currently global to all samples)
* FlowJo `.wsp` and Gating-ML import or export
* Derived parameters, ratios, and dimensionality reduction (tSNE/UMAP)
* Unmixing raw spectral data (load files already unmixed by the instrument software)
* Running the work in a Web Worker for multi-million-event files
