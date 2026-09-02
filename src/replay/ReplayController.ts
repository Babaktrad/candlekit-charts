/**
 * Deterministic replay controller. Per-(symbol, interval) per-day LRU cache with
 * backward prefetch on load and forward prefetch as the cursor nears the tail of
 * the current day. The tick loop advances the cursor one bar at a time, emitting
 * a {@link ReplayBarEvent} for each newly-visible bar.
 *
 * Ported from the application's replay engine; decoupled to read from a
 * {@link ReplayDataSource} you provide. The scheduler is used only to pace UI
 * emission — speed=N collapses pacing to ~`BASE_TICK_MS / N` per advance — and
 * is injectable so a background-throttled document cannot slow playback down
 * (see {@link ReplayScheduler}).
 *
 * A coarse intraday series also materializes a finer *driver* series, which
 * gives the cursor driver-resolution motion and lets the newest coarse bar grow
 * instead of printing complete (see {@link ReplayControllerImpl.getBarsUpToCursor}).
 */

import type { Bar, IntervalCode, SymbolId, Timestamp } from "../core/types";
import type {
  ReplayBarEvent,
  ReplayController,
  ReplayCursor,
  ReplayEngineOptions,
  ReplayManifest,
  ReplayScheduler,
  ReplaySeriesSpec,
  ReplayState,
} from "./types";

/** Host timers. Swap for a worker-backed clock via {@link ReplayScheduler}. */
const NATIVE_SCHEDULER: ReplayScheduler = {
  setTimeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
  clearTimeout: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
};

const DEFAULT_OPTIONS: ReplayEngineOptions = {
  cacheDays: 8,
  prefetchBackwardDays: 2,
  prefetchForwardOnTailPct: 0.15,
};

const DEFAULT_DRIVER_INTERVAL = "1m";

const BASE_TICK_MS = 1000;

/** Max playback speed multiplier accepted by {@link ReplayControllerImpl.setSpeed}. */
const MAX_SPEED = 100;

interface SeriesKey {
  symbol: SymbolId;
  interval: IntervalCode;
}

interface DayEntry {
  date: string;
  bars: Bar[];
  lru: number;
}

interface SeriesCache {
  days: Map<string, DayEntry>;
  /** Sorted ascending union of all cached days' bars. Rebuilt on insert. */
  flat: Bar[];
}

function seriesKey(k: SeriesKey): string {
  return `${k.symbol}|${k.interval}`;
}

function tsToDate(ts: Timestamp): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** First index whose ts >= target (binary search). */
function lowerBoundIndex(arr: Bar[], ts: Timestamp): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Minutes per interval code ("5m" → 5, "1h" → 60). Anything the pattern does
 * not match (day/week/month codes, custom vocabularies) → null, which means
 * "not an intraday code" and disables the driver machinery for that series.
 */
function intradayMinutes(code: IntervalCode): number | null {
  const m = /^(\d+)(m|h)$/.exec(code);
  return m ? Number(m[1]) * (m[2] === "h" ? 60 : 1) : null;
}

/** First bar of the newest cached day that actually holds bars, else null. */
function firstBarOfLatestDay(cache: SeriesCache): Bar | null {
  const dates = Array.from(cache.days.keys()).sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const bars = cache.days.get(dates[i])!.bars;
    if (bars.length > 0) return bars[0];
  }
  return null;
}

/**
 * Fold the driver bars of one open bucket into a single partial bar stamped at
 * the bucket start. Returns null when the bucket's own first driver bar is not
 * cached, so a holed driver series degrades to the stored coarse bar rather
 * than inventing a candle out of a partial window.
 */
function foldPartial(driver: Bar[], from: Timestamp, to: Timestamp): Bar | null {
  const start = lowerBoundIndex(driver, from);
  const first = driver[start];
  if (!first || first.ts !== from) return null;
  let high = first.high;
  let low = first.low;
  let close = first.close;
  let volume = 0;
  for (let i = start; i < driver.length && driver[i].ts <= to; i++) {
    const b = driver[i];
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    close = b.close;
    volume += b.volume ?? 0;
  }
  return { ts: from, open: first.open, high, low, close, volume };
}

