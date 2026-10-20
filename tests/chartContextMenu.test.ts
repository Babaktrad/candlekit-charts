// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement as h, act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChartContext, type ChartViewApi } from "../src/react/context";
import { ChartContextMenu, type ChartContextMenuContext } from "../src/react/ChartContextMenu";
import { PRIMARY_PANE_KEY, indicatorPaneKeys } from "../src/indicators/paneKeyRegistry";
import type { ISeriesApi, SeriesType } from "lightweight-charts";
import type { Drawing } from "../src/drawing/types";

// react-dom/client + act require this flag in React 18.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DRAWING = { id: "d1", tool: "trendline", points: [], style: {} } as unknown as Drawing;

/** Minimal drawing engine: selection + a change subscription. */
class FakeEngine {
  selectedId: string | null = null;
  private cbs = new Set<() => void>();
  remove = vi.fn(() => this.emit());
  add = vi.fn();
  update = vi.fn(() => this.emit());
  getSelectedId() {
    return this.selectedId;
  }
  getById(id: string) {
    return id === DRAWING.id ? DRAWING : undefined;
  }
  onChange(cb: () => void) {
    this.cbs.add(cb);
    return () => void this.cbs.delete(cb);
  }
  emit() {
    for (const cb of this.cbs) cb();
  }
}

// A pane is named by looking its series up in the shared registry, so a fake
// oscillator pane has to be registered the same way the controller does it.
const OSC_SERIES = {} as unknown as ISeriesApi<SeriesType>;
indicatorPaneKeys.set(OSC_SERIES, "RSI");

/** Chart stub: one price pane, optionally an indicator pane beneath it. */
function fakeChart(el: HTMLElement, panes = 1) {
  return {
    chartElement: () => el,
    timeScale: () => ({ coordinateToTime: (x: number) => (x < 0 ? null : x) }),
    panes: () =>
      Array.from({ length: panes }, (_, i) => ({
        getHeight: () => 100,
        getSeries: () => (i === 0 ? [] : [OSC_SERIES]),
      })),
  };
}

function api(el: HTMLElement, over: Partial<ChartViewApi> & { panes?: number } = {}): ChartViewApi {
  const { panes, ...rest } = over;
  return {
    controller: {
      getChart: () => fakeChart(el, panes ?? 1),
      getSeries: () => ({ coordinateToPrice: (y: number) => 1000 - y }),
      bus: { on: () => () => {} },
    },
    drawing: null,
    indicators: null,
    measurement: null,
    pointMarker: null,
    sketch: null,
    echoes: null,
    ...rest,
  } as unknown as ChartViewApi;
}

let host: HTMLDivElement;
let chartEl: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  chartEl = document.createElement("div");
  document.body.append(host, chartEl);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  chartEl.remove();
});

function render(el: ReactElement) {
  act(() => root.render(el));
}

function mount(apiValue: ChartViewApi, props: Record<string, unknown> = {}) {
  render(h(ChartContext.Provider, { value: apiValue }, h(ChartContextMenu, props as never)));
}

/** Right-click the chart element at (x, y) and report whether it was consumed. */
function rightClick(x = 40, y = 40): boolean {
  const ev = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  act(() => void chartEl.dispatchEvent(ev));
  return ev.defaultPrevented;
}

const menu = () => host.querySelector('[role="menu"]');
const labels = () => Array.from(host.querySelectorAll("button")).map((b) => b.textContent);

