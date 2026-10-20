import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ownerWindowOf } from "../dom/ownerWindow";
import { PRIMARY_PANE_KEY, indicatorPaneKeys } from "../indicators/paneKeyRegistry";
import type { Drawing } from "../drawing/types";
import { useChartApi } from "./context";

/** A caller-supplied entry. The library never inspects what it does. */
export interface ChartContextMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  /** Render in the destructive colour. */
  danger?: boolean;
  disabled?: boolean;
  /** Draw a separator above this item. */
  separatorBefore?: boolean;
}

/** What was under the cursor when the menu opened. */
export interface ChartContextMenuContext {
  /** Instant under the cursor (epoch ms), or null off the time scale. */
  ts: number | null;
  /**
   * Price under the cursor, or null when the cursor is not on the price pane —
   * an indicator pane has its own scale, and extrapolating the price scale into
   * it hands back a plausible-looking wrong number.
   */
  price: number | null;
  /** Pane the cursor is over: {@link PRIMARY_PANE_KEY} or an indicator name. */
  paneKey: string;
  /** The selected drawing, or null. */
  drawing: Drawing | null;
  /** Names of the currently active indicators. */
  indicators: string[];
}

export interface ChartContextMenuProps {
  className?: string;
  style?: CSSProperties;
  /**
   * Extra entries appended to the menu, so a host can add its own actions
   * without this component knowing what they are. Pass a function to decide
   * from what was under the cursor.
   */
  extraItems?: ChartContextMenuItem[] | ((ctx: ChartContextMenuContext) => ChartContextMenuItem[]);
  /** Swatches offered in the drawing style row. */
  colors?: string[];
  /** Line widths offered in the drawing style row. */
  widths?: number[];
  /** Offer "Remove <indicator>" for each active indicator. Default `true`. */
  showIndicatorItems?: boolean;
}

const DEFAULT_COLORS = ["#2962ff", "#26a69a", "#ef5350", "#f59e0b", "#a855f7", "#94a3b8"];
const DEFAULT_WIDTHS = [1, 2, 3, 4];

/**
 * Right-click menu for the chart.
 *
 * Acts on what the cursor is on: the selected drawing (clone / style / delete),
 * the indicators plotted here (remove), plus whatever the host appends through
 * {@link ChartContextMenuProps.extraItems}. It opens only when there is
 * something to offer, so a plain right-click on empty chart keeps the browser's
 * own menu unless the host supplies items.
 *
 * Dismissal is bound to the chart's OWN window: a chart rendered into a second
 * browser window never sees the main one's events, which would leave the menu
 * stuck open with no way to close it.
 */
