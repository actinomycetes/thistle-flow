# Thistle Flow (TF): project guide for Claude Code

TF is a **beta** (0.x) flow cytometry analysis app for bench scientists (UoE TT lab), the sister app of
[Thistle Plot](https://github.com/actinomycetes/thistle-plot) (TP). Plain JavaScript ES modules, no framework,
no runtime dependencies. GitHub Pages serves `index.html` + `js/` + `css/` + `help.html`; `npm run build`
makes a single-file `dist/thistle-flow.html` for offline lab PCs. Data never leaves the browser.

## Ground rules
- Keep the look and conventions in step with TP: slate palette with dark as the default, the thistle icon, BETA and
  version badges in the header, emoji button icons, underline-style tabs, blue hint boxes, plain-words UI text for bench
  scientists (British spelling is fine).
- Everything is **beta 0.x**. Do not call it validated; Help says results must be spot-checked.
- Statistics use compensated, untransformed values; gate membership is tested in the displayed (transformed) space.
- `localStorage` only for per-viewer preferences (theme, pane sizes). Analyses are saved as `.tflow` workspace / template files (see Thistle suite conventions).
- **Kept session (v0.19.0, as in Thistle Notebook):** the open workspaces and their FCS files are also copied to IndexedDB
  (`js/session.js`, database `thistle-flow-session`: `kv/session` + `files/<key>`, each file stored once) about 0.8 s
  after a change (`keepSoon()` from `renderAll` / `scheduleCommit`, and on `pagehide`), and `restoreSession()` reopens
  them on load with a notice offering **Start fresh**. Off inside an iframe (Thistle Notebook embeds TF) and with
  `?nosession`. No "leave page?" warning when `sessionKept()`. Any new workspace state must be in `serialize()` to be
  kept. `test/e2e/keep.e2e.test.mjs` covers it. The maintainer may revert this if it confuses users.
- No network access at runtime. The single-file build must keep working from `file://`.
- Never modify the user's FCS files; metadata edits live in the workspace and in exported copies.

- README.md: the text between `<!-- MAINTAINER SECTION START` and `<!-- MAINTAINER SECTION END -->` belongs to the
  maintainer. Never rewrite, reorder or "tidy" it; keep it word for word when updating the README, and pull `main`
  before editing (the maintainer may have edited it on GitHub). Change it only when explicitly asked.

## Thistle suite conventions (decided by the maintainer, shared with Thistle Plot)
- **One extension per app**: Thistle Flow saves `.tflow` for everything it saves (workspaces with or without the FCS
  files, and templates); Thistle Plot saves `.tplot`; future apps follow `.t<name>`. Exports (CSV, PNG/SVG/PDF,
  population FCS) keep their own formats.
- **Header first**: a saved JSON starts with `{"app": "Thistle Flow", "format": <integer>, "appVersion": "x.y.z",
  "kind": "workspace" | "template", ...}` (`fileHeader()` in `js/workspace.js`). A workspace with its FCS files is a zip
  container under the same extension (`workspace.json` + `fcs/…`); the type is recognised from the contents
  (zip magic bytes, then `kind`). Bump `FILE_FORMAT` when the saved structure changes. Format history: 1 = FlowLite,
  2 = `ThistleFlow` `.json`/`.zip` (stored as `version`), 3 = `.tflow`.
- **Keep opening older files**: `.json`/`.zip` with `app: 'ThistleFlow'` or `'FlowLite'` (`fileFormat()` reads
  `format`, or `version` before format 3). Never drop this.
- **Files from other Thistle apps** get a plain message, not a parse error (`checkThistleFlowFile()`), e.g.
  "This is a Thistle Plot project; open it in Thistle Plot (https://actinomycetes.github.io/thistle-plot/)."
- **Suite icon (tab icon and header logo)**: the thistle (dotted head, shared across the suite), scaled into a 32×32
  viewBox with `transform="translate(-1 0) scale(1.08)"`, plus an app badge in the bottom-right corner (TP: a blue table;
  TF: a laser hitting a cell: dark disc with a sky-blue rim, red beam from the upper left, cyan cell, three cyan scatter
  strokes). Since v0.17.2 the same picture is the header logo (`<svg class="app-logo">`, 30 px, top left) as well as the
  favicon. Write the favicon exactly as `<link rel="icon" href="data:image/svg+xml,...">`: NO `type` attribute and every
  character escaped (`encodeURIComponent`, then `(`→`%28`, `)`→`%29`). Safari on iPad showed only this form (v0.17.1);
  Thistle Plot's `type="image/svg+xml"` icon never appeared there.
  Keep `document.title = ...` in `js/app.js`: Orion 1.1 (WebKit) showed the icon only on pages that set the title from
  script (TF had it; TP v0.17.1 and TN v0.5.1 copied it). A 180×180 PNG of the icon on the slate background
  is given as `apple-touch-icon`.
  `index.html` and `help.html` carry the same icon, logo and PNG (`test/files.test.js` checks they match).
- **Tables between apps (TF → TP, v0.20.0)**: `openStatsInThistlePlot()` opens TP in a new tab
  (`TP_URL#from=thistle-flow`) and hands over the Statistics table by `postMessage`: TP → opener
  `{type:'thistle-ready', app:'Thistle Plot'}`; TF → that tab `{type:'thistle-table', version:1, from, appVersion,
  title, csv, rows, columns}` (wide layout: header row, first column = sample names, as TP's CSV import reads it);
  TP → opener `{type:'thistle-table-received', rows, columns}`. Only messages from/to the opened tab (`event.source`),
  addressed to its origin. Fallback when TP does not answer: Export CSV → TP's ⬆ Open CSV (reads the wide table
  correctly); do NOT suggest pasting (TP's paste fills values into its existing replicate grid and drops headers). `test/e2e/fake-tp.html` is the
  stand-in used by the e2e test; keep it in step with TP's receiver. Works end to end with TP ≥ 0.15.0 (checked on the
  live sites; TP's receiver accepts origins `https://actinomycetes.github.io` and its own, so a TF opened from a local
  file falls back to Export CSV → Open CSV).
- **Statistics: blank = not measured; exports at full precision (v0.21.0, audit case 14)**: a population whose gate,
  or any gate above it, needs a channel the sample lacks is not measured: `populationStats()` returns
  `{available: false, missing: [...], count/pctParent/pctTotal: NaN}` (`GateEngine.missingChannels()`), `statValue()`
  gives NaN for its per-channel statistics, and every place shows a blank (gate tree: "–" with "CD3 not in this sample"
  as tooltip; `#statsNote` under the table says why). Never turn it into 0; a measurable empty gate is 0. On screen,
  `formatStat()` rounds (small non-zero % keep 2 significant figures); CSV, Copy and Open in Thistle Plot use
  `exportStat()` (full precision, blank for NaN). Each value cell of `#statsTable` carries its raw number in `data-v`
  (`data-v=""` when blank) for other apps reading the table (Thistle Notebook). The gate tree's ⤓ FCS export is disabled for an
  unavailable population and `exportPopulation` refuses it (returns false; v0.21.1, re-review): a 0-event file would read
  as measured. A measurable empty gate still exports a valid 0-event file. `test/availability.test.js` and
  `test/e2e/availability.e2e.test.mjs` (fixtures from `test/fixtures/gate-availability.mjs`, numpy reference numbers).
- **iPad**: the file picker cannot filter custom extensions, so `accept` is dropped on iOS (`IS_IOS` in `js/ui.js`).
- **Colours (both themes, colour-blind readers)**: every text colour must reach WCAG AA (4.5:1, 3:1 for large text)
  on its real background in dark AND light mode, and no box may keep a dark-mode background in light mode; use the
  theme variables (`--accent` for fills with white text, `--accent-tx` for blue text, `--danger`, `--warn-tx`,
  `--hint-*`, `--badge-bg`), never a hard-coded dark colour. `test/e2e/theme.e2e.test.mjs` audits every tab and Help.
  Data colours are colour-blind safe: gates and overlay series use Okabe–Ito hues at mid brightness (`GATE_COLORS`,
  `SERIES_COLORS`, ≥3:1 on white and on dark navy, because labels are drawn in the gate colour); the pseudocolor
  scale is viridis (`STOPS` in `js/render.js`). Never use a rainbow/jet scale or red next to green to carry meaning.

## Commands
```bash
npm test                                         # unit tests (Node 18+, no install needed)
npm install && npx playwright install chromium   # once, for the browser tests
npm run test:e2e                                 # end-to-end UI test (TF_BROWSER=firefox|webkit for other engines)
npm run build                                    # dist/thistle-flow.html
npm start                                        # http://localhost:8080
```

## Release checklist (every change that users will see)
1. Bump the version everywhere: `js/version.js` (`APP_VERSION`), `<title>` and the `#app-version` badge in
   `index.html`, `package.json`, `CITATION.cff`, and `help.html` (`<title>`, header badge, the beta note and
   "Known limitations of vX.Y.Z"). `test/version.test.js` checks that these agree.
2. Add a row at the top of the version history table in `help.html` (version, date, `Thistle Flow`, what changed).
3. `npm test` and `npm run test:e2e` must pass. New feature means new test.
4. Commit with a message like `v0.3.1: <summary>` and push to `main`. Do not tag by hand: after CI passes,
   `.github/workflows/release.yml` tags the last commit carrying the version and publishes a GitHub pre-release
   with `dist/thistle-flow.html` attached and notes from the help.html history row (`tools/release-notes.mjs`).
   The workflow token can only tag commits whose `.github/workflows/` files match `main`, so the release target is
   the last commit of the version with the current workflow files; change workflows before (not after) bumping
   a version you still want released. (Repository setting needed once:
   Settings → Actions → General → Workflow permissions → Read and write.)
Versioning: 0.MINOR.PATCH. Fixes bump PATCH, new features bump MINOR; 1.0 only after validation.

## Architecture map
- `js/fcs.js` parser/writer · `js/transforms.js` scales (Logicle) · `js/model.js` `Sample` (compensation, cached
  transformed columns, metadata edits) · `js/gates.js` `GateEngine` (hierarchy, cached masks, statistics).
- `js/workspace.js` `Workspace` = one tab: state, per-mode undo/redo (`snapshot`/`restore`/`commit`), workspace
  files (`serialize`/`deserialize`), templates (`template`/`applyTemplate`). `app.scheduleCommit()` records changes
  after user interactions; any new state must be added to the right mode's `snapshot`.
- `js/render.js` draws everything through the Canvas API; `js/vector.js` provides canvas-compatible SVG/PDF
  contexts, so new drawing code must use only the Canvas subset implemented there (and `drawRaster` for bitmaps).
- `js/plotview.js` interactive gating plot · `js/figureview.js` interactive Layout figure · `js/properties.js` Properties tab · `js/ui.js` dialogs and saving ·
  `js/app.js` controller.
- `tools/build.mjs` concatenates the modules in dependency order (add new modules to `order`).
