// A workspace = one tab: a group of samples plus the analysis built on them
// (gates, axis scales, plots, layout figures, statistics settings, metadata edits),
// with per-mode undo/redo and (de)serialisation to workspace files and data-free templates.
import { GateEngine } from './gates.js';
import { defaultTransformFor } from './transforms.js';
import { APP_VERSION } from './version.js';

export const MODES = ['gating', 'comp', 'layout', 'stats', 'properties'];
const UNDO_LIMIT = 100;
let WS_N = 0;

const isScatterOrTime = ch => /^(FSC|SSC|BSC|FS|SS)|TIME|EVENT|WIDTH|^SAMPLEID/i.test(ch);

export class Workspace {
  constructor(name) {
    this.id = 'ws' + (++WS_N);
    this.name = name || `Workspace ${WS_N}`;
    this.samples = [];
    this.activeId = null;
    this.transforms = {};
    this.plots = [];
    this.figures = [];
    this.statsCfg = { pops: null, stats: ['count', 'pctParent', 'median'], channels: null, layout: 'long' };
    this.displayMax = 10000;   // events shown per 2-D plot (0 = all)
    this.selectedGate = null;
    this.focusedPlot = null;
    this.selPlots = new Set();
    this.selSamples = [];   // quick overlay in Gating (Ctrl/Shift-click in the sample list)
    this.tab = 'gating';
    this.engine = new GateEngine(ch => this.getCfg(ch));
    this.undo = Object.fromEntries(MODES.map(m => [m, []]));
    this.redo = Object.fromEntries(MODES.map(m => [m, []]));
    this.last = {};
    this.dirty = false;
    this.rebase();
  }

  // ---- channels ----
  activeSample() { return this.samples.find(s => s.id === this.activeId) || null; }
  sampleById(id) { return this.samples.find(s => s.id === id); }
  allChannels() {
    const seen = new Set(), out = [];
    for (const s of this.samples) for (const c of s.channelNames) if (!seen.has(c)) { seen.add(c); out.push(c); }
    return out;
  }
  channelLabel(ch) { const s = this.samples.find(x => x.hasChannel(ch)); return s ? s.label(ch) : ch; }
  fluorChannels() { return this.allChannels().filter(c => !isScatterOrTime(c) && !/-(H|W)$/i.test(c)); }

  // Display range for a channel = largest $PnR among loaded samples (log-amplified channels: 10^decades)
  channelRange(ch) {
    let r = 0, logAmp = false;
    for (const s of this.samples) {
      const p = s.params[s.channelIndex(ch)];
      if (!p) continue;
      if (p.ampE[0] > 0 && s.text['$DATATYPE'] === 'I') { logAmp = true; r = Math.max(r, Math.pow(10, p.ampE[0]) * (p.ampE[1] || 1)); }
      else r = Math.max(r, p.range || 0);
    }
    return { range: r || 262144, logAmp };
  }
  getCfg(ch) {
    if (!this.transforms[ch]) {
      const { range, logAmp } = this.channelRange(ch);
      this.transforms[ch] = logAmp ? { kind: 'log', min: 1, max: range, auto: true } : defaultTransformFor(ch, range);
      // Time units differ a lot between instruments: scale to the acquisition actually recorded
      if (/time/i.test(ch) && !logAmp) {
        let max = 0;
        for (const s of this.samples) { const c = s.hasChannel(ch) ? s.raw[s.channelIndex(ch)] : null; if (c) for (let i = 0; i < c.length; i++) if (c[i] > max) max = c[i]; }
        if (max > 0) this.transforms[ch] = { kind: 'linear', min: 0, max: +(max * 1.02).toPrecision(3), auto: true };
      }
    }
    return this.transforms[ch];
  }
  // Re-derive automatic (never user-edited) scales after the sample set changes
  refreshAutoTransforms() { for (const [ch, cfg] of Object.entries(this.transforms)) if (cfg.auto) delete this.transforms[ch]; }

