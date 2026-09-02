/**
 * series → stable pane key ("RSI", "MACD", …) for indicator sub-pane series.
 *
 * Populated by {@link IndicatorController} when it creates oscillator plot
 * series in their own pane. A host that wants per-pane behaviour (binding a
 * drawing surface to an oscillator pane, keying persisted state by pane,
 * resolving which pane a pointer is over) reads it to name the pane a series
 * belongs to without having to reach into the controller's internals.
 *
 * A `WeakMap` so a removed series is collected with its entry, and its own
 * module so nothing has to import the controller just to read a key.
 */

import type { ISeriesApi, SeriesType } from "lightweight-charts";

/** The main price pane. Series not present in {@link indicatorPaneKeys} are on it. */
export const PRIMARY_PANE_KEY = "__primary__";

export const indicatorPaneKeys = new WeakMap<ISeriesApi<SeriesType>, string>();

/** Pane key for a series — the indicator's name, or {@link PRIMARY_PANE_KEY}. */
export function paneKeyOf(series: ISeriesApi<SeriesType> | null | undefined): string {
  if (!series) return PRIMARY_PANE_KEY;
  return indicatorPaneKeys.get(series) ?? PRIMARY_PANE_KEY;
}
