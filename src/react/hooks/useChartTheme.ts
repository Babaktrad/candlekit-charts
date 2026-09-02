/**
 * useChartTheme — the resolved {@link ChartTheme} for the document's current
 * light/dark mode, recomputed when that mode changes.
 *
 * One place decides the axis / grid / crosshair palette, so several chart hosts
 * on a page cannot drift apart (a host that hard-codes a dark-only chrome is
 * unreadable the moment the page goes light). Pass `overrides` to tint one
 * chart without forking the palette.
 *
 * Equivalent to `resolveTheme(usePageTheme())`, memoized.
 */

import { useMemo } from "react";
import type { ChartTheme } from "../../core/types";
import { resolveTheme } from "../../core/theme";
import { usePageTheme } from "./usePageTheme";

export function useChartTheme(overrides?: Partial<ChartTheme>): ChartTheme {
  const mode = usePageTheme();
  return useMemo(
    () => (overrides ? resolveTheme({ ...resolveTheme(mode), ...overrides }) : resolveTheme(mode)),
    [mode, overrides],
  );
}
