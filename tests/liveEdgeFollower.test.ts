/**
 * liveEdgeFollower — live bars must keep the forming candle near the right edge
 * WITHOUT ever pulling a user who scrolled back into history, and without
 * reacting to forming-bar ticks, history prepends, or full data reloads.
 */
import { describe, expect, it } from "vitest";
import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";
import {
  attachLiveEdgeFollower,
  liveEdgeFollowRange,
  liveGutterBars,
} from "../src/chart/liveEdgeFollower";

function makeFakes(initialTimes: number[], visible: { from: number; to: number }) {
  let data = initialTimes.map((t) => ({ time: t }));
  let range = { ...visible };
  const listeners: Array<() => void> = [];
  const series = {
    data: () => data,
    subscribeDataChanged: (fn: () => void) => listeners.push(fn),
    unsubscribeDataChanged: (fn: () => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  } as unknown as ISeriesApi<SeriesType>;
  const chart = {
    timeScale: () => ({
      // lightweight-charts semantics: bars from the last bar to the right edge.
      scrollPosition: () => range.to - (data.length - 1),
      getVisibleLogicalRange: () => ({ ...range }),
      setVisibleLogicalRange: (r: { from: number; to: number }) => {
        range = { ...r };
      },
    }),
  } as unknown as IChartApi;
  return {
    chart,
    series,
    fire: () => listeners.forEach((fn) => fn()),
    get range() {
      return range;
    },
    setData: (times: number[]) => {
      data = times.map((t) => ({ time: t }));
    },
    append: (t: number) => {
      data = [...data, { time: t }];
    },
    updateLastInPlace: () => {
      data = [...data];
    },
  };
}

const times = (n: number, step = 60, start = 1000) =>
  Array.from({ length: n }, (_, i) => start + i * step);

describe("attachLiveEdgeFollower", () => {
  it("shifts the window right by one slot when a bar appends at the live edge", () => {
    // 100 bars, viewport parked at the edge with a 10-bar gutter.
    const f = makeFakes(times(100), { from: 39, to: 109 });
    attachLiveEdgeFollower(f.chart, f.series);
    f.append(1000 + 100 * 60);
    f.fire();
    expect(f.range).toEqual({ from: 40, to: 110 }); // gutter preserved exactly
  });

  it("ignores forming-bar ticks (same last time)", () => {
    const f = makeFakes(times(100), { from: 39, to: 109 });
    attachLiveEdgeFollower(f.chart, f.series);
    f.updateLastInPlace();
    f.fire();
    expect(f.range).toEqual({ from: 39, to: 109 });
  });

  it("never pulls a user reading history forward", () => {
    // Scrolled far left: right edge 60 bars left of the last bar.
    const f = makeFakes(times(100), { from: 0, to: 39 });
    attachLiveEdgeFollower(f.chart, f.series);
    f.append(1000 + 100 * 60);
    f.fire();
    expect(f.range).toEqual({ from: 0, to: 39 });
  });

  it("ignores history prepends (last time unchanged)", () => {
    const f = makeFakes(times(100), { from: 39, to: 109 });
    attachLiveEdgeFollower(f.chart, f.series);
    f.setData([...times(50, 60, 1000 - 50 * 60), ...times(100)]);
    f.fire();
    expect(f.range).toEqual({ from: 39, to: 109 });
  });

  it("treats a huge forward jump as a data reload, not live bars", () => {
    const f = makeFakes(times(100), { from: 39, to: 109 });
    attachLiveEdgeFollower(f.chart, f.series);
    f.setData(times(400, 60, 1000 + 200 * 60)); // symbol / range switch
    f.fire();
    expect(f.range).toEqual({ from: 39, to: 109 }); // host refits, we stay out
  });

  it("respects the isPaused veto", () => {
    const f = makeFakes(times(100), { from: 39, to: 109 });
    attachLiveEdgeFollower(f.chart, f.series, { isPaused: () => true });
    f.append(1000 + 100 * 60);
    f.fire();
    expect(f.range).toEqual({ from: 39, to: 109 });
  });

  it("detach stops following", () => {
    const f = makeFakes(times(100), { from: 39, to: 109 });
    const detach = attachLiveEdgeFollower(f.chart, f.series);
    detach();
    f.append(1000 + 100 * 60);
    f.fire();
    expect(f.range).toEqual({ from: 39, to: 109 });
  });
});

/**
 * The gutter floor. Without it a viewport whose whitespace was clamped away by
 * a `setVisibleRange` restore keeps the newest bar flush against the price axis
 * forever — a relative shift preserves a zero gutter exactly as faithfully as a
 * healthy one.
 */
describe("liveEdgeFollowRange", () => {
  it("re-opens a gutter that was clamped to zero, keeping the width", () => {
    // 100 bars, last bar flush on the right edge (gutter 0), 70-bar window.
    // 12% of 70 = 8.4 → below the floor, so the floor (10) wins; last index 99.
    expect(liveEdgeFollowRange({ from: 29, to: 99 }, 100, 10)).toEqual({ from: 39, to: 109 });
  });

  it("scales the gutter with the visible window, floored at minGutterBars", () => {
    expect(liveGutterBars(375, 10)).toBe(45); // a full session of 1-minute bars
    expect(liveGutterBars(40, 10)).toBe(10); // tight zoom → the floor wins
  });

  it("leaves a viewport that already has enough lead alone", () => {
    expect(liveEdgeFollowRange({ from: 39, to: 160 }, 100, 10)).toBeNull();
  });

  it("never pulls a user reading history forward", () => {
    // Newest bar is 40 slots right of the visible window.
    expect(liveEdgeFollowRange({ from: -11, to: 59 }, 100, 10)).toBeNull();
  });

  it("declines degenerate and empty inputs", () => {
    expect(liveEdgeFollowRange(null, 100, 10)).toBeNull();
    expect(liveEdgeFollowRange({ from: 0, to: 70 }, 0, 10)).toBeNull();
    expect(liveEdgeFollowRange({ from: 99, to: 100 }, 100, 10)).toBeNull();
  });

  it("tops the gutter up on append when the host asks for a floor", () => {
    const f = makeFakes(times(100), { from: 29, to: 99 }); // gutter eaten
    attachLiveEdgeFollower(f.chart, f.series, { minGutterBars: 10 });
    f.append(1000 + 100 * 60);
    f.fire();
    // 101 bars now; width 70 → gutter floors at 10; last index 100 → to = 110.
    expect(f.range).toEqual({ from: 40, to: 110 });
  });

  it("without a floor, preserves whatever gutter there is", () => {
    const f = makeFakes(times(100), { from: 29, to: 99 });
    attachLiveEdgeFollower(f.chart, f.series);
    f.append(1000 + 100 * 60);
    f.fire();
    expect(f.range).toEqual({ from: 30, to: 100 });
  });
});
