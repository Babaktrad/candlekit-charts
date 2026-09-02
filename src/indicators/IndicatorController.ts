/**
 * Indicator plugin. Manages the lifecycle of indicator series (overlay lines,
 * oscillator panes, histogram plots, horizontal price lines, and pattern
 * markers) on a chart, driven by an {@link IndicatorRegistry} and a set of
 * active indicators.
 *
 * Ported from the original React IndicatorManager into a framework-agnostic
 * controller: it reads bars from the plugin context (already at the active
 * interval) instead of resampling internally.
 */

import {
  LineSeries,
  HistogramSeries,
  LineStyle,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
} from "lightweight-charts";
import type { ChartPlugin, PluginContext } from "../plugins/types";
import type { Bar } from "../core/types";
import { localStorageKV, type KVStore } from "../dom/kv";
import { indicatorPaneKeys } from "./paneKeyRegistry";
import type { IndicatorRegistry } from "./registry";
import type { ActiveIndicator, IndicatorBar, IndicatorResult, PlotPoint } from "./types";

const HISTOGRAM_STYLES = new Set(["histogram", "columns"]);

interface Managed {
  plotSeries: Map<string, ISeriesApi<"Line" | "Histogram">>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pane: any | null;
  isPattern: boolean;
}

/** Identifies one plotted line: `${indicatorName}:${plotId}`. */
export type IndicatorPlotKey = string;

/** One row of a legend readout: an indicator and the lines it plots. */
export interface IndicatorLegendEntry {
  name: string;
  /** Short label, e.g. `"SMA"`. */
  shortTitle: string;
  /** Numeric inputs joined for display, e.g. `"12,26,9"`. Empty when none. */
  params: string;
  plots: Array<{ key: IndicatorPlotKey; plotId: string; title: string; color: string }>;
}

export interface IndicatorControllerOptions {
  /** Called with the active indicator names after every mutation. */
  onChange?: (names: string[]) => void;
  /**
   * Persist the active set (name + params + colors) under this KV key, and
   * restore it on `init`. `null`/omit disables — same contract as
   * `DrawingControllerOptions.storageKey`.
   */
  storageKey?: string | null;
  /** KV backend. Default localStorage. */
  kv?: KVStore;
}

/**
 * Synthesize indicator bars from a plain value line (`o = h = l = c = value`,
 * volume 0), so close-sourced indicators (SMA/EMA/RSI/Bollinger/MACD…) work
 * unchanged on a line or area series. Candle-pattern detectors simply find
 * nothing on flat bars and stay silent.
 *
 * `time` is epoch **seconds** — the unit `IndicatorDef.calculate` consumes.
 */
export function lineToIndicatorBars(
  points: readonly { time: number; value?: number | null }[],
): IndicatorBar[] {
  const out: IndicatorBar[] = [];
  for (const p of points) {
    const v = p.value;
    if (v == null || !Number.isFinite(v)) continue;
    out.push({ time: p.time, open: v, high: v, low: v, close: v, volume: 0 });
  }
  return out;
}

export class IndicatorController implements ChartPlugin {
  readonly id = "indicators";

  private chart: IChartApi | null = null;
  private candleSeries: ISeriesApi<"Candlestick" | "Bar" | "Line" | "Area"> | null = null;
  private getBars: () => readonly Bar[] = () => [];
  private active = new Map<string, ActiveIndicator>();
  private managed = new Map<string, Managed>();
  private markers = new Map<string, SeriesMarker<Time>[]>();
  private markersPlugin: ISeriesMarkersPluginApi<Time> | null = null;
  private onChange?: (names: string[]) => void;
  private changeListeners = new Set<(names: string[]) => void>();
  private readonly storageKey: string | null;
  private readonly kv: KVStore;
  /**
   * Full per-plot value series (time-ascending), keyed {@link IndicatorPlotKey}.
   * Kept because lightweight-charts only exposes plot values inside a NATIVE
   * crosshair-move event; a programmatic `setCrosshairPosition` (what a synced
   * chart receives) fires nothing, so a legend driven off the event alone stays
   * frozen on every receiving chart. {@link valuesAt} reads these instead.
   */
  private plotData = new Map<IndicatorPlotKey, PlotPoint[]>();

  constructor(
    private readonly registry: IndicatorRegistry,
    opts: IndicatorControllerOptions = {},
  ) {
    this.onChange = opts.onChange;
    this.storageKey = opts.storageKey ?? null;
    this.kv = opts.kv ?? localStorageKV;
  }

