/**
 * liveBucketMs — a live tick must extend the bar its interval actually owns.
 *
 * The session-open anchor is a parameter, not a constant: these cases use a
 * 09:15 open (555 minutes past midnight) purely to prove the anchor is honoured
 * and is NOT the wall-clock quarter-hour.
 */
import { describe, expect, it } from "vitest";
import { liveBucketMs } from "../src/core/data";

const OPEN_0915 = { sessionOpenMinutes: 9 * 60 + 15 };

const t = (h: number, m: number, s = 0) => Date.UTC(2026, 4, 22, h, m, s);

describe("liveBucketMs — live tick → interval bucket start", () => {
  it("1m floors to the minute (regardless of seconds)", () => {
    expect(liveBucketMs(t(9, 17, 42), 1, OPEN_0915)).toBe(t(9, 17, 0));
    expect(liveBucketMs(t(9, 17, 0), 1, OPEN_0915)).toBe(t(9, 17, 0));
  });

  it("5m collapses a whole 09:15–09:19 window onto the 09:15 bucket", () => {
    for (const [h, m, s] of [
      [9, 15, 0],
      [9, 16, 30],
      [9, 17, 5],
      [9, 19, 59],
    ] as const) {
      expect(liveBucketMs(t(h, m, s), 5, OPEN_0915)).toBe(t(9, 15, 0));
    }
  });

  it("5m advances to the next anchored bucket at :20 / :25 / :30", () => {
    expect(liveBucketMs(t(9, 20, 0), 5, OPEN_0915)).toBe(t(9, 20, 0));
    expect(liveBucketMs(t(9, 24, 59), 5, OPEN_0915)).toBe(t(9, 20, 0));
    expect(liveBucketMs(t(9, 25, 1), 5, OPEN_0915)).toBe(t(9, 25, 0));
    expect(liveBucketMs(t(9, 33, 10), 5, OPEN_0915)).toBe(t(9, 30, 0));
  });

  it("15m buckets follow the session anchor, not the wall-clock quarter-hour", () => {
    // 09:15..09:29 → 09:15 bucket; 09:30..09:44 → 09:30 bucket.
    expect(liveBucketMs(t(9, 29, 59), 15, OPEN_0915)).toBe(t(9, 15, 0));
    expect(liveBucketMs(t(9, 30, 0), 15, OPEN_0915)).toBe(t(9, 30, 0));
    expect(liveBucketMs(t(10, 0, 0), 15, OPEN_0915)).toBe(t(10, 0, 0));
  });

  it("defaults to a midnight anchor when no session open is given", () => {
    expect(liveBucketMs(t(9, 29, 59), 15)).toBe(t(9, 15, 0));
    expect(liveBucketMs(t(9, 33, 10), 5)).toBe(t(9, 30, 0));
  });

  it("the same tick lands on different bar starts per interval", () => {
    const tick = t(9, 23, 12);
    expect(liveBucketMs(tick, 1, OPEN_0915)).toBe(t(9, 23, 0));
    expect(liveBucketMs(tick, 5, OPEN_0915)).toBe(t(9, 20, 0));
  });
});
