/**
 * ReplayController — playback-stall regressions and the forming coarse bar.
 *
 * Four behaviours pinned here:
 *   1. A manifest start on a day with no bars parked the initial cursor at the
 *      END of the cached data — Play then had nothing to advance through. With
 *      several series, one that has no bars on the picked day must not drag
 *      the cursor back to its own older last day.
 *   2. Play while parked at the cached tail no-oped: the first advance failed
 *      and flipped `playing` straight back off.
 *   3. At a day boundary the cursor could outrun the forward prefetch and
 *      playback halted instead of rolling into the next day.
 *   4. The newest coarse bar printed complete the instant its bucket opened;
 *      it must grow from the driver series instead.
 */

import { describe, expect, it, vi } from "vitest";
import type { Bar, IntervalCode, SymbolId } from "../src/core/types";
import type { ReplayDataSource } from "../src/data-source/types";
import type { ReplayManifest } from "../src/replay/types";
import { ReplayControllerImpl } from "../src/replay/ReplayController";

const SYM: SymbolId = "DEMO";
const TF: IntervalCode = "1m";

/** Epoch ms for a `date` + `HH:MM` read as UTC (the chart's own domain). */
function ts(date: string, hhmm: string): number {
  return Date.parse(`${date}T${hhmm}:00Z`);
}

function dayBars(date: string, count: number, from = "09:15"): Bar[] {
  const start = ts(date, from);
  return Array.from({ length: count }, (_, i) => ({
    ts: start + i * 60_000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 10,
  }));
}

/** In-memory source over a fixed map of session days. */
function makeSource(days: Record<string, Bar[]>, opts?: { fetchDelayMs?: number }): ReplayDataSource {
  const dates = Object.keys(days).sort();
  return {
    async fetchDay(_s, _i, date) {
      if (opts?.fetchDelayMs) await new Promise((r) => setTimeout(r, opts.fetchDelayMs));
      return days[date] ?? [];
    },
    async listDatesBefore(_s, _i, date, n) {
      return dates
        .filter((d) => d < date)
        .reverse()
        .slice(0, n);
    },
    async listDatesAfter(_s, _i, date, n) {
      return dates.filter((d) => d > date).slice(0, n);
    },
  };
}

function makeManifest(source: ReplayDataSource, startDate: string): ReplayManifest {
  return {
    id: `test-${startDate}`,
    series: [{ symbol: SYM, interval: TF }],
    start: ts(startDate, "09:15"),
    end: ts(startDate, "15:30"),
    source,
  };
}

function readyState(c: ReplayControllerImpl) {
  const s = c.getState();
  if (s.status !== "ready") throw new Error(`expected ready, got ${s.status}`);
  return s;
}

describe("initial cursor placement", () => {
  it("starts at the manifest start's first bar on a normal session day", async () => {
    const source = makeSource({
      "2026-07-09": dayBars("2026-07-09", 30),
      "2026-07-10": dayBars("2026-07-10", 30),
    });
    const c = new ReplayControllerImpl();
    await c.load(makeManifest(source, "2026-07-10"));
    expect(readyState(c).cursor.ts).toBe(ts("2026-07-10", "09:15"));
  });

  it("falls back to the OPEN of the latest cached day when the picked day has no bars", async () => {
    // Manifest start = a non-session date; backward prefetch pulls the two
    // preceding session days.
    const source = makeSource({
      "2026-07-09": dayBars("2026-07-09", 30),
      "2026-07-10": dayBars("2026-07-10", 30),
    });
    const c = new ReplayControllerImpl();
    await c.load(makeManifest(source, "2026-07-12"));
    // Old behaviour: cursor = the last cached bar (end of data) → Play no-oped.
    expect(readyState(c).cursor.ts).toBe(ts("2026-07-10", "09:15"));
    // 30 prefetched bars from the earlier day + the first bar of the latest.
    expect(c.getBarsUpToCursor(SYM, TF).length).toBe(31);
  });

  // Two series where the second stops two sessions before the first. The
  // early-stopping series has nothing at or after the start, and its own
  // fallback (the open of ITS latest day) used to win the min — parking the
  // cursor before every cached day of the primary series.
  const OTHER: SymbolId = "OTHER";
  function makeMultiSource(bySymbol: Record<SymbolId, Record<string, Bar[]>>): ReplayDataSource {
    const datesOf = (s: SymbolId) => Object.keys(bySymbol[s] ?? {}).sort();
    return {
      async fetchDay(s, _i, date) {
        return bySymbol[s]?.[date] ?? [];
      },
      async listDatesBefore(s, _i, date, n) {
        return datesOf(s)
          .filter((d) => d < date)
          .reverse()
          .slice(0, n);
      },
      async listDatesAfter(s, _i, date, n) {
        return datesOf(s)
          .filter((d) => d > date)
          .slice(0, n);
      },
    };
  }
  function twoSeriesManifest(source: ReplayDataSource, startDate: string): ReplayManifest {
    return {
      ...makeManifest(source, startDate),
      series: [
        { symbol: SYM, interval: TF },
        { symbol: OTHER, interval: TF },
      ],
    };
  }
  const PRIMARY_DAYS = {
    "2026-07-09": dayBars("2026-07-09", 30),
    "2026-07-10": dayBars("2026-07-10", 30),
    "2026-07-13": dayBars("2026-07-13", 30),
  };
  const STOPS_EARLY = {
    "2026-07-07": dayBars("2026-07-07", 30),
    "2026-07-08": dayBars("2026-07-08", 30),
  };

  it("a series with no bars on the picked day does not drag the cursor back to its own last day", async () => {
    const source = makeMultiSource({ [SYM]: PRIMARY_DAYS, [OTHER]: STOPS_EARLY });
    const c = new ReplayControllerImpl();
    await c.load(twoSeriesManifest(source, "2026-07-13"));
    expect(readyState(c).cursor.ts).toBe(ts("2026-07-13", "09:15"));
    // 07-09 + 07-10 prefetched + 07-13's first bar.
    expect(c.getBarsUpToCursor(SYM, TF).length).toBe(61);
  });

  it("the no-bars fallback takes the LATEST day across series, not the earliest", async () => {
    // 2026-07-12 is a non-session date: no series has a bar at or after it.
    const source = makeMultiSource({
      [SYM]: { "2026-07-09": PRIMARY_DAYS["2026-07-09"], "2026-07-10": PRIMARY_DAYS["2026-07-10"] },
      [OTHER]: STOPS_EARLY,
    });
    const c = new ReplayControllerImpl();
    await c.load(twoSeriesManifest(source, "2026-07-12"));
    expect(readyState(c).cursor.ts).toBe(ts("2026-07-10", "09:15"));
    expect(c.getBarsUpToCursor(SYM, TF).length).toBe(31);
  });

  it("names an all-empty load differently from a loaded-but-barless range", async () => {
    const c = new ReplayControllerImpl();
    await c.load(makeManifest(makeSource({}), "2026-07-10"));
    const s = c.getState();
    expect(s.status).toBe("error");
    if (s.status !== "error") return;
    expect(s.error).toMatch(/came back empty/);
  });
});