  // ---- undo / redo (one history per mode) ----
  snapshot(mode) {
    switch (mode) {
      case 'gating': return JSON.stringify({
        gates: this.engine.toJSON(), transforms: this.transforms, plots: this.plots, displayMax: this.displayMax,
      });
      case 'comp': return JSON.stringify(this.samples.map(s => [s.id, s.compEnabled, s.spill]));
      case 'layout': return JSON.stringify(this.figures);
      case 'stats': return JSON.stringify(this.statsCfg);
      case 'properties': return JSON.stringify(this.samples.map(s => [s.id, s.edits]));
    }
  }
  restore(mode, snap) {
    const v = JSON.parse(snap);
    if (mode === 'gating') {
      this.engine.load(v.gates); this.transforms = v.transforms; this.plots = v.plots; this.displayMax = v.displayMax;
      for (const s of this.samples) s.invalidate();
      this.engine.invalidate();
      if (this.selectedGate && !this.engine.get(this.selectedGate)) this.selectedGate = null;
      this.selPlots = new Set([...this.selPlots].filter(id => this.plots.some(p => p.id === id)));
    } else if (mode === 'comp') {
      for (const [id, enabled, spill] of v) {
        const s = this.sampleById(id); if (!s) continue;
        if (JSON.stringify(s.spill) !== JSON.stringify(spill)) s.setSpill(spill);
        if (s.compEnabled !== enabled) s.setCompEnabled(enabled);
      }
      this.engine.invalidate();
    } else if (mode === 'layout') this.figures = v;
    else if (mode === 'stats') this.statsCfg = v;
    else if (mode === 'properties') for (const [id, edits] of v) this.sampleById(id)?.applyEdits(edits);
  }
  // Record any changes since the last commit. Returns true if something changed.
  commit() {
    let changed = false;
    for (const m of MODES) {
      const cur = this.snapshot(m);
      if (cur === this.last[m]) continue;
      this.undo[m].push(this.last[m]);
      if (this.undo[m].length > UNDO_LIMIT) this.undo[m].shift();
      this.redo[m] = [];
      this.last[m] = cur;
      changed = true;
    }
    if (changed) this.dirty = true;
    return changed;
  }
  // Accept the current state as the baseline without creating undo steps (e.g. after loading data)
  rebase() { for (const m of MODES) this.last[m] = this.snapshot(m); }
  canUndo(m) { return this.undo[m].length > 0; }
  canRedo(m) { return this.redo[m].length > 0; }
  undoStep(m) {
    this.commit(); // never lose uncommitted edits
    if (!this.undo[m].length) return false;
    this.redo[m].push(this.last[m]);
    this.last[m] = this.undo[m].pop();
    this.restore(m, this.last[m]);
    this.dirty = true;
    return true;
  }
  redoStep(m) {
    if (!this.redo[m].length) return false;
    this.undo[m].push(this.last[m]);
    this.last[m] = this.redo[m].pop();
    this.restore(m, this.last[m]);
    this.dirty = true;
    return true;
  }

  // ---- workspace files (analysis + references to the FCS files, no event data) ----
  serialize() {
    const keyOf = id => this.sampleById(id)?.key;
    return {
      app: 'ThistleFlow', appVersion: APP_VERSION, kind: 'workspace', version: 2, name: this.name, saved: new Date().toISOString(),
      transforms: this.transforms, gates: this.engine.toJSON(), plots: this.plots, displayMax: this.displayMax,
      figures: this.figures.map(f => ({ ...f, series: f.series?.map(se => ({ ...se, sampleKey: keyOf(se.sampleId), sampleId: undefined })) })),
      statsCfg: this.statsCfg,
      samples: this.samples.map(s => ({ key: s.key, file: s.source?.name || s.fileName, compEnabled: s.compEnabled, spill: s.spill, edits: s.edits })),
    };
  }

