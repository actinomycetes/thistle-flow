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
- **Tab icon (favicon)**: the app's thistle, scaled into a 32×32 viewBox with `transform="translate(-1 0) scale(1.08)"`,
  plus an app badge in the bottom-right corner (TP: a blue table; TF: a laser hitting a cell: dark disc with a
  sky-blue rim, red beam from the upper left, cyan cell, three cyan scatter strokes). TF keeps its own dotted thistle
  head (as in the header logo); the header logo itself stays the plain thistle. The same data: URI is in `index.html`
  and `help.html` (`test/files.test.js` checks they match).
- **iPad**: the file picker cannot filter custom extensions, so `accept` is dropped on iOS (`IS_IOS` in `js/ui.js`).

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