export function ChartContextMenu({
  className,
  style,
  extraItems,
  colors = DEFAULT_COLORS,
  widths = DEFAULT_WIDTHS,
  showIndicatorItems = true,
}: ChartContextMenuProps) {
  const { controller, drawing, indicators } = useChartApi();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [ctx, setCtx] = useState<ChartContextMenuContext | null>(null);
  // Bumped so the open menu re-reads engine state after an action.
  const [, force] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    setPos(null);
    setCtx(null);
  }, []);

  // Deselecting a drawing while the menu is open makes its entries stale.
  useEffect(() => {
    const engine = drawing?.engine;
    if (!engine) return;
    return engine.onChange(() => force((n) => n + 1));
  }, [drawing]);

  useEffect(() => {
    const el = controller.getChart().chartElement();

    const onContextMenu = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const chart = controller.getChart();
      const scale = chart.timeScale();
      const t = scale.coordinateToTime(x);
      const ts = t == null ? null : Number(t) * 1000;

      // Only the first pane carries the price scale the main series is on.
      const paneKey = paneKeyAt(chart, y);
      const price =
        paneKey === PRIMARY_PANE_KEY ? finiteOrNull(controller.getSeries().coordinateToPrice(y)) : null;

      const next: ChartContextMenuContext = {
        ts,
        price,
        paneKey,
        drawing: selectedDrawing(drawing?.engine),
        indicators: indicators?.activeNames() ?? [],
      };
      // Nothing to show → leave the browser's own menu alone.
      if (!hasAnything(next, extraItems, showIndicatorItems)) return;

      e.preventDefault();
      setCtx(next);
      setPos({ x: e.clientX, y: e.clientY });
    };

    el.addEventListener("contextmenu", onContextMenu);
    return () => el.removeEventListener("contextmenu", onContextMenu);
  }, [controller, drawing, indicators, extraItems, showIndicatorItems]);

  // Dismiss on outside pointer-down or Escape, in the chart's own window.
  useEffect(() => {
    if (!pos) return;
    const win = ownerWindowOf(controller.getChart().chartElement());
    const onDown = () => close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    win.addEventListener("pointerdown", onDown);
    win.addEventListener("keydown", onKey);
    return () => {
      win.removeEventListener("pointerdown", onDown);
      win.removeEventListener("keydown", onKey);
    };
  }, [pos, controller, close]);

  // Keep the menu inside the viewport: opened near the bottom or right edge (or
  // made tall by many host items) it would hang off-screen. Settles in one
  // pass — a clamped position re-measures to itself.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!pos || !el) return;
    const win = ownerWindowOf(el);
    const r = el.getBoundingClientRect();
    const x = Math.max(4, Math.min(pos.x, win.innerWidth - r.width - 4));
    const y = Math.max(4, Math.min(pos.y, win.innerHeight - r.height - 4));
    if (x !== pos.x || y !== pos.y) setPos({ x, y });
  }, [pos]);

  if (!pos || !ctx) return null;

  const engine = drawing?.engine ?? null;
  const selected = ctx.drawing;
  const extras = typeof extraItems === "function" ? extraItems(ctx) : (extraItems ?? []);
  const indicatorNames = showIndicatorItems ? ctx.indicators : [];

  const run = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
    close();
  };

  return (
    <div
      ref={rootRef}
      className={className ?? "ck-menu"}
      style={{ left: pos.x, top: pos.y, ...style }}
      onPointerDown={(e) => e.stopPropagation()}
      role="menu"
    >
      {selected && engine && (
        <>
          <div className="ck-menu-head">{selected.tool}</div>

          <button type="button" className="ck-menu-item" onClick={run(() => cloneDrawing(engine, selected))}>
            Clone
          </button>

          <div className="ck-menu-sep" />
          <div className="ck-menu-styles">
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                aria-label={`Colour ${c}`}
                className={`ck-menu-swatch${selected.style.color === c ? " ck-menu-swatch--on" : ""}`}
                style={{ background: c }}
                onClick={(e) => {
                  e.stopPropagation();
                  engine.setStyle(selected.id, { color: c });
                }}
              />
            ))}
          </div>
          <div className="ck-menu-styles">
            {widths.map((w) => (
              <button
                key={w}
                type="button"
                title={`${w}px`}
                className={`ck-menu-width${selected.style.width === w ? " ck-menu-width--on" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  engine.setStyle(selected.id, { width: w });
                }}
              >
                {w}
              </button>
            ))}
            <button
              type="button"
              className={`ck-menu-width${selected.style.dashed ? " ck-menu-width--on" : ""}`}
              title="Dashed"
              onClick={(e) => {
                e.stopPropagation();
                engine.setStyle(selected.id, { dashed: !selected.style.dashed });
              }}
            >
              ┄
            </button>
          </div>

          <div className="ck-menu-sep" />
          <button
            type="button"
            className="ck-menu-item ck-menu-item--danger"
            onClick={run(() => engine.remove(selected.id))}
          >
            Delete
          </button>
        </>
      )}

      {indicatorNames.length > 0 && indicators && (
        <>
          {selected && <div className="ck-menu-sep" />}
          {indicatorNames.map((name) => (
            <button
              key={name}
              type="button"
              className="ck-menu-item"
              onClick={run(() => indicators.remove(name))}
            >
              Remove {name}
            </button>
          ))}
        </>
      )}

      {extras.map((item) => (
        <div key={item.id}>
          {item.separatorBefore && <div className="ck-menu-sep" />}
          <button
            type="button"
            disabled={item.disabled}
            className={`ck-menu-item${item.danger ? " ck-menu-item--danger" : ""}`}
            onClick={run(item.onSelect)}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

function finiteOrNull(v: number | null): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function selectedDrawing(engine: { getSelectedId(): string | null; getById(id: string): Drawing | undefined } | undefined) {
  if (!engine) return null;
  const id = engine.getSelectedId();
  return id ? (engine.getById(id) ?? null) : null;
}

/**
 * Which pane the y coordinate (relative to the chart element) falls in. Panes
 * stack top-to-bottom; pane 0 holds the main series, the rest are indicator
 * panes registered in {@link indicatorPaneKeys}.
 */
function paneKeyAt(
  chart: { panes(): Array<{ getHeight(): number; getSeries(): unknown[] }> },
  y: number,
): string {
  let top = 0;
  const panes = chart.panes();
  for (let i = 0; i < panes.length; i++) {
    const h = panes[i].getHeight();
    if (y < top + h) return i === 0 ? PRIMARY_PANE_KEY : indicatorPaneName(panes[i]);
    top += h;
  }
  return PRIMARY_PANE_KEY;
}

function indicatorPaneName(pane: { getSeries(): unknown[] }): string {
  for (const s of pane.getSeries()) {
    const key = indicatorPaneKeys.get(s as never);
    if (key) return key;
  }
  return PRIMARY_PANE_KEY;
}

function hasAnything(
  ctx: ChartContextMenuContext,
  extraItems: ChartContextMenuProps["extraItems"],
  showIndicatorItems: boolean,
): boolean {
  if (ctx.drawing) return true;
  if (showIndicatorItems && ctx.indicators.length > 0) return true;
  const extras = typeof extraItems === "function" ? extraItems(ctx) : (extraItems ?? []);
  return extras.length > 0;
}

/** Duplicate a drawing, nudged so the copy is visible under the original. */
function cloneDrawing(
  engine: { commit(d: Drawing): void; newDrawingId(): string },
  d: Drawing,
): void {
  engine.commit({
    ...d,
    id: engine.newDrawingId(),
    points: d.points.map((p) => ({ ...p, price: p.price * 1.001 })),
    style: { ...d.style },
  });
}