describe("ChartContextMenu", () => {
  it("stays closed and leaves the browser menu alone when it has nothing to offer", () => {
    mount(api(chartEl));
    const prevented = rightClick();
    expect(prevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it("opens for a selected drawing and offers its actions", () => {
    const engine = new FakeEngine();
    engine.selectedId = DRAWING.id;
    mount(api(chartEl, { drawing: { engine } as never }));

    expect(rightClick()).toBe(true);
    expect(menu()).not.toBeNull();
    const text = host.textContent ?? "";
    expect(text).toContain("trendline");
    expect(labels().join("|").toLowerCase()).toContain("delete");
  });

  it("offers a remove entry per active indicator", () => {
    mount(api(chartEl, { indicators: { activeNames: () => ["RSI", "MACD"] } as never }));
    expect(rightClick()).toBe(true);
    const text = host.textContent ?? "";
    expect(text).toContain("RSI");
    expect(text).toContain("MACD");
  });

  it("suppresses indicator entries when showIndicatorItems is false", () => {
    mount(api(chartEl, { indicators: { activeNames: () => ["RSI"] } as never }), {
      showIndicatorItems: false,
    });
    // Nothing else to offer, so the menu must not open at all.
    expect(rightClick()).toBe(false);
    expect(menu()).toBeNull();
  });

  it("renders host-supplied extraItems and runs one on click", () => {
    const onSelect = vi.fn();
    mount(api(chartEl), { extraItems: [{ id: "x", label: "Do a host thing", onSelect }] });

    expect(rightClick()).toBe(true);
    const btn = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "Do a host thing",
    );
    expect(btn).toBeTruthy();

    act(() => btn!.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    // Selecting an item closes the menu.
    expect(menu()).toBeNull();
  });

  it("passes what was under the cursor to a function-form extraItems", () => {
    let seen: ChartContextMenuContext | null = null;
    mount(api(chartEl), {
      extraItems: (ctx: ChartContextMenuContext) => {
        seen = ctx;
        return [{ id: "x", label: "x", onSelect: () => {} }];
      },
    });

    rightClick(40, 40);
    expect(seen).not.toBeNull();
    expect(seen!.paneKey).toBe(PRIMARY_PANE_KEY);
    expect(seen!.price).toBeTypeOf("number");
    expect(seen!.ts).toBeTypeOf("number");
    expect(seen!.drawing).toBeNull();
  });

  it("reports a null price off the price pane, rather than a plausible wrong one", () => {
    // An indicator pane has its own scale; extrapolating the price scale into
    // it would hand back a number that looks real and is not.
    let seen: ChartContextMenuContext | null = null;
    mount(api(chartEl, { panes: 2 }), {
      extraItems: (ctx: ChartContextMenuContext) => {
        seen = ctx;
        return [{ id: "x", label: "x", onSelect: () => {} }];
      },
    });

    rightClick(40, 150); // y=150 falls in the second pane (each is 100 tall)
    expect(seen!.paneKey).toBe("RSI");
    expect(seen!.price).toBeNull();
  });

  describe("viewport clamp", () => {
    // happy-dom does no layout, so give the menu a real size: 200 x 300.
    const MENU_W = 200;
    const MENU_H = 300;
    let rectSpy: { mockRestore(): void };
    beforeEach(() => {
      rectSpy = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          const isMenu = this.getAttribute("role") === "menu";
          const width = isMenu ? MENU_W : 0;
          const height = isMenu ? MENU_H : 0;
          return {
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: width,
            bottom: height,
            width,
            height,
            toJSON() {},
          } as DOMRect;
        });
    });
    afterEach(() => rectSpy.mockRestore());

    const ITEMS = { extraItems: [{ id: "x", label: "x", onSelect: () => {} }] };
    const box = () => menu() as HTMLElement;

    it("opens at the click point when the menu fits", () => {
      mount(api(chartEl), ITEMS);
      rightClick(40, 40);
      expect(box().style.left).toBe("40px");
      expect(box().style.top).toBe("40px");
    });

    it("pulls a menu opened near the bottom-right corner back inside the window", () => {
      mount(api(chartEl), ITEMS);
      rightClick(window.innerWidth - 10, window.innerHeight - 10);
      expect(box().style.left).toBe(`${window.innerWidth - MENU_W - 4}px`);
      expect(box().style.top).toBe(`${window.innerHeight - MENU_H - 4}px`);
    });
  });

  it("closes on Escape", () => {
    mount(api(chartEl), { extraItems: [{ id: "x", label: "x", onSelect: () => {} }] });
    rightClick();
    expect(menu()).not.toBeNull();

    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(menu()).toBeNull();
  });

  it("closes on an outside pointerdown", () => {
    mount(api(chartEl), { extraItems: [{ id: "x", label: "x", onSelect: () => {} }] });
    rightClick();
    expect(menu()).not.toBeNull();

    act(() => void window.dispatchEvent(new Event("pointerdown")));
    expect(menu()).toBeNull();
  });

  it("unbinds its chart listener on unmount", () => {
    mount(api(chartEl), { extraItems: [{ id: "x", label: "x", onSelect: () => {} }] });
    act(() => root.unmount());
    // Re-created in afterEach; a stray listener would still preventDefault.
    expect(rightClick()).toBe(false);
    root = createRoot(host);
  });
});