  // Unique original files of the samples, for bundling: [{ name, data }]
  sourceFiles() {
    const seen = new Map();
    for (const s of this.samples) if (s.source && !seen.has(s.source)) seen.set(s.source, s.source);
    return [...seen.values()];
  }
  // Keys of the samples a saved workspace refers to
  static savedKeys(data) { return data.version >= 2 ? (data.samples || []).map(e => e.key) : (data.samples || []); }
  // Returns the list of sample keys referenced by the file but not loaded in this workspace
  deserialize(ws) {
    if (ws.app !== 'ThistleFlow' && ws.app !== 'FlowLite') throw new Error('not a Thistle Flow workspace');
    if (ws.kind === 'template') throw new Error('this is a template; use “Apply template”');
    const byKey = k => this.samples.find(s => s.key === k || s.name === k);
    if (ws.name) this.name = ws.name;
    this.transforms = ws.transforms || {};
    this.engine.load(ws.gates || []);
    this.plots = ws.plots || [];
    this.statsCfg = { layout: 'long', ...(ws.statsCfg || this.statsCfg) };
    if (ws.displayMax !== undefined) this.displayMax = ws.displayMax;
    this.figures = (ws.figures || []).map(f => ({ ...f, series: f.series?.map(se => ({ ...se, sampleId: byKey(se.sampleKey ?? se.sampleName)?.id })).filter(se => se.sampleId) }));
    let missing = [];
    if (ws.version >= 2) {
      for (const e of ws.samples || []) {
        const s = byKey(e.key); if (!s) { missing.push(e.key); continue; }
        if (e.spill) s.setSpill(e.spill);
        s.setCompEnabled(!!e.compEnabled && !!s.spill);
        s.applyEdits(e.edits);
      }
    } else { // version 1 (FlowLite)
      for (const [name, c] of Object.entries(ws.compensation || {})) {
        const s = byKey(name); if (!s) continue;
        if (c.spill) s.setSpill(c.spill);
        s.setCompEnabled(!!c.enabled && !!s.spill);
      }
      missing = (ws.samples || []).filter(n => !byKey(n));
    }
    // restore the saved order of the samples (samples not in the file keep their place at the end)
    const order = Workspace.savedKeys(ws);
    const rank = s => { const i = order.findIndex(k => k === s.key || k === s.name); return i < 0 ? order.length : i; };
    this.samples = this.samples.map((s, i) => [s, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([s]) => s);
    this.selectedGate = null; this.selPlots.clear();
    this.engine.invalidate();
    return missing;
  }

  // ---- templates: the analysis without any data, applicable to other samples ----
  template({ includeComp = true } = {}) {
    const s = this.activeSample();
    const labels = {};
    for (const smp of this.samples) for (const [ch, l] of Object.entries(smp.edits.labels)) labels[ch] = l;
    return {
      app: 'ThistleFlow', appVersion: APP_VERSION, kind: 'template', version: 1, name: this.name, saved: new Date().toISOString(),
      transforms: Object.fromEntries(Object.entries(this.transforms).filter(([, c]) => !c.auto)),
      // per-sample gate adjustments belong to specific files, so templates keep only the global gates
      gates: this.engine.toJSON().map(({ overrides, ...g }) => g), plots: this.plots, displayMax: this.displayMax, statsCfg: this.statsCfg,
      // overlay series are stored by position; a series set that covered every sample re-expands to all samples
      figures: this.figures.map(f => {
        if (!f.series) return f;
        const idx = f.series.map(se => this.samples.findIndex(x => x.id === se.sampleId));
        const all = this.samples.length > 1 && new Set(idx).size === this.samples.length && f.series.length === this.samples.length;
        return { ...f, allSamples: all, series: f.series.map((se, i) => ({ pop: se.pop, color: se.color, label: se.label, sampleIndex: idx[i] })) };
      }),
      compensation: includeComp && s?.spill ? { names: s.spill.names, matrix: s.spill.matrix } : null,
      labels,
    };
  }
  applyTemplate(t, colors) {
    if (t.app !== 'ThistleFlow' || t.kind !== 'template') throw new Error('not a Thistle Flow template');
    this.engine.load(JSON.parse(JSON.stringify(t.gates || [])));
    for (const [ch, cfg] of Object.entries(t.transforms || {})) this.transforms[ch] = cfg;
    this.plots = (t.plots || []).map(p => ({ ...p }));
    if (t.displayMax !== undefined) this.displayMax = t.displayMax;
    if (t.statsCfg) this.statsCfg = { ...t.statsCfg };
    this.figures = (t.figures || []).map(f => {
      if (!f.series) return { ...f };
      let series;
      if (f.allSamples) {
        const pop = f.series[0]?.pop ?? null;
        series = this.samples.map((s, i) => ({ sampleId: s.id, pop, color: colors[i % colors.length] }));
      } else {
        series = f.series.map(se => ({ ...se, sampleId: this.samples[se.sampleIndex]?.id })).filter(se => se.sampleId);
        series.forEach(se => delete se.sampleIndex);
      }
      const { allSamples, ...rest } = f;
      return { ...rest, series };
    });
    let compApplied = 0;
    if (t.compensation) for (const s of this.samples) {
      if (!t.compensation.names.every(c => s.hasChannel(c) || s.resolveChannel(c) !== c)) continue;
      s.setSpill({ names: [...t.compensation.names], matrix: t.compensation.matrix.map(r => [...r]) });
      s.setCompEnabled(s.spillMissing().length === 0);
      compApplied++;
    }
    for (const [ch, l] of Object.entries(t.labels || {})) for (const s of this.samples) if (s.hasChannel(ch)) s.setLabel(ch, l);
    this.selectedGate = null; this.selPlots.clear();
    this.engine.invalidate();
    return { compApplied };
  }
}
