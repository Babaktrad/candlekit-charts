import { describe, it, expect } from "vitest";
import { interpolateCoordinate } from "../src/measurement/CrosshairMarkerPrimitive";

/**
 * A fake time scale: every known time maps to a pixel, everything else is null
 * — exactly the lightweight-charts behaviour that forces the interpolation
 * this function exists for.
 */
function scaleOf(map: Record<number, number>, barSpacing = 10) {
  return {
    timeToCoordinate: (t: unknown) => (map[t as number] ?? null) as number | null,
    options: () => ({ barSpacing }),
  };
}

const MIN = 60;

describe("interpolateCoordinate", () => {
  it("returns null with no bars", () => {
    expect(interpolateCoordinate(scaleOf({}), [], 100)).toBeNull();
  });

  it("maps a time between two bars proportionally", () => {
    const times = [0, 1 * MIN, 2 * MIN];
    const scale = scaleOf({ 0: 0, [1 * MIN]: 10, [2 * MIN]: 20 });
    // Exactly halfway between bar 0 and bar 1 => halfway between 0px and 10px.
    expect(interpolateCoordinate(scale, times, 30)).toBeCloseTo(5, 6);
    // Three quarters of the way across the second gap.
    expect(interpolateCoordinate(scale, times, 1 * MIN + 45)).toBeCloseTo(17.5, 6);
  });

  it("lands exactly on a bar's own coordinate", () => {
    const times = [0, 1 * MIN, 2 * MIN];
    const scale = scaleOf({ 0: 0, [1 * MIN]: 10, [2 * MIN]: 20 });
    expect(interpolateCoordinate(scale, times, 1 * MIN)).toBeCloseTo(10, 6);
  });

  it("extrapolates left of the first bar at one bar-spacing per slot", () => {
    const times = [10 * MIN, 11 * MIN, 12 * MIN];
    const scale = scaleOf({ [10 * MIN]: 100, [11 * MIN]: 110, [12 * MIN]: 120 });
    // Two whole slots before the first bar: 100 - 2*10.
    expect(interpolateCoordinate(scale, times, 8 * MIN)).toBeCloseTo(80, 6);
  });

  it("extrapolates right of the last bar at one bar-spacing per slot", () => {
    const times = [10 * MIN, 11 * MIN, 12 * MIN];
    const scale = scaleOf({ [10 * MIN]: 100, [11 * MIN]: 110, [12 * MIN]: 120 });
    expect(interpolateCoordinate(scale, times, 15 * MIN)).toBeCloseTo(150, 6);
  });

  it("uses the MEDIAN bar interval, so a session gap does not smear extrapolation", () => {
    // Four 1-minute bars, then an overnight-sized jump, then two more.
    // A mean interval would be dragged far above 60s by that one gap and every
    // extrapolated slot past the edge would land in the wrong place.
    const times = [0, 1 * MIN, 2 * MIN, 3 * MIN, 1000 * MIN, 1001 * MIN, 1002 * MIN];
    const scale = scaleOf({
      0: 0,
      [1 * MIN]: 10,
      [2 * MIN]: 20,
      [3 * MIN]: 30,
      [1000 * MIN]: 40,
      [1001 * MIN]: 50,
      [1002 * MIN]: 60,
    });
    // One median slot (60s) past the last bar => exactly one barSpacing (10px).
    expect(interpolateCoordinate(scale, times, 1003 * MIN)).toBeCloseTo(70, 6);
    // A mean interval (~143 min here) would have produced a far smaller step.
    expect(interpolateCoordinate(scale, times, 1003 * MIN)).toBeGreaterThan(69);
  });

  it("interpolates ACROSS a gap between the bracketing bars, not through it", () => {
    // The point of gap-awareness: a time inside the overnight hole is placed
    // between the two bars that actually bracket it on screen, which are
    // adjacent slots, not hundreds of missing minutes apart.
    const times = [0, 1 * MIN, 1000 * MIN, 1001 * MIN];
    const scale = scaleOf({ 0: 0, [1 * MIN]: 10, [1000 * MIN]: 20, [1001 * MIN]: 30 });
    const x = interpolateCoordinate(scale, times, 500 * MIN)!;
    expect(x).toBeGreaterThan(10);
    expect(x).toBeLessThan(20);
  });

  it("returns null when the scale cannot place a bracketing bar (bar scrolled off)", () => {
    const times = [0, 1 * MIN, 2 * MIN];
    // Bar 1 is off-screen: LWC hands back null for it.
    const scale = scaleOf({ 0: 0, [2 * MIN]: 20 });
    expect(interpolateCoordinate(scale, times, 30)).toBeNull();
  });

  it("falls back to a default bar spacing when the scale reports none", () => {
    const times = [0, 1 * MIN];
    const scale = {
      timeToCoordinate: (t: unknown) => ((t as number) === 0 ? 0 : 6),
      options: () => ({}),
    };
    // Still produces a finite coordinate rather than NaN/null.
    const x = interpolateCoordinate(scale, times, 2 * MIN);
    expect(x).not.toBeNull();
    expect(Number.isFinite(x!)).toBe(true);
  });

  it("handles a single bar", () => {
    const scale = scaleOf({ [5 * MIN]: 50 });
    expect(interpolateCoordinate(scale, [5 * MIN], 5 * MIN)).toBeCloseTo(50, 6);
    // No deltas to take a median from => the fallback step keeps it finite.
    const x = interpolateCoordinate(scale, [5 * MIN], 6 * MIN);
    expect(Number.isFinite(x!)).toBe(true);
  });
});