export class ReplayControllerImpl implements ReplayController {
  private state: ReplayState = { status: "idle" };
  private subs = new Set<(s: ReplayState) => void>();
  private barSubs = new Set<(e: ReplayBarEvent) => void>();
  private caches = new Map<string, SeriesCache>();
  private lruCounter = 0;
  private nextSeq = 1;
  private tickHandle: number | null = null;
  /**
   * In-flight day fetches keyed `symbol|interval|date`. Holding the promise
   * (rather than a bare marker) lets a second caller JOIN the outstanding fetch
   * instead of dropping its call — callers that await, such as the tail-stall
   * retry in `scheduleTick`, must observe the bars once they land. It also caps
   * outstanding work at one request per (series, day) at any playback speed.
   */
  private prefetchInflight = new Map<string, Promise<void>>();
  private activeSeries: ReplaySeriesSpec[] = [];
  private dataVersion = 0;

  private readonly scheduler: ReplayScheduler;
  private readonly driverInterval: IntervalCode;
  private readonly useDrivers: boolean;

  constructor(private readonly options: ReplayEngineOptions = DEFAULT_OPTIONS) {
    this.scheduler = options.scheduler ?? NATIVE_SCHEDULER;
    this.driverInterval = options.driverInterval ?? DEFAULT_DRIVER_INTERVAL;
    this.useDrivers = options.minuteDrivers ?? true;
  }

  /** True for an intraday series coarser than the driver interval. */
  private needsDriver(interval: IntervalCode): boolean {
    if (!this.useDrivers) return false;
    const mins = intradayMinutes(interval);
    const driverMins = intradayMinutes(this.driverInterval);
    return mins != null && driverMins != null && mins > driverMins;
  }

  /**
   * Every coarse intraday series also materializes its symbol's driver series.
   *
   * Two jobs: the cursor advances over the union of ALL cached bars, so the
   * driver gives a 5m/15m/1h chart driver-bar cursor motion instead of jumping
   * a whole bucket per tick; and `getBarsUpToCursor` folds those driver bars
   * into the bucket that is still forming.
   */
  private withDrivers(specs: readonly ReplaySeriesSpec[]): ReplaySeriesSpec[] {
    const out = specs.map((s) => ({ symbol: s.symbol, interval: s.interval }));
    for (const s of specs) {
      if (!this.needsDriver(s.interval)) continue;
      const driver = { symbol: s.symbol, interval: this.driverInterval };
      if (!out.some((o) => seriesKey(o) === seriesKey(driver))) out.push(driver);
    }
    return out;
  }

  getState(): ReplayState {
    return this.state;
  }

