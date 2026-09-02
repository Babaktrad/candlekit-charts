/**
 * Layout plumbing for detached (popped-out) panels.
 *
 * FlexLayout can move a tab into a real OS window, which is what makes a
 * multi-monitor workspace possible. Three things have to be arranged for that,
 * and each is a separate trap:
 *
 *   1. The popout affordance is a set of GLOBAL attributes. Layouts persisted
 *      before detaching existed carry a `global` block without them, and
 *      FlexLayout persists `global` verbatim, so they must be re-applied on
 *      every hydrate — not just when building a fresh default.
 *   2. `enableWindowReMount` is TAB-level only (there is no global to inherit it
 *      from), so it has to be stamped onto every tab node. It is load-bearing,
 *      not a preference: popping a tab out moves it to a different `document`,
 *      and remounting makes the panel build its canvas against the popout
 *      window, so `devicePixelRatio`, resize observers and media queries all
 *      resolve against the monitor it is actually on. Without it a chart moved
 *      to a differently-scaled display renders blurry and mis-sized.
 *   3. Detached windows serialize into the model JSON with their screen rect,
 *      so they persist for free — but REHYDRATING them means `window.open`
 *      during render, which every browser blocks outside a user gesture, and a
 *      blocked open makes FlexLayout drop the sub-layout and with it the user's
 *      arrangement. So they are split off on load, kept aside, and merged back
 *      into every save; a real click re-hydrates with them intact.
 *
 * These helpers are plain JSON transforms — no FlexLayout runtime import — so
 * they are unit-testable and usable by any host that persists the same tree.
 */

import type {
  IGlobalAttributes,
  IJsonBorderNode,
  IJsonModel,
  IJsonRowNode,
  IJsonSubLayout,
  IJsonTabNode,
  IJsonTabSetNode,
} from "flexlayout-react";

/** Map of detached-window id → its serialized sub-layout. */
export type SubLayouts = Record<string, IJsonSubLayout>;

/**
 * Global attributes every workspace model carries, including the ones that
 * enable detaching a panel into its own OS window.
 *
 * The per-tab companion is {@link TAB_MULTI_WINDOW_ATTRS}.
 */
export const WORKSPACE_GLOBAL_ATTRS: IGlobalAttributes & {
  // Read at runtime by flexlayout 0.9 but absent from its IGlobalAttributes
  // typings; `splitterExtra` is in neither (kept so trees written before this
  // note round-trip unchanged).
  splitterSize?: number;
  splitterExtra?: number;
} = {
  tabEnableClose: true,
  tabEnableRename: false,
  tabSetEnableMaximize: true,
  splitterSize: 6,
  splitterExtra: 2,
  tabSetMinWidth: 120,
  tabSetMinHeight: 80,
  // ── Detach into a separate OS window (multi-monitor) ────────────────────────
  tabEnablePopout: true,
  tabEnablePopoutIcon: true,
  // The simulated in-page "float" variant is off: it solves a different problem
  // (a floating div inside this window) and cannot cross monitors.
  tabEnablePopoutFloatIcon: false,
};

/**
 * Per-tab attributes needed for detaching. Unlike the popout flags above,
 * `enableWindowReMount` is tab-level only, so it has to be stamped onto every
 * tab node (see {@link stampTabAttributes}).
 *
 * Chart state survives the remount by design: viewport lives in the panel
 * config, drawings and indicators behind their own persistence keys.
 */
export const TAB_MULTI_WINDOW_ATTRS: Partial<IJsonTabNode> = {
  enableWindowReMount: true,
};

/**
 * Stamp {@link TAB_MULTI_WINDOW_ATTRS} onto every tab in a model, including
 * tabs parked in borders and inside already-detached sub-layouts. Existing
 * per-tab values win, so a panel kind that opts out still can.
 */
export function stampTabAttributes(json: IJsonModel): IJsonModel {
  const tab = (t: IJsonTabNode): IJsonTabNode => ({ ...TAB_MULTI_WINDOW_ATTRS, ...t });

  const node = (n: IJsonRowNode | IJsonTabSetNode): IJsonRowNode | IJsonTabSetNode => {
    if (n.type === "tabset") {
      const ts = n as IJsonTabSetNode;
      return ts.children ? { ...ts, children: ts.children.map(tab) } : ts;
    }
    const row = n as IJsonRowNode;
    return row.children
      ? { ...row, children: row.children.map(node) as IJsonRowNode["children"] }
      : row;
  };

  const border = (b: IJsonBorderNode): IJsonBorderNode =>
    b.children ? { ...b, children: b.children.map(tab) } : b;

  const out: IJsonModel = { ...json, layout: node(json.layout) as IJsonRowNode };
  if (json.borders) out.borders = json.borders.map(border);
  if (json.subLayouts) {
    out.subLayouts = Object.fromEntries(
      Object.entries(json.subLayouts).map(([id, sub]) => [
        id,
        { ...sub, layout: node(sub.layout) as IJsonRowNode },
      ]),
    );
  }
  return out;
}

/**
 * Re-apply the workspace globals to a persisted tree and stamp its tabs.
 * Values already in the tree win — this only supplies defaults a layout saved
 * before the feature existed would otherwise never pick up.
 */
export function withWorkspaceGlobals(json: IJsonModel): IJsonModel {
  return stampTabAttributes({
    ...json,
    global: { ...WORKSPACE_GLOBAL_ATTRS, ...(json.global ?? {}) },
  });
}

/**
 * Split the detached windows out of a model so it can be hydrated without a
 * synchronous `window.open`. Returns the stripped tree plus what was removed;
 * merge it back with {@link withSubLayouts} on every save.
 */
export function splitSubLayouts(json: IJsonModel): { stripped: IJsonModel; detached: SubLayouts } {
  // `popouts` is the deprecated alias FlexLayout still reads; handle both so a
  // tree written by an older version restores too.
  const detached: SubLayouts = {
    ...((json.popouts as SubLayouts | undefined) ?? {}),
    ...((json.subLayouts as SubLayouts | undefined) ?? {}),
  };
  if (Object.keys(detached).length === 0) return { stripped: json, detached: {} };
  const stripped = { ...json };
  delete stripped.subLayouts;
  delete (stripped as { popouts?: unknown }).popouts;
  return { stripped, detached };
}

/**
 * Merge parked detached windows back into a tree about to be persisted. The
 * live model's own sub-layouts win, so a window that has since been reopened is
 * not shadowed by its stale parked copy.
 *
 * Everything that serializes the workspace must go through this, or a user who
 * has not clicked "restore" yet loses their detached arrangement on the next
 * autosave.
 */
export function withSubLayouts(tree: IJsonModel, pending: SubLayouts): IJsonModel {
  if (Object.keys(pending).length === 0) return tree;
  const own = (tree.subLayouts as SubLayouts | undefined) ?? {};
  return { ...tree, subLayouts: { ...pending, ...own } };
}
