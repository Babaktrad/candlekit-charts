import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { IndicatorLegendEntry, IndicatorPlotKey } from "../indicators/IndicatorController";
import { useChartApi } from "./context";

export interface IndicatorLegendProps {
  className?: string;
  style?: CSSProperties;
  /**
   * Show the value at this instant (epoch ms) instead of the local crosshair —
   * for a chart mirroring a linked one, whose crosshair is positioned
   * programmatically and so fires no crosshair-move event. `undefined` follows
   * the local crosshair; `null` forces the latest value.
   */
  scanAt?: number | null;
}

/**
 * Legend readout for the active indicators: one row per non-pattern indicator
 * with its short title, its numeric inputs, and a coloured value per plotted
 * line. Renders nothing when no indicator is active.
 *
 * Row *structure* is React-rendered off the controller's `onChange`, but the
 * per-bar *numbers* are written straight to the DOM through refs on the
 * crosshair-move path — a React state update per pointer move would re-render
 * the whole overlay on every mouse pixel. `pointerEvents: none` so the chart
 * keeps every drag / crosshair / click underneath.
 */
export function IndicatorLegend({ className, style, scanAt }: IndicatorLegendProps) {
  const { controller, indicators } = useChartApi();
  const [entries, setEntries] = useState<IndicatorLegendEntry[]>([]);
  const valueRefs = useRef<Map<IndicatorPlotKey, HTMLSpanElement>>(new Map());
  // True while the crosshair sits over a bar — blocks a data refresh from
  // flashing the latest value over the hovered one.
  const hovering = useRef(false);

  const paint = useCallback(
    (tsMs: number | null) => {
      if (!indicators) return;
      const values = indicators.valuesAt(tsMs);
      for (const [key, el] of valueRefs.current) {
        const v = values.get(key);
        el.textContent = v == null ? "—" : fmtVal(v);
      }
    },
    [indicators],
  );

  // Row structure follows the active set.
  useEffect(() => {
    if (!indicators) return;
    return indicators.subscribe(() => setEntries(indicators.legendEntries()));
  }, [indicators]);

  // Local crosshair drives the numbers, unless the host is scanning for us.
  // `entries` is a dependency because the spans are recreated with the rows.
  useEffect(() => {
    if (!indicators || scanAt !== undefined) return;
    const off = controller.bus.on("crosshairMove", (e) => {
      hovering.current = e != null;
      paint(e ? e.ts : null);
    });
    paint(null);
    return off;
  }, [controller, indicators, scanAt, entries, paint]);

  // Host-driven scan (a mirrored crosshair). `null` = show the latest value.
  useEffect(() => {
    if (!indicators || scanAt === undefined) return;
    hovering.current = scanAt !== null;
    paint(scanAt);
  }, [indicators, scanAt, entries, paint]);

  // A data refresh moves the latest value; repaint unless the user is hovering.
  useEffect(() => {
    if (!indicators) return;
    return controller.bus.on("data", () => {
      if (!hovering.current) paint(scanAt ?? null);
    });
  }, [controller, indicators, entries, scanAt, paint]);

  if (!indicators || entries.length === 0) return null;

  return (
    <div className={className ?? "ck-legend"} style={style}>
      {entries.map((entry) => (
        <div key={entry.name} className="ck-legend-row">
          <span className="ck-legend-name">
            {entry.shortTitle}
            {entry.params ? ` ${entry.params}` : ""}
          </span>
          {entry.plots.map((plot) => (
            <span key={plot.plotId} className="ck-legend-plot">
              {entry.plots.length > 1 && <span className="ck-legend-plot-title">{plot.title}</span>}
              <span aria-hidden className="ck-legend-dot" style={{ background: plot.color }} />
              <span
                data-indicator-plot={plot.key}
                className="ck-legend-value"
                style={{ color: plot.color }}
                ref={(el) => {
                  if (el) valueRefs.current.set(plot.key, el);
                  else valueRefs.current.delete(plot.key);
                }}
              >
                —
              </span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Big numbers lose decimals, small ones keep precision (62.34 vs 0.0412). */
function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4);
}
