/**
 * Point-marker plugin ("catch point"). Ctrl + left-click on the chart drops a
 * transparent vertical marker at that instant and (optionally) recenters the
 * viewport on it, preserving the current bar spacing. Ctrl-clicking the existing
 * marker clears it; Escape clears it too.
 *
 * The marker is purely in-memory — it is not part of the serialized drawing
 * model and never persists. The caught timestamp is reported (epoch ms) via the
 * `onCatch` callback, `subscribe`, and the chart bus event `"pointMarker"`, so a
 * host can mirror it across linked charts (e.g. through a SyncEngine group).
 *
 * Framework-agnostic: usable from vanilla JS or any framework. Public API is
 * epoch milliseconds; conversion to lightweight-charts' epoch-seconds happens at
 * this boundary.
 */

import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import type { ChartPlugin, PluginContext } from "../plugins/types";
import { ownerWindowOf } from "../dom/ownerWindow";
import { PointMarkerPrimitive, type PointMarkerColors } from "./PointMarkerPrimitive";

export interface PointMarkerOptions {
  /** Modifier key that arms the catch gesture. Default `"ctrl"`. */
  modifier?: "shift" | "alt" | "ctrl" | "meta";
  /** Recenter the viewport on the caught point (keeps bar spacing). Default `true`. */
  centerOnCatch?: boolean;
  /** Marker color overrides. */
  colors?: Partial<PointMarkerColors>;
  /**
   * Called whenever the marker moves (epoch ms) or is cleared (`null`).
   *
   * `frac` is where the caught point sat horizontally on THIS chart's plot
   * (0 = left edge, 1 = right edge). Forward it to linked charts so they show
   * the same instant at the same screen position instead of centring it.
   */
  onCatch?: (ts: number | null, frac?: number) => void;
}

type AnySeries = ISeriesApi<"Candlestick" | "Bar" | "Line" | "Area">;

const MS = 1000;

export class PointMarkerController implements ChartPlugin {
  readonly id = "point-marker";

  private chart: IChartApi | null = null;
  private series: AnySeries | null = null;
  private container: HTMLElement | null = null;
  private marker: PointMarkerPrimitive;
  private ctx: PluginContext | null = null;
  private cleanup: Array<() => void> = [];
  private listeners = new Set<(ts: number | null) => void>();
  private last: number | null = null;
  private lastFrac: number | null = null;

  constructor(private readonly opts: PointMarkerOptions = {}) {
    this.marker = new PointMarkerPrimitive(opts.colors);
  }