  init(ctx: PluginContext): void {
    this.chart = ctx.chart;
    this.candleSeries = ctx.series;
    this.getBars = ctx.getBars;
    if (this.storageKey && this.active.size === 0) this.restore();
  }

  onData(): void {
    this.refresh();
  }

  /**
   * Live/replay tick: refresh only the newest point of each active indicator.
   * Recompute is O(bars) but we `update()` just the last LWC point instead of
   * re-`setData`-ing the whole series, so streaming stays cheap. Newly-toggled
   * indicators are materialized by `add()` → `refresh()`, not here.
   */
  onBar(): void {
    const chart = this.chart;
    const candle = this.candleSeries;
    if (!chart || !candle || this.managed.size === 0) return;
    const bars = this.bars();
    if (bars.length === 0) return;

    for (const [name, m] of this.managed) {
      const def = this.registry.get(name);
      const act = this.active.get(name);
      if (!def || !act) continue;
      let res: IndicatorResult;
      try {
        res = def.calculate(bars, act.params);
      } catch {
        continue;
      }
      if (m.isPattern) {
        this.markers.set(name, buildMarkers(res));
        this.flushMarkers();
        continue;
      }
      for (const [plotId, raw] of Object.entries(res.plots)) {
        const s = m.plotSeries.get(plotId);
        if (!s) continue;
        const filtered = filterValid(raw);
        const last = filtered[filtered.length - 1];
        if (!last) continue;
        const pc = def.plotConfig.find((c) => c.id === plotId);
        const color = resolveColor(act.colors, plotId, pc?.color);
        if (HISTOGRAM_STYLES.has(pc?.style ?? "")) {
          (s as ISeriesApi<"Histogram">).update({ time: last.time as Time, value: last.value, color: last.color ?? color });
        } else {
          (s as ISeriesApi<"Line">).update({ time: last.time as Time, value: last.value });
        }
        // Keep the value series in step with the rendered one, or a legend fed
        // by `valuesAt` would stop at the last full refresh.
        this.plotData.set(plotKey(name, plotId), filtered);
      }
    }
  }

