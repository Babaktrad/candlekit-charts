/**
 * Measurement plugin. Hold the modifier and press on the chart to arm a ruler;
 * the ruler primitive paints the overlay and a {@link MeasurementResult} is
 * emitted (price, percentage, bar-distance, time delta, direction).
 * Risk/reward is derivable from the result via {@link computeRiskReward}.
 *
 * Two gestures, deliberately:
 *   - **drag** — press, move, release: the ruler finishes on release;
 *   - **click** — press and release within {@link CLICK_SLOP} px: the ruler
 *     stays ARMED and keeps tracking the pointer with the button up, and
 *     releasing the modifier does NOT cancel it. The next click freezes it; a
 *     further click dismisses it.
 *
 * While a ruler is armed the controller reports it (via `onArmedChange` and the
 * chart bus event `"measureArmed"`) so a host can lock its drawing surface — a
 * click has to finalise the ruler, not grab a drawing underneath it.
 *
 * Framework-agnostic: replaces the original React MeasurementManager with a
 * controller usable from vanilla JS or any framework. Pass an `onMeasure`
 * callback or subscribe to the chart bus event `"measure"`.
 */

import type { IChartApi, ISeriesApi, MouseEventParams, Time } from "lightweight-charts";
import type { ChartPlugin, PluginContext } from "../plugins/types";
import { ownerWindowOf } from "../dom/ownerWindow";
import { RulerPrimitive, type RulerColors } from "./RulerPrimitive";
import { resolvePoint, computeMeasurement } from "./ChartCoordinateUtils";
import type { MeasurementPoint, MeasurementResult, RulerState } from "./types";

/**
 * Pointer travel (px) below which a press+release counts as a CLICK rather than
 * a drag. This slop is the whole click-vs-drag discrimination.
 */
const CLICK_SLOP = 4;

export interface MeasurementOptions {
  /** Modifier key that arms measurement. Default `"shift"`. */
  modifier?: "shift" | "alt" | "ctrl" | "meta";
  /** Ruler color overrides. */
  colors?: Partial<RulerColors>;
  /** Called on every measurement update + completion. */
  onMeasure?: (result: MeasurementResult | null) => void;
  /**
   * Called when the ruler arms / disarms. Wire it to a drawing surface's lock
   * so a click finalises the ruler instead of selecting a drawing under it.
   * `<ChartView>` does this automatically when both plugins are enabled.
   */
  onArmedChange?: (armed: boolean) => void;
  /**
   * `false` restores the plain drag-only ruler (release always ends the
   * measurement, no armed state). Default `true`.
   */
  sticky?: boolean;
}

type AnySeries = ISeriesApi<"Candlestick" | "Bar" | "Line" | "Area">;

export class MeasurementController implements ChartPlugin {
  readonly id = "measurement";

  private chart: IChartApi | null = null;
  private series: AnySeries | null = null;
  private container: HTMLElement | null = null;
  private ruler = new RulerPrimitive();
  private state: RulerState = "idle";
  private start: MeasurementPoint | null = null;
  private ctx: PluginContext | null = null;
  private cleanup: Array<() => void> = [];
  private listeners = new Set<(r: MeasurementResult | null) => void>();
  private last: MeasurementResult | null = null;
  /** Pointer position at mousedown, for the click-vs-drag test. */
  private downPos: { x: number; y: number } | null = null;
  private armed = false;

  constructor(private readonly opts: MeasurementOptions = {}) {
    this.ruler = new RulerPrimitive(opts.colors);
  }

