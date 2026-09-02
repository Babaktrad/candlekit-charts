/**
 * liveEdgeFollower — keep a chart pinned to its live edge as new bars arrive.
 *
 * lightweight-charts' own `shiftVisibleRangeOnNewBar` is deliberately off in
 * {@link ChartController} (it also fires on every replay `setData`, which is
 * indistinguishable from a live append and yanks the viewport during playback).
 * The side effect is that in a live session the viewport stays put in *logical*
 * space while bars append, so the forming candle walks right and eventually
 * leaves the frame.
 *
 * This follower re-implements the useful half of that behaviour with the
 * conditions a trading UI actually wants:
 *   - it fires only when the LAST bar's time advances (a genuine append) —
 *     forming-bar tick updates (same time), history prepends (last time
 *     unchanged) and older-range reloads (last time decreases) are all no-ops;
 *   - it follows only while the user is parked AT the live edge
 *     (`scrollPosition() > -tolerance`): someone reading history is never
 *     pulled forward;
 *   - it shifts RELATIVELY by the number of appended slots, so the user's
 *     chosen right-hand whitespace and zoom are preserved bar-for-bar;
 *   - a jump larger than `maxAppendSlots` is treated as a data reload (symbol
 *     or range switch, replay seek), not a live append — the host refits.
 *
 * The shift goes through `setVisibleLogicalRange`, i.e. it is a programmatic
 * range change rather than a user gesture, so a sync layer that classifies
 * gestures (see `src/sync/`) will not let a chart following its own live edge
 * drag its whole group.
 */

import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";

export interface LiveEdgeFollowerOptions {
  /**
   * How far (in bars) the viewport may have drifted past the live edge and
   * still count as "parked at the edge". Default 3.
   */
  tolerance?: number;
  /** Appends larger than this are treated as a data reload, not live bars. Default 50. */
  maxAppendSlots?: number;
  /** Optional veto — return true to suspend following (e.g. during a replay scrub). */
  isPaused?: () => boolean;
  /**
   * Floor for the right-hand gutter, in bars (see {@link liveEdgeFollowRange}).
   * Undefined = no floor: shift by the appended slots and preserve whatever
   * gutter the user has. Set it on a surface where the gutter can be eaten by
   * something else — a `setVisibleRange` restore clamps to the data extent and
   * pins the newest bar flush against the price axis, and a relative shift then
   * preserves exactly that.
   */
  minGutterBars?: number;
}

/**
 * Fraction of the visible window kept as whitespace to the RIGHT of the newest
 * bar on a live-following chart. A fixed 10-bar gutter on a 375-bar window is
 * 2.7% — visually flush against the price axis; 12% puts the forming bar
 * clearly inside the frame while still spending most of the width on data.
 */
export const LIVE_GUTTER_FRAC = 0.12;

/** Target gutter in bars for a window of `visibleBars`, never below `minBars`. */
export const liveGutterBars = (visibleBars: number, minBars: number): number =>
  Math.max(minBars, Math.round(Math.max(0, visibleBars) * LIVE_GUTTER_FRAC));

/**
 * Range that restores the live gutter, or null to leave the viewport alone.
 *
 * Two guards, both load-bearing:
 *   - a viewport parked left of the newest bar by more than `tolerance` belongs
 *     to someone reading history; it is NEVER pulled forward;
 *   - a viewport that already has at least the target gutter is left exactly as
 *     it is, so this can only ever add whitespace, never take it away.
 *
 * Width is preserved to the bar, so it cannot zoom.
 */
export function liveEdgeFollowRange(
  vis: { from: number; to: number } | null,
  barCount: number,
  minGutterBars: number,
  tolerance = 3,
): { from: number; to: number } | null {
  if (!vis || barCount <= 0) return null;
  const lastIdx = barCount - 1;
  if (vis.to < lastIdx - tolerance) return null; // reading history
  const width = vis.to - vis.from;
  if (width < 2) return null; // degenerate
  const gutter = liveGutterBars(width, minGutterBars);
  if (vis.to - lastIdx >= gutter) return null; // already clear
  const to = lastIdx + gutter;
  return { from: to - width, to };
}

/**
 * Attach to the chart's primary series (the one that anchors sync). Returns a
 * detach function.
 */
export function attachLiveEdgeFollower(
  chart: IChartApi,
  series: ISeriesApi<SeriesType>,
  opts: LiveEdgeFollowerOptions = {},
): () => void {
  const tolerance = opts.tolerance ?? 3;
  const maxAppend = opts.maxAppendSlots ?? 50;

  const lastBarTime = (): number | null => {
    const d = series.data();
    if (!d.length) return null;
    const t = Number((d[d.length - 1] as { time: unknown }).time);
    return Number.isFinite(t) ? t : null;
  };

  let prevTime = lastBarTime();

  const onDataChanged = () => {
    const t = lastBarTime();
    if (t == null) {
      prevTime = null;
      return;
    }
    const prev = prevTime;
    prevTime = t;
    if (prev == null || t <= prev) return; // tick-in-place / prepend / reload-older
    if (opts.isPaused?.()) return;

    // Count appended slots (usually 1; bounded walk from the tail).
    const d = series.data();
    let delta = 0;
    for (let i = d.length - 1; i >= 0; i--) {
      if (Number((d[i] as { time: unknown }).time) <= prev) break;
      delta++;
      if (delta > maxAppend) return; // data reload — the host refits
    }
    if (delta === 0) return;

    const scale = chart.timeScale();
    // scrollPosition() = distance (bars) from the last bar to the right edge;
    // positive = whitespace gutter, negative = last bar off-screen right.
    // dataChanged fires AFTER the append landed, so a parked chart reads
    // (previous gutter − delta) here.
    const pos = scale.scrollPosition();
    if (pos == null || pos < -tolerance) return; // user is reading history
    const lr = scale.getVisibleLogicalRange();
    if (!lr) return;
    // Shift by the appended slots — preserves the user's zoom AND their gutter.
    const shifted = { from: lr.from + delta, to: lr.to + delta };
    // …then, where the host asks for it, top the gutter back up. Without this a
    // chart whose gutter was clamped away once keeps the newest bar flush right
    // forever, because a relative shift preserves a zero gutter just as
    // faithfully as a healthy one.
    const next =
      opts.minGutterBars != null
        ? (liveEdgeFollowRange(shifted, series.data().length, opts.minGutterBars, tolerance) ?? shifted)
        : shifted;
    try {
      scale.setVisibleLogicalRange(next);
    } catch {
      /* invalid range */
    }
  };

  series.subscribeDataChanged(onDataChanged);
  return () => {
    try {
      series.unsubscribeDataChanged(onDataChanged);
    } catch {
      /* series already gone */
    }
  };
}
