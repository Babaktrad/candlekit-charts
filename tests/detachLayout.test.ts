/**
 * Layout plumbing for detached (popped-out) panels. Three invariants:
 *   - every tab carries `enableWindowReMount` (there is no global to inherit it
 *     from), so popping out remounts the panel in the popout document instead
 *     of adopting DOM built against the main window's devicePixelRatio;
 *   - existing per-tab values are never overwritten;
 *   - the sub-layout payload (the restore state) survives every transform.
 */

import { describe, expect, it } from "vitest";
import type { IJsonModel } from "flexlayout-react";
import {
  splitSubLayouts,
  stampTabAttributes,
  withSubLayouts,
  withWorkspaceGlobals,
  WORKSPACE_GLOBAL_ATTRS,
} from "../src/react/workspace/detachLayout";

function tab(id: string, extra: Record<string, unknown> = {}) {
  return { type: "tab", id, name: id, component: "chart", ...extra };
}

describe("WORKSPACE_GLOBAL_ATTRS", () => {
  it("enables the popout affordance", () => {
    expect(WORKSPACE_GLOBAL_ATTRS.tabEnablePopout).toBe(true);
    expect(WORKSPACE_GLOBAL_ATTRS.tabEnablePopoutIcon).toBe(true);
    // The in-page "float" variant cannot cross monitors — deliberately off.
    expect(WORKSPACE_GLOBAL_ATTRS.tabEnablePopoutFloatIcon).toBe(false);
  });

  it("is re-applied to a layout persisted before the flags existed", () => {
    const json = {
      global: { tabEnableClose: false },
      layout: { type: "row", children: [{ type: "tabset", children: [tab("a")] }] },
    } as unknown as IJsonModel;
    const out = withWorkspaceGlobals(json);
    expect(out.global?.tabEnablePopout).toBe(true);
    // A value already in the tree still wins.
    expect(out.global?.tabEnableClose).toBe(false);
  });
});

describe("stampTabAttributes", () => {
  it("stamps every tab in the main layout", () => {
    const json: IJsonModel = {
      layout: {
        type: "row",
        children: [
          { type: "tabset", children: [tab("a"), tab("b")] },
          { type: "row", children: [{ type: "tabset", children: [tab("c")] }] },
        ],
      },
    } as IJsonModel;

    const out = stampTabAttributes(json);
    const ids: string[] = [];
    const walk = (n: { type?: string; children?: unknown[] }) => {
      for (const child of (n.children ?? []) as {
        type?: string;
        id?: string;
        children?: unknown[];
        enableWindowReMount?: boolean;
      }[]) {
        if (child.type === "tab") {
          ids.push(child.id!);
          expect(child.enableWindowReMount).toBe(true);
        } else walk(child);
      }
    };
    walk(out.layout as never);
    expect(ids.sort()).toEqual(["a", "b", "c"]);
  });

  it("stamps tabs parked in borders and inside already-detached sub-layouts", () => {
    const json = {
      layout: { type: "row", children: [{ type: "tabset", children: [tab("main")] }] },
      borders: [{ type: "border", location: "bottom", children: [tab("bordered")] }],
      subLayouts: {
        w1: {
          type: "window",
          rect: { x: 0, y: 0, width: 800, height: 600 },
          layout: { type: "row", children: [{ type: "tabset", children: [tab("detached")] }] },
        },
      },
    } as unknown as IJsonModel;

    const out = stampTabAttributes(json);
    expect((out.borders![0].children![0] as { enableWindowReMount?: boolean }).enableWindowReMount).toBe(
      true,
    );
    const sub = out.subLayouts!.w1.layout as {
      children: { children: { enableWindowReMount?: boolean }[] }[];
    };
    expect(sub.children[0].children[0].enableWindowReMount).toBe(true);
    // Sub-layout geometry must survive untouched — it IS the restore payload.
    expect(out.subLayouts!.w1.rect).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it("does not overwrite an explicit per-tab opt-out", () => {
    const json = {
      layout: {
        type: "row",
        children: [{ type: "tabset", children: [tab("keep", { enableWindowReMount: false })] }],
      },
    } as unknown as IJsonModel;

    const out = stampTabAttributes(json) as unknown as {
      layout: { children: { children: { enableWindowReMount?: boolean }[] }[] };
    };
    expect(out.layout.children[0].children[0].enableWindowReMount).toBe(false);
  });

  it("leaves a tabless tree alone", () => {
    const json = { layout: { type: "row" } } as IJsonModel;
    expect(() => stampTabAttributes(json)).not.toThrow();
  });
});

describe("splitSubLayouts / withSubLayouts", () => {
  const sub = {
    type: "window",
    rect: { x: 10, y: 20, width: 640, height: 480 },
    layout: { type: "row", children: [] },
  };

  it("is identity for a tree with no detached windows", () => {
    const json = { layout: { type: "row", children: [] } } as unknown as IJsonModel;
    const { stripped, detached } = splitSubLayouts(json);
    expect(stripped).toBe(json);
    expect(detached).toEqual({});
  });

  it("strips detached windows so hydrate never calls window.open", () => {
    const json = { layout: { type: "row" }, subLayouts: { w1: sub } } as unknown as IJsonModel;
    const { stripped, detached } = splitSubLayouts(json);
    expect(stripped.subLayouts).toBeUndefined();
    expect(detached.w1).toEqual(sub);
    // The original is untouched (the caller may still be persisting it).
    expect(json.subLayouts).toBeDefined();
  });

  it("also reads the deprecated `popouts` alias", () => {
    const json = { layout: { type: "row" }, popouts: { old: sub } } as unknown as IJsonModel;
    const { stripped, detached } = splitSubLayouts(json);
    expect(detached.old).toEqual(sub);
    expect((stripped as { popouts?: unknown }).popouts).toBeUndefined();
  });

  it("merges parked windows back on save, with the live model winning", () => {
    const live = { type: "window", rect: { x: 1, y: 1, width: 1, height: 1 }, layout: { type: "row" } };
    const tree = { layout: { type: "row" }, subLayouts: { w1: live } } as unknown as IJsonModel;
    const merged = withSubLayouts(tree, { w1: sub, w2: sub } as never);
    expect(merged.subLayouts!.w1).toEqual(live); // reopened window wins
    expect(merged.subLayouts!.w2).toEqual(sub); // still parked, still saved
  });

  it("round-trips: split then merge restores the original set", () => {
    const json = { layout: { type: "row" }, subLayouts: { w1: sub } } as unknown as IJsonModel;
    const { stripped, detached } = splitSubLayouts(json);
    expect(withSubLayouts(stripped, detached).subLayouts).toEqual({ w1: sub });
  });
});