  init(ctx: PluginContext): void {
    this.ctx = ctx;
    this.chart = ctx.chart;
    this.series = ctx.series;
    this.container = ctx.chart.chartElement();
    this.series.attachPrimitive(this.ruler);

    const onCrosshair = (p: MouseEventParams<Time>) => this.onCrosshairMove(p);
    this.chart.subscribeCrosshairMove(onCrosshair);
    this.cleanup.push(() => this.chart?.unsubscribeCrosshairMove(onCrosshair));

    const el = this.container;
    const onDown = (e: MouseEvent) => this.onMouseDown(e);
    const onUp = (e: MouseEvent) => this.onMouseUp(e);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.clear();
    };
    // The chart element's OWN window — a chart rendered into a second browser
    // window receives mouseup/keydown THERE only, and a missed mouseup would
    // leave the ruler latched mid-drag forever.
    const win = ownerWindowOf(el);
    el.addEventListener("mousedown", onDown);
    win.addEventListener("mouseup", onUp);
    win.addEventListener("keydown", onKey);
    this.cleanup.push(() => el.removeEventListener("mousedown", onDown));
    this.cleanup.push(() => win.removeEventListener("mouseup", onUp));
    this.cleanup.push(() => win.removeEventListener("keydown", onKey));
  }

  destroy(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.setArmed(false);
    try {
      this.series?.detachPrimitive(this.ruler);
    } catch {
      /* already detached */
    }
    this.chart = null;
    this.series = null;
    this.container = null;
  }

  private modifierHeld(e: MouseEvent): boolean {
    switch (this.opts.modifier ?? "shift") {
      case "alt":
        return e.altKey;
      case "ctrl":
        return e.ctrlKey;
      case "meta":
        return e.metaKey;
      default:
        return e.shiftKey;
    }
  }

  /**
   * Subscribe to measurement updates (null = cleared). Fires immediately with
   * the current value. Returns an unsubscribe fn. Lets UI (e.g. a React overlay)
   * render the live %/pts/bars readout without the consumer wiring `onMeasure`.
   */
  subscribe(cb: (r: MeasurementResult | null) => void): () => void {
    this.listeners.add(cb);
    cb(this.last);
    return () => this.listeners.delete(cb);
  }

  /** Latest measurement result, or null when idle. */
  getResult(): MeasurementResult | null {
    return this.last;
  }

  private emit(result: MeasurementResult | null): void {
    this.last = result;
    this.opts.onMeasure?.(result);
    for (const cb of this.listeners) cb(result);
    // Custom event on the shared bus for plugins/UI that want it.
    this.ctx?.bus.emit("measure" as never, result as never);
  }

  private onMouseDown(e: MouseEvent): void {
    if (!this.chart || !this.series) return;
    // An armed ruler is finalised by ANY click, modifier or not.
    if (this.state === "measuring" && this.sticky()) {
      e.preventDefault();
      e.stopPropagation();
      this.finish();
      return;
    }
    if (!this.modifierHeld(e)) {
      if (this.state === "complete") this.clear();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const start = resolvePoint(this.chart, this.series, e.offsetX, e.offsetY);
    if (!start) return;
    this.chart.applyOptions({ handleScroll: { pressedMouseMove: false } });
    this.downPos = { x: e.clientX, y: e.clientY };
    this.start = start;
    this.state = "measuring";
    this.setArmed(true);
    this.ruler.clear();
    this.emit(null);
  }

  private onMouseUp(e?: MouseEvent): void {
    if (this.state !== "measuring") return;
    if (!this.sticky()) {
      this.finish();
      return;
    }
    const down = this.downPos;
    const dragged =
      !down ||
      !e ||
      Math.abs(e.clientX - down.x) > CLICK_SLOP ||
      Math.abs(e.clientY - down.y) > CLICK_SLOP;
    // A drag finalises on release. A click leaves the ruler armed so the
    // pointer keeps measuring with the button up until the next click.
    if (dragged) this.finish();
  }

  private sticky(): boolean {
    return this.opts.sticky ?? true;
  }

  /** Freeze the current ruler; it stays on screen until the next plain click. */
  private finish(): void {
    this.state = "complete";
    this.downPos = null;
    this.chart?.applyOptions({ handleScroll: { pressedMouseMove: true } });
    this.setArmed(false);
  }

  private setArmed(armed: boolean): void {
    if (this.armed === armed) return;
    this.armed = armed;
    this.opts.onArmedChange?.(armed);
    this.ctx?.bus.emit("measureArmed" as never, armed as never);
  }

  /** True while a ruler is armed and tracking the pointer. */
  isArmed(): boolean {
    return this.armed;
  }

  private onCrosshairMove(param: MouseEventParams<Time>): void {
    if (this.state !== "measuring" || !param.point || !this.chart || !this.series || !this.start) return;
    const end = resolvePoint(this.chart, this.series, param.point.x, param.point.y);
    if (!end) return;
    this.ruler.update(this.start, end);
    this.emit(computeMeasurement(this.start, end));
  }

  clear(): void {
    this.state = "idle";
    this.start = null;
    this.downPos = null;
    this.ruler.clear();
    this.chart?.applyOptions({ handleScroll: { pressedMouseMove: true } });
    this.setArmed(false);
    this.emit(null);
  }
}
