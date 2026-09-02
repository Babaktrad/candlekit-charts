/**
 * Replay engine contracts. Deterministic playback over historical bars: the
 * cursor timestamp is the single source of truth — wall-clock time is never
 * consulted by replay calculations (only by the tick scheduler to pace UI).
 */

import type { Bar, IntervalCode, SymbolId, Timestamp } from "../core/types";
import type { ReplayDataSource } from "../data-source/types";

export interface ReplaySeriesSpec {
  symbol: SymbolId;
  interval: IntervalCode;
}

export interface ReplayManifest {
  id: string;
  series: readonly ReplaySeriesSpec[];
  start: Timestamp;
  end: Timestamp;
  source: ReplayDataSource;
}

/**
 * Pluggable one-shot timer for the tick loop.
 *
 * The default is the host's `setTimeout`, which browsers clamp to >= 1s in a
 * hidden document (and ~1/min under intensive throttling). That is wrong when
 * the owning window is minimized or occluded while the chart itself is visible
 * elsewhere — a panel detached onto another monitor, an embedded view — because
 * playback would crawl even though the user is watching it. Inject a
 * worker-backed scheduler (a worker has no visibility state, so it keeps its
 * cadence) to fix that. Kept as dependency injection so this module stays free
 * of DOM/worker concerns and remains testable with a fake clock.
 */
export interface ReplayScheduler {
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface ReplayEngineOptions {
  /** Max days kept in memory per (symbol, interval). LRU evicted. */
  cacheDays: number;
  /** Days prefetched backward when the session starts. */
  prefetchBackwardDays: number;
  /** When the cursor enters the last N% of the current day, prefetch the next. */
  prefetchForwardOnTailPct: number;
  /** Tick-loop timer. Defaults to the host's `setTimeout`/`clearTimeout`. */
  scheduler?: ReplayScheduler;
  /**
   * Also materialize a driver series at {@link driverInterval} alongside every
   * coarser intraday series, so the cursor advances one driver bar at a time
   * and the newest coarse bar *grows* instead of printing complete. Default
   * `true`. Set `false` when the source has no finer resolution to offer.
   */
  minuteDrivers?: boolean;
  /** Interval code of the driver series. Default `"1m"`. */
  driverInterval?: IntervalCode;
}

export interface ReplayCursor {
  ts: Timestamp;
  /** Monotonic sequence within the session; increments every tick. */
  seq: number;
}

export type ReplayState =
  | { status: "idle" }
  /**
   * Materializing. `progress` is ADDITIVE and optional — a controller that does
   * not report it leaves the field undefined and the UI falls back to the plain
   * spinner it always showed.
   *
   * It exists because "loading…" with nothing behind it is the one state this
   * engine can sit in with no way to tell a slow read from a stuck one.
   * `startedAt` (epoch ms) lets a panel age the wait, `step` names the fetch in
   * flight, `done`/`total` counts series.
   */
  | {
      status: "loading";
      manifest: ReplayManifest;
      progress?: { startedAt: number; done: number; total: number; step: string };
    }
  | {
      status: "ready";
      manifest: ReplayManifest;
      cursor: ReplayCursor;
      speed: number;
      playing: boolean;
      window: { from: Timestamp; to: Timestamp };
      activeSeries: readonly ReplaySeriesSpec[];
      dataVersion: number;
    }
  | { status: "error"; manifest: ReplayManifest; error: string };

export interface ReplayBarEvent {
  ts: Timestamp;
  seq: number;
  symbol: SymbolId;
  interval: IntervalCode;
  bar: Bar;
}

export interface ReplayController {
  getState(): ReplayState;
  subscribe(cb: (s: ReplayState) => void): () => void;
  onBar(cb: (e: ReplayBarEvent) => void): () => void;

  load(manifest: ReplayManifest): Promise<void>;
  unload(): void;

  play(): void;
  pause(): void;
  step(direction: 1 | -1): void;
  seek(ts: Timestamp): void;
  setSpeed(multiplier: number): void;

  /** Bars up to and including the cursor for one series. */
  getBarsUpToCursor(symbol: SymbolId, interval: IntervalCode): readonly Bar[];
  /** Materialize a (symbol, interval) mid-session. Idempotent. */
  ensureSeries(symbol: SymbolId, interval: IntervalCode): Promise<void>;
}