describe("play from the cached tail", () => {
  it("restarts from the session start instead of no-oping", async () => {
    vi.useFakeTimers();
    try {
      const source = makeSource({ "2026-07-10": dayBars("2026-07-10", 10) });
      const c = new ReplayControllerImpl();
      await c.load(makeManifest(source, "2026-07-10"));
      c.seek(ts("2026-07-10", "09:24")); // last bar
      await vi.runAllTimersAsync();
      expect(readyState(c).cursor.ts).toBe(ts("2026-07-10", "09:24"));

      c.play();
      // Resume-from-end == restart: the cursor snaps back to the first bar.
      expect(readyState(c).playing).toBe(true);
      expect(readyState(c).cursor.ts).toBe(ts("2026-07-10", "09:15"));

      await vi.advanceTimersByTimeAsync(1000);
      expect(readyState(c).cursor.ts).toBe(ts("2026-07-10", "09:16"));
      expect(readyState(c).playing).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("forming coarse bar", () => {
  const TF5: IntervalCode = "5m";
  const DATE = "2026-07-10";

  /** Serves 1m bars plus the matching 5m aggregation of them. */
  function makeTfSource(minuteCount: number): { source: ReplayDataSource; minutes: Bar[] } {
    const minutes = dayBars(DATE, minuteCount);
    const five: Bar[] = [];
    for (let i = 0; i < minutes.length; i += 5) {
      const slice = minutes.slice(i, i + 5);
      five.push({
        ts: slice[0].ts,
        open: slice[0].open,
        high: Math.max(...slice.map((b) => b.high)),
        low: Math.min(...slice.map((b) => b.low)),
        close: slice[slice.length - 1].close,
        volume: slice.reduce((a, b) => a + (b.volume ?? 0), 0),
      });
    }
    return {
      minutes,
      source: {
        async fetchDay(_s, interval, d) {
          if (d !== DATE) return [];
          return interval === "1m" ? minutes : five;
        },
        async listDatesBefore() {
          return [];
        },
        async listDatesAfter() {
          return [];
        },
      },
    };
  }

  async function load5m(minuteCount: number) {
    const { source, minutes } = makeTfSource(minuteCount);
    const c = new ReplayControllerImpl();
    await c.load({
      id: "test-5m",
      series: [{ symbol: SYM, interval: TF5 }],
      start: ts(DATE, "09:15"),
      end: ts(DATE, "15:30"),
      source,
    });
    return { c, minutes };
  }

  it("steps the cursor one driver bar at a time on a 5m series", async () => {
    const { c } = await load5m(10);
    expect(readyState(c).cursor.ts).toBe(ts(DATE, "09:15"));
    c.step(1);
    expect(readyState(c).cursor.ts).toBe(ts(DATE, "09:16"));
  });

  it("grows the open bucket driver-bar by driver-bar instead of printing it complete", async () => {
    const { c, minutes } = await load5m(10);

    // Cursor at the bucket OPEN: one minute of data, NOT the finished 5m bar.
    let bars = c.getBarsUpToCursor(SYM, TF5);
    expect(bars.length).toBe(1);
    expect(bars[0].ts).toBe(ts(DATE, "09:15"));
    expect(bars[0].close).toBe(minutes[0].close);
    expect(bars[0].volume).toBe(10);

    // Three minutes in: still one bar, now carrying 09:17's close.
    c.step(1);
    c.step(1);
    bars = c.getBarsUpToCursor(SYM, TF5);
    expect(bars.length).toBe(1);
    expect(bars[0].close).toBe(minutes[2].close);
    expect(bars[0].high).toBe(minutes[2].high); // rising series
    expect(bars[0].volume).toBe(30);

    // Bucket's last minute: the fold now equals the stored 5m bar.
    c.step(1);
    c.step(1);
    expect(readyState(c).cursor.ts).toBe(ts(DATE, "09:19"));
    bars = c.getBarsUpToCursor(SYM, TF5);
    expect(bars.length).toBe(1);
    expect(bars[0].close).toBe(minutes[4].close);
    expect(bars[0].volume).toBe(50);
  });

  it("closes the bucket and opens the next one when the cursor crosses", async () => {
    const { c, minutes } = await load5m(10);
    for (let i = 0; i < 5; i++) c.step(1);
    expect(readyState(c).cursor.ts).toBe(ts(DATE, "09:20"));

    const bars = c.getBarsUpToCursor(SYM, TF5);
    expect(bars.length).toBe(2);
    // Closed bucket = the stored aggregate, verbatim.
    expect(bars[0].close).toBe(minutes[4].close);
    expect(bars[0].volume).toBe(50);
    // New bucket = its first driver bar only.
    expect(bars[1].ts).toBe(ts(DATE, "09:20"));
    expect(bars[1].close).toBe(minutes[5].close);
    expect(bars[1].volume).toBe(10);
  });

  it("returns the stored coarse bars verbatim when drivers are disabled", async () => {
    const { source, minutes } = makeTfSource(10);
    const c = new ReplayControllerImpl({
      cacheDays: 8,
      prefetchBackwardDays: 2,
      prefetchForwardOnTailPct: 0.15,
      minuteDrivers: false,
    });
    await c.load({
      id: "test-5m-nodriver",
      series: [{ symbol: SYM, interval: TF5 }],
      start: ts(DATE, "09:15"),
      end: ts(DATE, "15:30"),
      source,
    });
    const bars = c.getBarsUpToCursor(SYM, TF5);
    expect(bars.length).toBe(1);
    expect(bars[0].close).toBe(minutes[4].close); // the finished bucket
  });
});

describe("day-boundary playback", () => {
  it("rolls into the next day by awaiting the forward prefetch instead of pausing", async () => {
    const source = makeSource(
      { "2026-07-09": dayBars("2026-07-09", 3), "2026-07-10": dayBars("2026-07-10", 3) },
      { fetchDelayMs: 5 },
    );
    const c = new ReplayControllerImpl();
    // Load on real timers — the source's latency setTimeout must actually fire.
    await c.load(makeManifest(source, "2026-07-09"));
    expect(readyState(c).cursor.ts).toBe(ts("2026-07-09", "09:15"));

    vi.useFakeTimers();
    try {
      c.setSpeed(100); // 10ms/bar — outruns the 5ms-latency prefetch window
      c.play();
      await vi.advanceTimersByTimeAsync(200);
      expect(readyState(c).cursor.ts).toBeGreaterThanOrEqual(ts("2026-07-10", "09:15"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses at the true end of data", async () => {
    vi.useFakeTimers();
    try {
      const source = makeSource({ "2026-07-10": dayBars("2026-07-10", 3) });
      const c = new ReplayControllerImpl();
      await c.load(makeManifest(source, "2026-07-10"));
      c.setSpeed(100);
      c.play();
      await vi.advanceTimersByTimeAsync(500);
      const s = readyState(c);
      expect(s.cursor.ts).toBe(ts("2026-07-10", "09:17")); // last bar
      expect(s.playing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("injected scheduler", () => {
  it("drives the tick loop through the supplied timers", async () => {
    let pending: (() => void) | null = null;
    const scheduler = {
      setTimeout: (cb: () => void) => {
        pending = cb;
        return 1;
      },
      clearTimeout: () => {
        pending = null;
      },
    };
    const source = makeSource({ "2026-07-10": dayBars("2026-07-10", 5) });
    const c = new ReplayControllerImpl({
      cacheDays: 8,
      prefetchBackwardDays: 2,
      prefetchForwardOnTailPct: 0.15,
      scheduler,
    });
    await c.load(makeManifest(source, "2026-07-10"));
    c.play();
    expect(pending).not.toBeNull();
    pending!();
    expect(readyState(c).cursor.ts).toBe(ts("2026-07-10", "09:16"));
  });
});