  subscribe(cb: (s: ReplayState) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  onBar(cb: (e: ReplayBarEvent) => void): () => void {
    this.barSubs.add(cb);
    return () => this.barSubs.delete(cb);
  }

  async load(manifest: ReplayManifest): Promise<void> {
    this.cancelTick();
    this.caches.clear();
    this.nextSeq = 1;
    this.dataVersion = 0;
    this.activeSeries = this.withDrivers(manifest.series);

    // Progress is reported per series so a stuck load names what it is waiting
    // on. Without it "loading…" is the only thing a panel can say for as long
    // as any one fetch takes — which, when the browser has queued that fetch
    // behind a saturated connection pool, is indistinguishable from forever.
    const startedAt = Date.now();
    const total = this.activeSeries.length;
    let done = 0;
    const stage = (step: string) =>
      this.transition({
        status: "loading",
        manifest,
        progress: { startedAt, done, total, step },
      });
    stage("starting");

    try {
      const startDate = tsToDate(manifest.start);

      await Promise.all(
        this.activeSeries.map(async (spec) => {
          stage(`${spec.symbol} ${spec.interval} ${startDate}`);
          await this.fetchAndCacheDay(manifest, spec, startDate);
          const before = await manifest.source.listDatesBefore(
            spec.symbol,
            spec.interval,
            startDate,
            this.options.prefetchBackwardDays,
          );
          await Promise.all(before.map((d) => this.fetchAndCacheDay(manifest, spec, d)));
          done += 1;
          stage(`${spec.symbol} ${spec.interval} done`);
        }),
      );

      const cursorTs = this.findInitialCursor(manifest);
      if (cursorTs == null) {
        // Distinguish "every fetch came back empty" from "the days loaded but
        // hold nothing at or after the start". They used to print the same
        // sentence, and only one of them is about the date the caller picked.
        // Counted in BARS, not cached days: a day entry is written even for an
        // empty response, so a day count can never tell the two apart.
        const cachedBars = Array.from(this.caches.values()).reduce((n, c) => n + c.flat.length, 0);
        this.transition({
          status: "error",
          manifest,
          error:
            cachedBars === 0
              ? `No data returned for ${startDate} — every series fetch came back empty (check the data source, and that the date is a session day).`
              : `No bars available in the manifest range (${startDate}). The days loaded but hold no bars at or after the start.`,
        });
        return;
      }

      const cursor: ReplayCursor = { ts: cursorTs, seq: this.nextSeq++ };
      this.transition({
        status: "ready",
        manifest,
        cursor,
        speed: 1,
        playing: false,
        window: this.computeWindow(),
        activeSeries: this.activeSeries.slice(),
        dataVersion: this.dataVersion,
      });
    } catch (err) {
      this.transition({
        status: "error",
        manifest,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async ensureSeries(symbol: SymbolId, interval: IntervalCode): Promise<void> {
    if (this.state.status !== "ready") return;
    const manifest = this.state.manifest;
    const cursorDate = tsToDate(this.state.cursor.ts);

    // Requested interval + its driver (see withDrivers).
    const specs = this.withDrivers([{ symbol, interval }]);
    for (const spec of specs) {
      if (!this.activeSeries.some((s) => seriesKey(s) === seriesKey(spec))) {
        this.activeSeries.push(spec);
      }
    }

    await Promise.all(
      specs.map(async (spec) => {
        await this.fetchAndCacheDay(manifest, spec, cursorDate);
        const before = await manifest.source.listDatesBefore(
          spec.symbol,
          spec.interval,
          cursorDate,
          this.options.prefetchBackwardDays,
        );
        await Promise.all(before.map((d) => this.fetchAndCacheDay(manifest, spec, d)));
      }),
    );

    if (this.state.status !== "ready") return;
    this.dataVersion++;
    this.state = {
      ...this.state,
      activeSeries: this.activeSeries.slice(),
      window: this.computeWindow(),
      dataVersion: this.dataVersion,
    };
    this.notify();
  }

  unload(): void {
    this.cancelTick();
    this.caches.clear();
    this.activeSeries = [];
    this.dataVersion = 0;
    this.transition({ status: "idle" });
  }

  play(): void {
    if (this.state.status !== "ready" || this.state.playing) return;
    // Pressing Play while parked at the very end of the cached data (after a
    // jump-to-latest, or a manifest whose day resolved to the tail) used to
    // no-op: the first advance found no next bar and flipped `playing` straight
    // back off. Resume-from-end restarts the session instead.
    if (!this.hasBarAfter(this.state.cursor.ts)) {
      const startTs = this.findInitialCursor(this.state.manifest);
      if (startTs != null && startTs < this.state.cursor.ts) {
        this.state = {
          ...this.state,
          cursor: { ts: startTs, seq: this.nextSeq++ },
          window: this.computeWindow(),
        };
      }
    }
    this.state = { ...this.state, playing: true };
    this.notify();
    this.scheduleTick();
  }

  pause(): void {
    if (this.state.status !== "ready" || !this.state.playing) return;
    this.cancelTick();
    this.state = { ...this.state, playing: false };
    this.notify();
  }

  step(direction: 1 | -1): void {
    if (this.state.status !== "ready") return;
    if (this.state.playing) this.pause();
    this.advanceCursor(direction);
  }

  seek(ts: Timestamp): void {
    if (this.state.status !== "ready") return;
    const wasPlaying = this.state.playing;
    if (wasPlaying) this.pause();

    void this.ensureDayCached(ts).then(() => {
      if (this.state.status !== "ready") return;
      const cursor: ReplayCursor = { ts, seq: this.nextSeq++ };
      this.state = { ...this.state, cursor, window: this.computeWindow() };
      this.notify();
      if (wasPlaying) this.play();
    });
  }

  setSpeed(multiplier: number): void {
    if (this.state.status !== "ready") return;
    const speed = Math.max(0.1, Math.min(MAX_SPEED, multiplier));
    this.state = { ...this.state, speed };
    this.notify();
    if (this.state.playing) {
      this.cancelTick();
      this.scheduleTick();
    }
  }

  /**
   * Bars at or before the cursor for one series.
   *
   * The last coarse bar at/below the cursor is still FORMING. Its stored values
   * are the FINISHED bucket, so returning it verbatim prints a complete 5m
   * candle the instant its bucket opens — the cursor sits on the bucket's first
   * minute but the bar already carries its last minute's close. When a driver
   * series is cached, that bar is rebuilt from the driver bars up to the cursor
   * so it grows one driver bar at a time like a live bar, and only becomes the
   * stored bar once the cursor leaves the bucket. No driver cached → the stored
   * bar, unchanged.
   */
  getBarsUpToCursor(symbol: SymbolId, interval: IntervalCode): readonly Bar[] {
    if (this.state.status !== "ready") return [];
    const cache = this.caches.get(seriesKey({ symbol, interval }));
    if (!cache) return [];
    const cursorTs = this.state.cursor.ts;
    const idx = lowerBoundIndex(cache.flat, cursorTs);
    let endExclusive = idx;
    if (endExclusive < cache.flat.length && cache.flat[endExclusive].ts === cursorTs) endExclusive += 1;
    const bars = cache.flat.slice(0, endExclusive);

    if (!this.needsDriver(interval) || bars.length === 0) return bars;
    const driver = this.caches.get(seriesKey({ symbol, interval: this.driverInterval }))?.flat;
    if (!driver || driver.length === 0) return bars;
    const forming = foldPartial(driver, bars[bars.length - 1].ts, cursorTs);
    if (!forming) return bars;
    bars[bars.length - 1] = forming;
    return bars;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async fetchAndCacheDay(
    manifest: ReplayManifest,
    spec: SeriesKey,
    date: string,
  ): Promise<void> {
    const key = seriesKey(spec);
    const inflightKey = `${key}|${date}`;
    // Join an in-flight fetch instead of dropping the call — a caller that
    // awaits must observe the bars once they land.
    const inflight = this.prefetchInflight.get(inflightKey);
    if (inflight) return inflight;
    const cache = this.caches.get(key);
    if (cache?.days.has(date)) {
      cache.days.get(date)!.lru = ++this.lruCounter;
      return;
    }
    const run = (async () => {
      try {
        const bars = await manifest.source.fetchDay(spec.symbol, spec.interval, date);
        let c = this.caches.get(key);
        if (!c) {
          c = { days: new Map(), flat: [] };
          this.caches.set(key, c);
        }
        c.days.set(date, {
          date,
          bars: bars.slice().sort((a, b) => a.ts - b.ts),
          lru: ++this.lruCounter,
        });
        this.evictLRU(c);
        this.rebuildFlat(c);
      } finally {
        this.prefetchInflight.delete(inflightKey);
      }
    })();
    this.prefetchInflight.set(inflightKey, run);
    return run;
  }

  private evictLRU(cache: SeriesCache): void {
    const max = this.options.cacheDays;
    if (cache.days.size <= max) return;
    const entries = Array.from(cache.days.values()).sort((a, b) => a.lru - b.lru);
    const removeCount = cache.days.size - max;
    for (let i = 0; i < removeCount; i++) cache.days.delete(entries[i].date);
  }

  private rebuildFlat(cache: SeriesCache): void {
    const all: Bar[] = [];
    const dates = Array.from(cache.days.keys()).sort();
    for (const d of dates) all.push(...cache.days.get(d)!.bars);
    cache.flat = all;
  }

  /** True when any cached series has a bar strictly after `ts`. */
  private hasBarAfter(ts: Timestamp): boolean {
    for (const cache of this.caches.values()) {
      if (lowerBoundIndex(cache.flat, ts + 1) < cache.flat.length) return true;
    }
    return false;
  }

  private findInitialCursor(manifest: ReplayManifest): Timestamp | null {
    let best: Timestamp | null = null;
    for (const spec of this.activeSeries) {
      const cache = this.caches.get(seriesKey(spec));
      if (!cache) continue;
      const idx = lowerBoundIndex(cache.flat, manifest.start);
      // Manifest start beyond every cached bar (a non-session date): fall back
      // to the OPEN of the latest cached day — not the last bar, which parked
      // the cursor at the end of the data so Play had nothing to advance
      // through.
      const bar = cache.flat[idx] ?? firstBarOfLatestDay(cache);
      if (!bar) continue;
      if (best == null || bar.ts < best) best = bar.ts;
    }
    return best;
  }

  private computeWindow(): { from: Timestamp; to: Timestamp } {
    let from = Number.POSITIVE_INFINITY;
    let to = Number.NEGATIVE_INFINITY;
    for (const cache of this.caches.values()) {
      if (cache.flat.length === 0) continue;
      from = Math.min(from, cache.flat[0].ts);
      to = Math.max(to, cache.flat[cache.flat.length - 1].ts);
    }
    if (!isFinite(from) || !isFinite(to)) return { from: 0, to: 0 };
    return { from, to };
  }

  private scheduleTick(): void {
    if (this.state.status !== "ready" || !this.state.playing) return;
    const interval = Math.max(16, BASE_TICK_MS / this.state.speed);
    this.tickHandle = this.scheduler.setTimeout(() => {
      this.tickHandle = null;
      if (this.advanceCursor(1)) {
        this.scheduleTick();
        return;
      }
      // At the cached tail. At high speeds the cursor can outrun the forward
      // prefetch (which only arms in the last slice of the day) — await one
      // prefetch pass and retry before declaring the end, otherwise playback
      // silently halts at every day boundary.
      void this.maybePrefetchForward().then(() => {
        if (this.state.status !== "ready" || !this.state.playing) return;
        if (this.advanceCursor(1)) this.scheduleTick();
        else {
          this.state = { ...this.state, playing: false };
          this.notify();
        }
      });
    }, interval);
  }

  private cancelTick(): void {
    if (this.tickHandle != null) {
      this.scheduler.clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** Returns true if the cursor moved. */
  private advanceCursor(direction: 1 | -1): boolean {
    if (this.state.status !== "ready") return false;
    const cursorTs = this.state.cursor.ts;

    let nextTs: Timestamp | null = null;
    for (const cache of this.caches.values()) {
      const flat = cache.flat;
      if (flat.length === 0) continue;
      if (direction === 1) {
        const idx = lowerBoundIndex(flat, cursorTs + 1);
        if (idx < flat.length) {
          const t = flat[idx].ts;
          if (nextTs == null || t < nextTs) nextTs = t;
        }
      } else {
        const idx = lowerBoundIndex(flat, cursorTs);
        const prev = flat[idx - 1];
        if (prev && (nextTs == null || prev.ts > nextTs)) nextTs = prev.ts;
      }
    }

    if (nextTs == null) {
      if (direction === 1) void this.maybePrefetchForward();
      return false;
    }

    const cursor: ReplayCursor = { ts: nextTs, seq: this.nextSeq++ };
    this.state = { ...this.state, cursor, window: this.computeWindow() };
    this.notify();
    this.emitBarsAt(nextTs);
    if (direction === 1) void this.maybePrefetchForward();
    return true;
  }

  private emitBarsAt(ts: Timestamp): void {
    if (this.state.status !== "ready") return;
    const seq = this.state.cursor.seq;
    for (const spec of this.activeSeries) {
      const cache = this.caches.get(seriesKey(spec));
      if (!cache) continue;
      const idx = lowerBoundIndex(cache.flat, ts);
      const bar = cache.flat[idx];
      if (bar && bar.ts === ts) {
        const event: ReplayBarEvent = { ts, seq, symbol: spec.symbol, interval: spec.interval, bar };
        for (const cb of this.barSubs) {
          try {
            cb(event);
          } catch {
            /* */
          }
        }
      }
    }
  }

  private async maybePrefetchForward(): Promise<void> {
    if (this.state.status !== "ready") return;
    const cursorTs = this.state.cursor.ts;
    const cursorDate = tsToDate(cursorTs);
    const tailPct = this.options.prefetchForwardOnTailPct;
    const manifest = this.state.manifest;

    for (const spec of this.activeSeries) {
      const cache = this.caches.get(seriesKey(spec));
      if (!cache) continue;
      const day = cache.days.get(cursorDate);
      if (!day || day.bars.length === 0) continue;
      const dayStart = day.bars[0].ts;
      const dayEnd = day.bars[day.bars.length - 1].ts;
      const span = dayEnd - dayStart;
      if (span <= 0) continue;
      const into = (cursorTs - dayStart) / span;
      if (into < 1 - tailPct) continue;
      const after = await manifest.source.listDatesAfter(spec.symbol, spec.interval, cursorDate, 1);
      const nextDate = after[0];
      if (!nextDate || cache.days.has(nextDate)) continue;
      // Awaited so the tail-stall retry in scheduleTick sees the bars once this
      // resolves.
      await this.fetchAndCacheDay(manifest, spec, nextDate);
    }
  }

  private async ensureDayCached(ts: Timestamp): Promise<void> {
    if (this.state.status !== "ready") return;
    const date = tsToDate(ts);
    const manifest = this.state.manifest;
    await Promise.all(
      this.activeSeries.map(async (spec) => {
        const cache = this.caches.get(seriesKey(spec));
        if (cache?.days.has(date)) return;
        await this.fetchAndCacheDay(manifest, spec, date);
      }),
    );
    if (this.state.status === "ready") {
      this.dataVersion++;
      this.state = { ...this.state, dataVersion: this.dataVersion };
    }
  }

  private transition(next: ReplayState): void {
    this.state = next;
    this.notify();
  }

  private notify(): void {
    for (const cb of this.subs) {
      try {
        cb(this.state);
      } catch {
        /* */
      }
    }
  }
}

/** Convenience factory. */
export function createReplayController(options?: ReplayEngineOptions): ReplayController {
  return new ReplayControllerImpl(options);
}
