# Thistle Flow (TF) — beta

Part of the Thistle suite, together with [Thistle Plot](https://github.com/actinomycetes/thistle-plot) (TP).

**Status:** beta (0.x; current v0.14.0). Check important results against an established package before publishing. Version history: [`help.html#history`](help.html#history).

**Hosted copy:** https://actinomycetes.github.io/thistle-flow/

Flow cytometry analysis in the browser. Load FCS files from any cytometer, gate hierarchically,
compute statistics and MFIs for many samples at once, and build overlay figures. Nothing to
install. All processing happens on your computer and no data is uploaded.

<!-- MAINTAINER SECTION START: written by the maintainer; kept word for word in every version. Edit freely. -->

<!-- MAINTAINER SECTION END -->

## Running it

**Option A: single file, no server.**
```bash
npm run build        # writes dist/thistle-flow.html
```
Then double-click `dist/thistle-flow.html`. You can copy this one file (about 200 KB) to any lab PC. Its Help button links to the hosted manual.

**Option B: development server.** The app uses ES modules, so it needs `http://` instead of opening the file directly:
```bash
npm start            # python3 -m http.server 8080
```
Then open http://localhost:8080. Click **🧪 Demo data** to try it without your own files. The manual is [`help.html`](help.html) (the **❓ Help** button, or F1).

Tests:
* `npm test` runs the unit tests in Node 18+ with no dependencies: parser, Logicle, compensation, gating, contours, SVG/PDF writers, undo/redo, workspaces and templates.
* `npm run test:e2e` drives the real app in a browser with Playwright. Run `npm install && npx playwright install chromium` once first. Set `TF_BROWSER=firefox` or `webkit` to use another engine. CI runs all three.

## Features

| Area | What you get |
|---|---|
| **File support** | FCS 2.0 / 3.0 / 3.1 / 3.2. Float, double and integer data in both byte orders. `$PnE` log-amplified integer channels (legacy FACSCalibur/FACScan) are decoded. Files with multiple datasets (`$NEXTDATA`, e.g. Beckman `.LMD`) are split into separate samples. TEXT segments can be UTF-8 or Latin-1. |
| **Verified to parse** | BD FACSDiva (Aria/Fortessa-class), BD Accuri C6+, FACSCalibur, FACScan, Thermo **Attune NxT**, **Sony** S1400EXi, Bio-Rad S3, Beckman Navios and FC500, plus the synthetic demo files |
| **Compensation** | Reads the embedded `$SPILLOVER` / `SPILL` / `$COMP` matrix. Channel names are matched by `$PnN`, then by `$PnS`. Sony `APPLY_COMPENSATION=FALSE` is respected. You can edit the matrix with **live preview plots** (one per matrix value, redrawn while you type or nudge values with ↑/↓, before applying), apply it to all samples, and import or export it as CSV. Spectral files (Sony ID7000/SA3800, Cytek) are usually already unmixed. Compensation has its own tab next to Gating. |
| **Axis scales** | Linear, Log, **Biexponential (Logicle**, Parks/Moore reference algorithm) and Arcsinh (with cofactor). Scales are set per channel. The top of the scale defaults to the instrument's `$PnR` range. The Logicle dialog has an **Auto W** button. |
| **Plots** | **Pseudocolor** (event dots coloured by density, adjustable dot size), **Density** (smoothed), **Contour** (equal-probability, with optional outlier dots), **Dot** and histograms. Off-scale events pile up on the axes. Clicking an axis opens a quick menu for that axis (channel and scale). **Select-to-zoom** with unzoom and reset (double-click; view only). A workspace-wide or per-plot **limit on events shown** (default 10,000) keeps plots readable; statistics always use every event. Plot sizes S to XL. **Dark** (default) and light mode. |
| **Gates** | Rectangle, Polygon, Ellipse, Quadrant (4 linked gates, labelled Q1–Q4 in plots; standard, **spider** with arms at any angle, or **offset** with staggered arms), Range and Split (left/right) on histograms, with a preview that follows the cursor, and **✨ Auto**: click a population to get a polygon gate around it. Gates form a hierarchy. After a gate is drawn the tool returns to **Select**, where you can drag a gate to move it, drag its vertices or handles to reshape it, **drag its label** anywhere inside the plot, and double-click inside a gate to open a plot of that population. Gates are **shared by all samples** in a workspace, so you gate once and get results for every sample; a gate can also be **adjusted for individual samples** (marked ✎, with one click back to the shared gate). |
| **Samples** | Drag the ☰ handle to change the order of the samples (used in Statistics, figures and overlays; saved with the workspace). |
| **Quick overlay** | Ctrl/⌘- or Shift-click samples to overlay them in every Gating plot, with each sample's % in the gate labels. |
| **Multiple plots** | Shift-click plots or drag a box around them. Then change the population, axes, type, events shown or size on one plot, and the change applies to all selected plots. |
| **Statistics** | Count, % Parent, % Total, **Median (MFI)**, Mean, Geometric mean, SD, CV, robust SD and robust CV, for any population and channel. Choose a long, wide or transposed table. Export as CSV or copy straight into Excel/Prism. |
| **Layout & overlays** | Histogram overlays of any mix of sample and population: normalised to mode or by count, **overlay, quarter, half or full offset** (or a custom offset), smoothing, fill and custom colours. You can also overlay dot plots coloured by series, use **Batch** view (the same plot for every sample, with gate %), or show the **gating strategy** of one sample (All Events → cells → singlets → … → your population, one plot per gate). **Population** sets the gate of every series at once (e.g. Singlets for all samples). Gate labels and sample labels can be dragged in figures, placed outside the plot or hidden, and **↔ Range gate** on a histogram overlay gates every sample at once, listing each sample's %. Export single figures or the whole layout as **PNG, SVG or PDF**, with vector axes, text, gates and contours. |
| **Workspaces** | Each **tab** is a workspace with its own samples and analysis. Click **+** for another group of samples. Closing a tab always asks whether to save. **Undo/redo** has a separate history for each mode (Gating, Compensation, Layout, Statistics, Properties). |
| **Properties** | Acquisition information from the FCS keywords: instrument, serial number, software, date and times, operator, experiment, tube or well, volume, lasers, and channel voltages, filters and lasers. Includes an editable keyword table. Edits (for example, fixing marker labels or adding the operator) are stored in the workspace and written into exported FCS files; the original files are never changed. There is also an acquisition summary CSV for all samples. |
| **Export / save** | Save the **workspace** (gates, scales, plots, figures, compensation, label positions, metadata edits), by default as **one .zip that includes the FCS files** and reopens with all its samples, or as a small .json. Opening a .json without its data asks for the folder (or the files) and matches them by name; ⇄ replaces a sample's FCS file. Save a **template**, which holds the same analysis with no sample data or file names, and apply it to new samples in any workspace. Saving shows a dialog with a date-stamped file name; Chrome and Edge also let you choose the folder. Export the events of any population as a new FCS 3.1 file. |

### Keyboard shortcuts
`V` select · `R` rectangle · `P` polygon · `E` ellipse · `Q` quadrant · `A` auto gate · `I` range ·
`Ctrl+Z` / `Ctrl+Shift+Z` undo / redo (current mode) · `Ctrl+S` save workspace · `Ctrl+A` select all plots ·
`Delete` delete the selected gate (or close the selected plots) · `Esc` cancel drawing or clear the selection · `F1` help.
To close a polygon, double-click or click its first point. Click an axis to change that channel's scale.

## Notes on accuracy
* MFIs and other statistics use **compensated, untransformed** values.
  The geometric mean ignores events ≤ 0. For populations that contain many negative values, use the median.
* Gate membership is tested in the displayed (transformed) coordinate space. This means a polygon
  covers the same region you drew. If you later change a channel's scale, straight polygon edges
  follow the new scale.
* Dragging a gate vertex onto an axis extends the gate past that edge, so piled-up off-scale events are included.

## Architecture
Plain JavaScript (ES modules) with no runtime dependencies. Drawing uses Canvas 2D. SVG and PDF exports reuse the same drawing code through canvas-compatible vector contexts.

```
js/fcs.js         FCS parser + minimal FCS 3.1 writer
js/transforms.js  linear / log / arcsinh / Logicle (+ LUT-accelerated) and axis ticks
js/model.js       Sample: compensation (spillover inverse) and cached transformed columns
js/gates.js       gate hierarchy, membership masks (cached per sample), statistics
js/render.js      pseudocolor / density / contour / dot / histogram / overlay / gate rendering, themes
js/vector.js      canvas-compatible SVG and PDF writers (vector export)
js/plotview.js    interactive plot: drawing and editing gates and labels, event subsampling
js/figureview.js  interactive Layout figure: label dragging, range gates on overlays
js/compview.js    compensation preview plots (matrix edits shown live before applying)
js/autogate.js    automatic gate: density basin around the clicked population, traced as a polygon
js/zip.js         dependency-free zip writer/reader for workspace bundles
js/workspace.js   one workspace tab: state, per-mode undo/redo, workspace files, templates
js/properties.js  Properties tab (acquisition keywords, channel table, editing)
js/ui.js          DOM helpers, dialogs, popovers, save-file handling
js/demo.js        synthetic T-cell activation dataset (written as real FCS files)
js/app.js         UI controller: workspace tabs, samples, gate tree, modes, export
js/version.js     APP_VERSION (single source; see CLAUDE.md for the release checklist)
help.html         user manual (served next to the app on GitHub Pages)
tools/build.mjs   bundles everything into dist/thistle-flow.html
tools/inspect.mjs CLI: node tools/inspect.mjs file.fcs → parse summary
```

Rough performance on a laptop, for 1,000,000 events × 20 channels: parse about 0.1 s, compensation (17×17) about 0.5 s,
Logicle transform about 80 ms per channel, polygon gate about 70 ms. All of these results are cached.

## Not (yet) included
* Per-sample gate adjustments (gates are currently global to all samples)
* Import or export of gating files from other software (e.g. Gating-ML)
* Derived parameters, ratios, and dimensionality reduction (tSNE/UMAP)
* Unmixing raw spectral data (load files already unmixed by the instrument software)
* Running the work in a Web Worker for multi-million-event files

## References
The biexponential scale implements the published Logicle algorithm:
* Parks DR, Roederer M, Moore WA. A new "Logicle" display method avoids deceptive effects of logarithmic scaling for low signals and compensated data. *Cytometry A* 2006;69(6):541–551.
* Moore WA, Parks DR. Update for the logicle data scale including operational code implementations. *Cytometry A* 2012;81(4):273–277.

## Citing
See [`CITATION.cff`](CITATION.cff), or use GitHub's "Cite this repository" button.

## Licence
[MIT](LICENSE) © 2026 Takanobu Tagawa (The University of Edinburgh).