  destroy(): void {
    if (this.chart) {
      for (const m of this.managed.values()) {
        for (const s of m.plotSeries.values()) {
          try {
            this.chart.removeSeries(s);
          } catch {
            /* */
          }
        }
      }
    }
    this.managed.clear();
    this.markers.clear();
    this.plotData.clear();
    this.markersPlugin = null;
    this.chart = null;
    this.candleSeries = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** List indicators available in the registry, grouped by category. */
  available() {
    return this.registry.byCategory();
  }

  /** Currently active indicator names. */
  activeNames(): string[] {
    return [...this.active.keys()];
  }

  /**
   * Subscribe to changes in the active set. Fires immediately with the current
   * names. Returns an unsubscribe fn. (The constructor's `onChange` is the
   * one-listener form; this is the one UI uses.)
   */
  subscribe(cb: (names: string[]) => void): () => void {
    this.changeListeners.add(cb);
    cb(this.activeNames());
    return () => this.changeListeners.delete(cb);
  }

  /** The active indicator (name + resolved params), or undefined if off. */
  getActive(name: string): ActiveIndicator | undefined {
    return this.active.get(name);
  }

  /**
   * Rows for a legend readout: one per active non-pattern indicator, each with
   * its short title, its numeric inputs, and the resolved colour of every line
   * it plots. Pair with {@link valuesAt} to fill in the numbers.
   */
  legendEntries(): IndicatorLegendEntry[] {
    const out: IndicatorLegendEntry[] = [];
    for (const [name, act] of this.active) {
      const def = this.registry.get(name);
      if (!def || def.category === "pattern") continue;
      out.push({
        name,
        shortTitle: def.shortTitle,
        params: paramLabel(act.params),
        plots: def.plotConfig.map((pc) => ({
          key: plotKey(name, pc.id),
          plotId: pc.id,
          title: pc.title || pc.id,
          color: resolveColor(act.colors, pc.id, pc.color),
        })),
      });
    }
    return out;
  }

  /**
   * Value of every plotted line at `tsMs` (epoch ms), or — with `null` — the
   * latest computed value of each. Keys match
   * {@link IndicatorLegendEntry.plots}`[].key`.
   *
   * Resolved from the controller's own stored plot series rather than from a
   * crosshair event, so it works for a programmatically-positioned crosshair (a
   * chart mirroring a linked one) exactly as it does for a local hover —
   * lightweight-charts reports series values only for NATIVE crosshair moves.
   */
  valuesAt(tsMs: number | null): Map<IndicatorPlotKey, number | null> {
    const out = new Map<IndicatorPlotKey, number | null>();
    for (const [key, data] of this.plotData) {
      if (data.length === 0) {
        out.set(key, null);
        continue;
      }
      if (tsMs == null) {
        const v = data[data.length - 1].value;
        out.set(key, Number.isFinite(v) ? v : null);
        continue;
      }
      out.set(key, valueAtTimeSec(data, tsMs / 1000));
    }
    return out;
  }

  /** Turn every active indicator off. */
  clear(): void {
    if (this.active.size === 0) return;
    this.active.clear();
    this.refresh();
    this.changed();
  }

  /** Turn an indicator on (or update its params). Preserves color overrides. */
  add(name: string, params: Record<string, unknown> = {}): void {
    const def = this.registry.get(name);
    if (!def) return;
    const prev = this.active.get(name);
    this.active.set(name, {
      name,
      params: { ...def.defaultInputs, ...params },
      colors: prev?.colors ?? {},
    });
    this.refresh();
    this.changed();
  }

  /**
   * Override the per-plot colors of an active indicator. Colors do not affect
   * computed values, so this re-applies series options in place rather than
   * re-running `refresh()` — line series take `applyOptions({ color })`,
   * histogram series are re-`setData`'d (per-point colors win where present).
   * No-op if the indicator is not active.
   */
  setColors(name: string, colors: Record<string, string>): void {
    const act = this.active.get(name);
    if (!act) return;
    this.active.set(name, { ...act, colors });
    this.applyColors(name);
    this.changed();
  }

  /** Turn an indicator off. */
  remove(name: string): void {
    this.active.delete(name);
    this.refresh();
    this.changed();
  }

  toggle(name: string): void {
    if (this.active.has(name)) this.remove(name);
    else this.add(name);
  }

  // ── State snapshot ───────────────────────────────────────────────────────────

  /**
   * Snapshot the active indicators as plain, serializable data. The returned
   * array fully describes the indicator set — `{ name, params, colors }` per
   * entry — and is deep-copied so mutating it cannot reach back into live state.
   * Feed it through `JSON.stringify` for persistence; restore with
   * {@link loadState}. Output is purely a function of this snapshot (indicators
   * compute via a pure `calculate`), so a round-trip never changes what renders.
   */
  toState(): ActiveIndicator[] {
    return [...this.active.values()].map((a) => ({
      name: a.name,
      params: { ...a.params },
      colors: { ...a.colors },
    }));
  }

  /**
   * Replace the active set with a snapshot from {@link toState}. Unknown
   * indicator names (not in the registry) are skipped; params are re-resolved
   * against the def's defaults so a stale snapshot still yields valid inputs.
   * Triggers a single refresh.
   */
  loadState(state: readonly ActiveIndicator[]): void {
    this.active.clear();
    for (const a of state) {
      const def = this.registry.get(a.name);
      if (!def) continue;
      this.active.set(a.name, {
        name: a.name,
        params: { ...def.defaultInputs, ...a.params },
        colors: { ...(a.colors ?? {}) },
      });
    }
    this.refresh();
    this.changed();
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  /** Notify + persist. Every mutation funnels through here. */
  private changed(): void {
    if (this.storageKey) {
      try {
        this.kv.set(this.storageKey, JSON.stringify(this.toState()));
      } catch {
        /* quota / serialization */
      }
    }
    const names = this.activeNames();
    this.onChange?.(names);
    for (const cb of this.changeListeners) {
      try {
        cb(names);
      } catch {
        /* listener errors are isolated */
      }
    }
  }

  /**
   * Rehydrate the persisted set. Unknown names (registry drift) are dropped and
   * a corrupt payload yields an empty set — a saved indicator list must never
   * be able to stop a chart from mounting.
   */
  private restore(): void {
    if (!this.storageKey) return;
    let parsed: unknown;
    try {
      const raw = this.kv.get(this.storageKey);
      if (!raw) return;
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    this.loadState(parsed as ActiveIndicator[]);
  }

  // ── Lifecycle reconciliation ─────────────────────────────────────────────────

  private bars(): IndicatorBar[] {
    return this.getBars().map((b) => ({
      time: Math.floor(b.ts / 1000),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume ?? 0,
    }));
  }

  private refresh(): void {
    const chart = this.chart;
    const candle = this.candleSeries;
    if (!chart || !candle) return;

    if (!this.markersPlugin) this.markersPlugin = createSeriesMarkers(candle);
    const bars = this.bars();

    // 1. Remove deactivated.
    for (const [name, m] of this.managed) {
      if (this.active.has(name)) continue;
      for (const s of m.plotSeries.values()) {
        try {
          chart.removeSeries(s);
        } catch {
          /* */
        }
      }
      if (m.pane) {
        const idx = chart.panes().indexOf(m.pane);
        if (idx > 0) {
          try {
            chart.removePane(idx);
          } catch {
            /* */
          }
        }
      }
      if (m.isPattern) {
        this.markers.delete(name);
        this.flushMarkers();
      }
      for (const plotId of m.plotSeries.keys()) this.plotData.delete(plotKey(name, plotId));
      this.managed.delete(name);
    }

    // 2. Update still-active.
    for (const [name, m] of this.managed) {
      const def = this.registry.get(name);
      const act = this.active.get(name);
      if (!def || !act) continue;
      let res: IndicatorResult;
      try {
        res = def.calculate(bars, act.params);
      } catch {
        continue;
      }
      if (m.isPattern) {
        this.markers.set(name, buildMarkers(res));
        this.flushMarkers();
        continue;
      }
      for (const [plotId, raw] of Object.entries(res.plots)) {
        const s = m.plotSeries.get(plotId);
        if (!s) continue;
        const pc = def.plotConfig.find((c) => c.id === plotId);
        const color = resolveColor(act.colors, plotId, pc?.color);
        const isHist = HISTOGRAM_STYLES.has(pc?.style ?? "");
        const filtered = filterValid(raw);
        if (isHist) {
          (s as ISeriesApi<"Histogram">).setData(
            filtered.map((d) => ({ time: d.time as Time, value: d.value, color: d.color ?? color })),
          );
        } else {
          (s as ISeriesApi<"Line">).applyOptions({ color });
          (s as ISeriesApi<"Line">).setData(filtered.map((d) => ({ time: d.time as Time, value: d.value })));
        }
        this.plotData.set(plotKey(name, plotId), filtered);
      }
    }

    // 3. Add newly activated.
    for (const [name, act] of this.active) {
      if (this.managed.has(name)) continue;
      const def = this.registry.get(name);
      if (!def) continue;
      let res: IndicatorResult;
      try {
        res = def.calculate(bars, act.params);
      } catch {
        continue;
      }

      if (def.category === "pattern") {
        this.markers.set(name, buildMarkers(res));
        this.flushMarkers();
        this.managed.set(name, { plotSeries: new Map(), pane: null, isPattern: true });
        continue;
      }

      const isOverlay = def.category === "overlay";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let pane: any = null;
      let paneIndex = 0;
      if (!isOverlay) {
        pane = chart.addPane();
        pane.setHeight(140);
        paneIndex = chart.panes().length - 1;
      }

      const plotSeries = new Map<string, ISeriesApi<"Line" | "Histogram">>();
      for (const [plotId, raw] of Object.entries(res.plots)) {
        const pc = def.plotConfig.find((c) => c.id === plotId);
        const color = resolveColor(act.colors, plotId, pc?.color);
        const lineWidth = clampWidth(pc?.lineWidth ?? 1);
        const isHist = HISTOGRAM_STYLES.has(pc?.style ?? "");
        const filtered = filterValid(raw);
        if (isHist) {
          const s = chart.addSeries(HistogramSeries, { color, priceLineVisible: false, lastValueVisible: false }, paneIndex);
          s.setData(filtered.map((d) => ({ time: d.time as Time, value: d.value, color: d.color ?? color })));
          plotSeries.set(plotId, s);
        } else {
          const s = chart.addSeries(LineSeries, { color, lineWidth, priceLineVisible: false, lastValueVisible: false }, paneIndex);
          s.setData(filtered.map((d) => ({ time: d.time as Time, value: d.value })));
          plotSeries.set(plotId, s);
        }
        this.plotData.set(plotKey(name, plotId), filtered);
      }

      // Register oscillator plot series → pane key so a host can bind per-pane
      // behaviour (see paneKeyRegistry). Overlay plots stay on the price pane.
      if (!isOverlay) {
        for (const s of plotSeries.values()) indicatorPaneKeys.set(s, name);
      }

      const first = [...plotSeries.values()][0];
      if (first && def.hlineConfig.length > 0) {
        for (const hl of def.hlineConfig) {
          try {
            first.createPriceLine({
              price: hl.price,
              color: hl.color ?? "#888",
              lineWidth: clampWidth(hl.linewidth ?? 1),
              lineStyle:
                hl.linestyle === "dashed"
                  ? LineStyle.Dashed
                  : hl.linestyle === "dotted"
                    ? LineStyle.Dotted
                    : LineStyle.Solid,
              axisLabelVisible: false,
              title: hl.title ?? "",
            });
          } catch {
            /* */
          }
        }
      }
      this.managed.set(name, { plotSeries, pane, isPattern: false });
    }
  }

  private flushMarkers(): void {
    if (!this.markersPlugin) return;
    const all = [...this.markers.values()].flat();
    all.sort((a, b) => (a.time as number) - (b.time as number));
    this.markersPlugin.setMarkers(all);
  }

  /**
   * Re-style an active indicator's existing series from its current color
   * overrides, without recomputing values. Patterns have no plot series.
   */
  private applyColors(name: string): void {
    const m = this.managed.get(name);
    const def = this.registry.get(name);
    const act = this.active.get(name);
    if (!m || !def || !act || m.isPattern) return;
    let res: IndicatorResult;
    try {
      res = def.calculate(this.bars(), act.params);
    } catch {
      return;
    }
    for (const [plotId, s] of m.plotSeries) {
      const pc = def.plotConfig.find((c) => c.id === plotId);
      const color = resolveColor(act.colors, plotId, pc?.color);
      if (HISTOGRAM_STYLES.has(pc?.style ?? "")) {
        const raw = res.plots[plotId];
        if (!raw) continue;
        (s as ISeriesApi<"Histogram">).setData(
          filterValid(raw).map((d) => ({ time: d.time as Time, value: d.value, color: d.color ?? color })),
        );
      } else {
        (s as ISeriesApi<"Line">).applyOptions({ color });
      }
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function plotKey(name: string, plotId: string): IndicatorPlotKey {
  return `${name}:${plotId}`;
}

function filterValid(data: PlotPoint[]): PlotPoint[] {
  return data.filter((d) => d.value != null && !Number.isNaN(d.value));
}

/**
 * Numeric inputs joined for a legend label — `{ length: 20 }` → `"20"`,
 * `{ fast: 12, slow: 26, signal: 9 }` → `"12,26,9"`.
 */
function paramLabel(params: Record<string, unknown>): string {
  const nums = Object.values(params).filter((v): v is number => typeof v === "number");
  return nums.length ? nums.join(",") : "";
}

/**
 * Value of a time-ascending plot series at (or nearest to) `tSec`. Binary
 * search, then whichever bracketing point is closer — the crosshair time on a
 * receiving chart rarely lands exactly on one of the source's bars.
 */
function valueAtTimeSec(data: PlotPoint[], tSec: number): number | null {
  if (data.length === 0) return null;
  let lo = 0;
  let hi = data.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid].time <= tSec) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx + 1 < data.length && Math.abs(data[idx + 1].time - tSec) < Math.abs(data[idx].time - tSec)) {
    idx += 1;
  }
  const v = data[idx].value;
  return Number.isFinite(v) ? v : null;
}

/** Per-plot user override wins, then the plot's configured color, then grey. */
function resolveColor(colors: Record<string, string> | undefined, plotId: string, fallback?: string): string {
  return colors?.[plotId] ?? fallback ?? "#888";
}

function clampWidth(w: number): 1 | 2 | 3 | 4 {
  return Math.max(1, Math.min(4, Math.round(w))) as 1 | 2 | 3 | 4;
}

function mapShape(shape: string): "arrowUp" | "arrowDown" | "circle" | "square" {
  if (shape === "arrowUp" || shape === "arrowDown" || shape === "circle" || shape === "square") return shape;
  const l = shape.toLowerCase();
  if (l.includes("up") || l.includes("bull")) return "arrowUp";
  if (l.includes("down") || l.includes("bear")) return "arrowDown";
  return "circle";
}

function buildMarkers(res: IndicatorResult): SeriesMarker<Time>[] {
  const out = (res.markers ?? []).map((m) => ({
    time: m.time as Time,
    position: (m.position ?? "aboveBar") as "aboveBar" | "belowBar" | "inBar",
    shape: mapShape(m.shape ?? "circle"),
    color: m.color ?? "#2196F3",
    text: m.text ?? "",
  }));
  return out as unknown as SeriesMarker<Time>[];
}
