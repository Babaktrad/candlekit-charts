/**
 * Series primitive that paints a thin vertical guide at a single timestamp —
 * the *mirrored* crosshair used when several charts are linked through a
 * {@link SyncEngine} group.
 *
 * Why a primitive instead of lightweight-charts' `setCrosshairPosition()`:
 * the native call renders only when the receiving series has a non-null
 * `firstValue`, i.e. visible data on its default price scale at the current
 * range — it throws otherwise, and a sync receiver typically swallows that.
 * A panel that loads a narrower window than the broadcaster (fewer bars, a
 * different interval, a sparse derived series) therefore drops the mirrored
 * crosshair silently wherever it has no bars. A canvas primitive draws at the
 * mapped x unconditionally, so the synced instant is always visible regardless
 * of the receiver's data coverage.
 *
 * Cross-density x-mapping: `timeScale.timeToCoordinate` returns null for a time
 * that is not exactly one of *this* chart's bars (different interval, gaps), so
 * the x is interpolated between the two bracketing bars of the attached series
 * and extended past the data edges at the median bar interval x bar spacing. A
 * plain linear map across the visible span drifts as soon as the span crosses a
 * session gap.
 *
 * Same mechanics as {@link PointMarkerPrimitive}: purely in-memory, never part
 * of the serialized drawing model, and it captures no pointer events. Time is
 * the lightweight-charts pane domain (epoch seconds) — the public API converts
 * from epoch ms at the controller boundary.
 */

import type {
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

export interface CrosshairMarkerColors {
  /** Vertical guide line. Default matches the dark theme's crosshair. */
  line: string;
}

const DEFAULT_COLORS: CrosshairMarkerColors = { line: "#9ca3af" };

/** Bars looked at when estimating the median bar interval. */
const STEP_SAMPLE = 32;
/** Fallback bar interval (seconds) when the series has fewer than two bars. */
const FALLBACK_STEP_SEC = 60;

class CrosshairMarkerRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly x: number | null,
    private readonly colors: CrosshairMarkerColors,
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    const x = this.x;
    if (x == null) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr }) => {
      const bx = Math.round(x * hpr) + 0.5;
      ctx.save();
      // Dashed 1px in the crosshair colour so the mirrored guide reads as the
      // same crosshair, not as a drawing the user has to manage.
      ctx.strokeStyle = this.colors.line;
      ctx.lineWidth = 1 * hpr;
      ctx.setLineDash([4 * hpr, 4 * hpr]);
      ctx.beginPath();
      ctx.moveTo(bx, 0);
      ctx.lineTo(bx, bitmapSize.height);
      ctx.stroke();
      ctx.restore();
    });
  }
}

class CrosshairMarkerPaneView implements IPrimitivePaneView {
  constructor(private readonly primitive: CrosshairMarkerPrimitive) {}
  zOrder(): "top" {
    return "top";
  }
  renderer(): IPrimitivePaneRenderer | null {
    return new CrosshairMarkerRenderer(this.primitive.x, this.primitive.colors);
  }
}

/** Minimal slice of the time scale this primitive reads. */
interface TimeScaleLike {
  timeToCoordinate(t: Time): number | null;
  options(): { barSpacing?: number };
}

/**
 * Gap-aware pixel x for a time that is not one of `times`: interpolate between
 * the bracketing entries; beyond the data edges extend at (median interval ->
 * one bar-spacing of pixels) per slot. Exported for testing and for consumers
 * building their own cross-density overlays.
 *
 * `times` must be ascending, in the same unit as `t` (pane-domain seconds).
 */
export function interpolateCoordinate(
  scale: TimeScaleLike,
  times: readonly number[],
  t: number,
): number | null {
  if (times.length === 0) return null;

  // Greatest i with times[i] <= t.
  let lo = 0;
  let hi = times.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      i = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // Median bar interval over the tail — a median ignores overnight/session gaps
  // that a mean would smear into every extrapolated slot.
  const deltas: number[] = [];
  for (let k = Math.max(1, times.length - STEP_SAMPLE); k < times.length; k++) {
    const d = times[k] - times[k - 1];
    if (d > 0) deltas.push(d);
  }
  deltas.sort((a, b) => a - b);
  const step = deltas.length ? deltas[Math.floor(deltas.length / 2)] : FALLBACK_STEP_SEC;
  const barSpacing = scale.options().barSpacing ?? 6;

  if (i < 0) {
    const x0 = scale.timeToCoordinate(times[0] as Time);
    return x0 == null ? null : x0 + ((t - times[0]) / step) * barSpacing;
  }
  if (i >= times.length - 1) {
    const last = times[times.length - 1];
    const xN = scale.timeToCoordinate(last as Time);
    return xN == null ? null : xN + ((t - last) / step) * barSpacing;
  }
  const ta = times[i];
  const tb = times[i + 1];
  const xa = scale.timeToCoordinate(ta as Time);
  const xb = scale.timeToCoordinate(tb as Time);
  if (xa == null || xb == null || tb === ta) return null;
  return xa + ((t - ta) * (xb - xa)) / (tb - ta);
}

export class CrosshairMarkerPrimitive implements ISeriesPrimitive<Time> {
  readonly colors: CrosshairMarkerColors;
  /** Pixel x recomputed each render pass. */
  x: number | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private chart: any | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private series: any | null = null;
  private requestUpdate: (() => void) | null = null;
  /** Marker time in the pane domain (epoch seconds). null = hidden. */
  private timeSec: number | null = null;
  private readonly view: CrosshairMarkerPaneView;

  constructor(colors: Partial<CrosshairMarkerColors> = {}) {
    this.colors = { ...DEFAULT_COLORS, ...colors };
    this.view = new CrosshairMarkerPaneView(this);
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
    this.timeSec = null;
    this.x = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  updateAllViews(): void {
    if (!this.chart || this.timeSec == null) {
      this.x = null;
      return;
    }
    const t = this.timeSec;
    const scale = this.chart.timeScale() as TimeScaleLike;
    // Exact when the time lands on one of this chart's time-scale points.
    const exact = scale.timeToCoordinate(t as Time);
    this.x = exact ?? interpolateCoordinate(scale, this.seriesTimes(), t);
  }

  /** Place (or move) the marker. `timeSec` = pane-domain epoch seconds. */
  set(timeSec: number): void {
    this.timeSec = timeSec;
    this.requestUpdate?.();
  }

  /** Whether a marker is currently set. */
  isSet(): boolean {
    return this.timeSec != null;
  }

  /** Current marker time (epoch seconds) or null. */
  getTimeSec(): number | null {
    return this.timeSec;
  }

  clear(): void {
    this.timeSec = null;
    this.x = null;
    this.requestUpdate?.();
  }

  private seriesTimes(): number[] {
    const data = this.series?.data?.() as ReadonlyArray<{ time: unknown }> | undefined;
    if (!data || data.length === 0) return [];
    const out: number[] = new Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = Number(data[i].time);
    return out;
  }
}