  init(ctx: PluginContext): void {
    this.ctx = ctx;
    this.chart = ctx.chart;
    this.series = ctx.series;
    this.container = ctx.chart.chartElement();
    this.series.attachPrimitive(this.marker);

    const el = this.container;
    // Capture phase so the gesture lands before the chart's own pan/click logic.
    const onClick = (e: MouseEvent) => this.onClick(e);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.clear();
    };
    // The chart element's OWN window: a chart rendered into a second browser
    // window receives key events THERE only, so binding the module-scope
    // `window` would go deaf for it.
    const win = ownerWindowOf(el);
    el.addEventListener("click", onClick, { capture: true });
    win.addEventListener("keydown", onKey);
    this.cleanup.push(() => el.removeEventListener("click", onClick, { capture: true } as EventListenerOptions));
    this.cleanup.push(() => win.removeEventListener("keydown", onKey));
  }

  destroy(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    try {
      this.series?.detachPrimitive(this.marker);
    } catch {
      /* already detached */
    }
    this.chart = null;
    this.series = null;
    this.container = null;
  }

  private modifierHeld(e: MouseEvent): boolean {
    switch (this.opts.modifier ?? "ctrl") {
      case "alt":
        return e.altKey;
      case "shift":
        return e.shiftKey;
      case "meta":
        return e.metaKey;
      default:
        return e.ctrlKey;
    }
  }

  /**
   * Subscribe to marker changes (epoch ms, `null` when cleared). Fires
   * immediately with the current value. Returns an unsubscribe fn.
   */
  subscribe(cb: (ts: number | null) => void): () => void {
    this.listeners.add(cb);
    cb(this.last);
    return () => this.listeners.delete(cb);
  }

  /** Current marker timestamp (epoch ms) or `null`. */
  getPoint(): number | null {
    return this.last;
  }

  /**
   * Fractional plot-x (0..1) the current marker was caught at on this chart, or
   * `null` when it was placed programmatically without one.
   */
  getFraction(): number | null {
    return this.lastFrac;
  }

  /**
   * Place (or move) the marker at `ts` (epoch ms). Pass `null` to clear. This is
   * the programmatic entry a host uses to mirror a sibling chart's caught point;
   * it does NOT re-emit `onCatch`/bus (no broadcast loop) but does notify local
   * `subscribe` listeners so UI stays in sync.
   */
  setPoint(ts: number | null, options: { center?: boolean; frac?: number } = {}): void {
    if (ts == null) {
      this.marker.clear();
      this.last = null;
      this.lastFrac = null;
      for (const cb of this.listeners) cb(null);
      return;
    }
    this.marker.set(ts / MS);
    if (options.center ?? this.opts.centerOnCatch ?? true) {
      this.placeAtFraction(ts / MS, options.frac ?? 0.5);
    }
    this.last = ts;
    this.lastFrac = options.frac ?? null;
    for (const cb of this.listeners) cb(ts);
  }

  /** Clear the marker locally and emit the cleared state. */
  clear(): void {
    if (this.last == null) return;
    this.marker.clear();
    this.emit(null);
  }

  private emit(ts: number | null, frac?: number): void {
    this.last = ts;
    this.lastFrac = frac ?? null;
    this.opts.onCatch?.(ts, frac);
    for (const cb of this.listeners) cb(ts);
    this.ctx?.bus.emit("pointMarker" as never, ts as never);
  }

  /**
   * Shift the viewport so `tsSec` lands at `frac` of the plot width (0 = left
   * edge, 1 = right edge), keeping the logical width — i.e. the zoom — exactly.
   * `0.5` is "centre on it".
   */
  private placeAtFraction(tsSec: number, frac: number): void {
    const chart = this.chart;
    if (!chart) return;
    const scale = chart.timeScale();
    const lr = scale.getVisibleLogicalRange();
    const x = scale.timeToCoordinate(tsSec as Time);
    if (lr && x != null) {
      const tl = scale.coordinateToLogical(x);
      if (tl != null) {
        const width = lr.to - lr.from;
        const from = tl - frac * width;
        scale.setVisibleLogicalRange({ from, to: from + width });
        return;
      }
    }
    const vr = scale.getVisibleRange();
    if (vr) {
      const span = Number(vr.to) - Number(vr.from);
      try {
        scale.setVisibleRange({
          from: (tsSec - frac * span) as Time,
          to: (tsSec + (1 - frac) * span) as Time,
        });
      } catch {
        /* out of bounds */
      }
    }
  }

  private onClick(e: MouseEvent): void {
    if (!this.chart || e.button !== 0 || !this.modifierHeld(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const scale = this.chart.timeScale();
    const rect = this.container!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = scale.coordinateToTime(x);
    if (t == null) return;
    const tsSec = Number(t);

    // Catching on/near the existing marker clears it.
    const cur = this.marker.getTimeSec();
    if (cur != null) {
      const curX = scale.timeToCoordinate(cur as Time);
      if (curX != null && Math.abs(curX - x) <= 6) {
        this.marker.clear();
        this.emit(null);
        return;
      }
    }

    // Where the click landed across the plot, so linked charts can mirror the
    // screen position and not just the instant.
    const plotW = scale.width();
    const catchX = scale.timeToCoordinate(t);
    const frac = catchX != null && plotW > 0 ? Math.min(1, Math.max(0, catchX / plotW)) : 0.5;

    this.marker.set(tsSec);
    if (this.opts.centerOnCatch ?? true) this.placeAtFraction(tsSec, frac);
    this.emit(tsSec * MS, frac);
  }
}
