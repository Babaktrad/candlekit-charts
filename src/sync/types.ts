/**
 * Multi-chart sync contracts. A group mirrors one or more of: visible time
 * range, crosshair, interval, replay cursor, symbol, and date. Receivers apply
 * the visible *logical* bar range directly (lossless: identical bar spacing, no
 * anchor-recompute drift). `timeRange` is kept as the kind name for stability,
 * but its `from`/`to` are LWC logical-bar floats, not timestamps.
 */

import type { ChartId, IntervalCode, SymbolId, Timestamp } from "../core/types";

export type ChartGroupId = string;

export type SyncFlag =
  | "timeRange"
  | "crosshair"
  | "interval"
  | "cursor"
  | "symbol"
  | "date"
  | "pointMarker"; // mirror a "catch point" marker + center-on-timestamp

export interface ChartGroup {
  id: ChartGroupId;
  name: string;
  color?: string;
  flags: Set<SyncFlag>;
}

export type SyncEvent =
  | { kind: "timeRange"; from: number; to: number; sourcePanelId: ChartId }
  | { kind: "crosshair"; ts: Timestamp | null; y?: number | null; sourcePanelId: ChartId }
  | { kind: "interval"; interval: IntervalCode; sourcePanelId: ChartId }
  | { kind: "cursor"; ts: Timestamp; jump?: boolean; sourcePanelId: ChartId | null }
  | { kind: "symbol"; symbol: SymbolId; sourcePanelId: ChartId }
  | { kind: "date"; date: string | null; sourcePanelId: ChartId }
  | {
      /**
       * A "catch point" marker. Receivers drop a marker at `ts` (epoch ms) and
       * shift their viewport so the point lands at the same fractional screen-x
       * as on the source (`frac`), preserving their own bar spacing. `null`
       * clears the marker across the group.
       */
      kind: "pointMarker";
      ts: Timestamp | null;
      /**
       * Fractional x position (0 = left edge of the plot, 1 = right edge) where
       * the point sits on the SOURCE chart. Receivers place it at the same
       * fraction so every chart shows the instant at the same screen position.
       * Absent → receivers centre it (0.5).
       */
      frac?: number;
      sourcePanelId: ChartId | null;
    };

/** A chart's adapter to the time scale / crosshair, consumed by sync receivers. */
export interface ChartViewport {
  getVisibleLogicalRange(): { from: number; to: number } | null;
  setVisibleLogicalRange(r: { from: number; to: number }): void;
  setCrosshairAtTime(ts: Timestamp | null, y?: number | null): void;
}

export interface SyncMember {
  panelId: ChartId;
  viewport: ChartViewport;
  getSession(): { symbol: SymbolId; interval: IntervalCode };
  apply(event: SyncEvent): void;
}

export interface SyncEngine {
  createGroup(spec: Omit<ChartGroup, "id"> & { id?: ChartGroupId }): ChartGroupId;
  deleteGroup(id: ChartGroupId): void;
  setFlags(id: ChartGroupId, flags: Set<SyncFlag>): void;
  listGroups(): readonly ChartGroup[];
  getGroup(id: ChartGroupId): ChartGroup | undefined;
  attach(groupId: ChartGroupId, member: SyncMember): () => void;
  broadcast(groupId: ChartGroupId, event: SyncEvent): void;
  subscribeMembership(cb: (groupId: ChartGroupId, panelIds: readonly ChartId[]) => void): () => void;
}
