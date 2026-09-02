/**
 * FlexLayoutAdapter — wraps flexlayout-react behind the workspace abstraction.
 *
 * This component:
 *   - mounts a FlexLayout `<Layout>`
 *   - registers itself as the "driver" on the WorkspaceManager
 *   - maps TabNode → registered panel components
 *   - forwards tree changes back to the manager
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Actions,
  DockLocation,
  Layout,
  type IJsonModel,
  type ILayoutApi,
  type Model,
  type Node as FlexNode,
  type TabNode,
} from "flexlayout-react";
import type { PanelDefinition, PanelInstance, WorkspaceManager } from "../../../workspace";
import { createModelFromJson, modelToJson } from "./ModelFactory";
import { WorkspaceProvider } from "../WorkspaceProvider";
import { PanelWindowProvider } from "../PanelWindowContext";
import {
  splitSubLayouts,
  withSubLayouts,
  withWorkspaceGlobals,
  TAB_MULTI_WINDOW_ATTRS,
  type SubLayouts,
} from "../detachLayout";
import { useWorkspace } from "../hooks/useWorkspace";

/** Blank same-origin document FlexLayout opens for each detached panel. */
const DEFAULT_DETACH_URL = "popout.html";

/**
 * Imperative handle for detaching panels into their own OS windows.
 *
 * Every entry that ends in `window.open` MUST be called from a user gesture —
 * popup blockers reject anything else, and a blocked open silently costs the
 * user their arrangement.
 */
export interface DetachApi {
  /** Detach a panel into its own OS window. False when it is not in the tree. */
  detachPanel(panelId: string): boolean;
  /** Dock every detached window back into the main layout. */
  reattachAll(): void;
  /**
   * Detached windows present in the saved layout but not yet reopened. Non-zero
   * means the UI should offer a restore button.
   */
  pendingDetachedCount(): number;
  /** Reopen the saved detached windows. No-op when nothing is pending. */
  restoreDetached(): void;
}

export interface FlexLayoutAdapterProps {
  workspace: WorkspaceManager;
  className?: string;
  /** Optional toolbar content rendered above the layout. */
  toolbar?: ReactNode;
  /** Hide the built-in toolbar. */
  hideToolbar?: boolean;
  /** Called when the adapter has mounted and registered its driver. */
  onReady?: () => void;
  /**
   * Allow panels to be detached into separate OS windows (multi-monitor).
   * Defaults to whether the host can open a window at all.
   */
  supportsDetach?: boolean;
  /**
   * URL FlexLayout opens for each detached window: a blank same-origin page
   * that loads your stylesheet. The panel is portalled into it. Default
   * `"popout.html"`.
   */
  detachUrl?: string;
  /** Receives the detach handle once the adapter has mounted. */
  onDetachApi?: (api: DetachApi) => void;
}

export function FlexLayoutAdapter({
  workspace,
  className,
  toolbar,
  hideToolbar,
  onReady,
  supportsDetach,
  detachUrl,
  onDetachApi,
}: FlexLayoutAdapterProps) {
  return (
    <WorkspaceProvider workspace={workspace}>
      <FlexLayoutAdapterInner
        className={className}
        toolbar={toolbar}
        hideToolbar={hideToolbar}
        onReady={onReady}
        supportsDetach={supportsDetach}
        detachUrl={detachUrl}
        onDetachApi={onDetachApi}
      />
    </WorkspaceProvider>
  );
}

// ── Inner component ──────────────────────────────────────────────────────────

function FlexLayoutAdapterInner({
  className,
  toolbar,
  hideToolbar,
  onReady,
  supportsDetach,
  detachUrl = DEFAULT_DETACH_URL,
  onDetachApi,
}: {
  className?: string;
  toolbar?: ReactNode;
  hideToolbar?: boolean;
  onReady?: () => void;
  supportsDetach?: boolean;
  detachUrl?: string;
  onDetachApi?: (api: DetachApi) => void;
}) {
  const workspace = useWorkspace();
  const [model, setModel] = useState<Model | null>(null);
  const layoutRef = useRef<ILayoutApi | null>(null);
  const modelRef = useRef<Model | null>(null);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => { modelRef.current = model; }, [model]);

  const factory = useMemo(() => makePanelFactory(workspace), [workspace]);

  // Detached windows parked out of the live model until a gesture reopens them
  // (see splitSubLayouts — rehydrating them calls window.open synchronously).
  const pendingDetached = useRef<SubLayouts>({});

  /**
   * @param openDetached true only on a gesture-initiated restore — hydrating
   *   with sub-layouts present makes FlexLayout call `window.open` immediately.
   */
  const hydrate = useCallback((json: IJsonModel, openDetached = false) => {
    const withGlobals = withWorkspaceGlobals(json);
    const { stripped, detached } = openDetached
      ? { stripped: withGlobals, detached: {} as SubLayouts }
      : splitSubLayouts(withGlobals);
    pendingDetached.current = detached;
    try {
      setModel(createModelFromJson(stripped));
    } catch (e) {
      console.warn("FlexLayoutAdapter: failed to hydrate layout", e);
      // Fallback to empty model so the UI doesn't crash.
      setModel(createModelFromJson({ global: {}, layout: { type: "row", children: [] } }));
    }
  }, []);

  /**
   * The live tree plus any detached windows we deferred. EVERYTHING that
   * serializes the workspace goes through this, or a user who has not clicked
   * "restore" yet has their detached arrangement overwritten on the next save.
   */
  const treeWithPending = useCallback(
    (m: Model) => withSubLayouts(modelToJson(m) as IJsonModel, pendingDetached.current),
    [],
  );

  // Register driver + initial hydrate.
  useEffect(() => {
    let cancelled = false;

    const unregister = (workspace as unknown as { _registerDriver: (d: unknown) => () => void })._registerDriver({
      getTree: () => (modelRef.current ? treeWithPending(modelRef.current) : {}),
      setTree: (tree: unknown) => {
        if (!cancelled) hydrate(tree as IJsonModel);
      },
      addPanel: (kind: string, config?: Record<string, unknown>, title?: string) => {
        return addPanelToModel(workspace, modelRef.current, kind, config, title);
      },
      removePanel: (id: string) => {
        if (!modelRef.current) return;
        modelRef.current.doAction(Actions.deleteTab(id));
      },
    });

    // Hydrate from manager's current tree.
    const tree = (workspace as unknown as { current: { tree: unknown } }).current?.tree;
    if (tree) hydrate(tree as IJsonModel);

    onReady?.();

    return () => {
      cancelled = true;
      unregister();
    };
  }, [workspace, hydrate, treeWithPending, onReady]);

  // Detach handle. Published once; the closures read live refs.
  useEffect(() => {
    if (!onDetachApi) return;
    onDetachApi({
      detachPanel: (panelId) => {
        const m = modelRef.current;
        if (!m || !m.getNodeById(panelId)) return false;
        // "window" = a real OS window (movable to another monitor), as opposed
        // to "float" (a simulated div that cannot leave this window).
        m.doAction(Actions.popoutTab(panelId, "window"));
        return true;
      },
      reattachAll: () => {
        const m = modelRef.current;
        if (!m) return;
        const json = modelToJson(m) as IJsonModel;
        for (const id of Object.keys(json.subLayouts ?? {})) m.doAction(Actions.closePopout(id));
        // Also drop anything still parked — the user asked for everything docked.
        pendingDetached.current = {};
      },
      pendingDetachedCount: () => Object.keys(pendingDetached.current).length,
      restoreDetached: () => {
        const m = modelRef.current;
        const pending = pendingDetached.current;
        if (!m || Object.keys(pending).length === 0) return;
        hydrate({ ...(modelToJson(m) as IJsonModel), subLayouts: pending }, /* openDetached */ true);
      },
    });
  }, [onDetachApi, hydrate]);

  // Debounced autosave.
  const onModelChange = useMemo(() => (m: Model) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const panels = extractPanelsFromModel(m);
      (workspace as unknown as { _onTreeChanged: (tree: unknown, panels: unknown) => void })._onTreeChanged(
        treeWithPending(m),
        panels,
      );
    }, 400);
  }, [workspace, treeWithPending]);

  const canDetach =
    supportsDetach ??
    (typeof window !== "undefined" && typeof window.open === "function");

  if (!model) {
    return <div className={className} style={{ height: "100%" }} />;
  }

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {!hideToolbar && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            borderBottom: "1px solid var(--app-border)",
            background: "var(--app-panel)",
            fontSize: 12,
          }}
        >
          <AddPanelButton workspace={workspace} modelRef={modelRef} />
          <button
            type="button"
            onClick={() => workspace.resetLayout()}
            style={btnStyle}
          >
            Reset Layout
          </button>
          {toolbar && (
            <>
              <div style={{ width: 1, alignSelf: "stretch", background: "var(--app-border)", margin: "0 2px" }} />
              {toolbar}
            </>
          )}
          <span style={{ marginLeft: "auto", color: "var(--app-muted)" }}>
            Drag tabs · resize splitters · double-click header to maximize
          </span>
        </div>
      )}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <Layout
          ref={layoutRef}
          model={model}
          factory={factory}
          onModelChange={onModelChange}
          realtimeResize
          // ── Detach into a separate OS window (multi-monitor) ───────────────
          // Left undefined, FlexLayout guesses from the user agent; gate on the
          // capability itself instead.
          supportsPopout={canDetach}
          popoutURL={detachUrl}
        />
      </div>
    </div>
  );
}

// ── Panel factory ────────────────────────────────────────────────────────────

function makePanelFactory(workspace: WorkspaceManager) {
  return (node: TabNode) => <PanelHostMount node={node} workspace={workspace} />;
}

function PanelHostMount({ node, workspace }: { node: TabNode; workspace: WorkspaceManager }) {
  const panelId = node.getId();
  // The window this tab actually renders into: the main one while docked, the
  // popped-out one once detached. Re-read on every render because a detach
  // remounts the tab (see TAB_MULTI_WINDOW_ATTRS).
  const [panelWindow, setPanelWindow] = useState<Window | null>(null);
  const kind = node.getComponent() ?? "unknown";
  const def = workspace.registry.get(kind);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const raw = node.getConfig() as PanelInstance | undefined;
  const instance: PanelInstance =
    raw && raw.kind === kind
      ? raw
      : {
          id: panelId,
          kind,
          title: node.getName() ?? kind,
          config: def?.defaultConfig() ?? {},
        };

  const updateConfig = useCallback(
    (next: Partial<Record<string, unknown>>) => {
      const current = (node.getConfig() as PanelInstance | undefined) ?? {
        id: panelId,
        kind,
        title: node.getName() ?? kind,
        config: def?.defaultConfig() ?? {},
      };
      const merged: PanelInstance = {
        ...current,
        config: { ...(current.config as object), ...(next as object) },
      };
      const model = node.getModel();
      model.doAction(Actions.updateNodeAttributes(panelId, { config: merged } as never));
      bump();
    },
    [node, panelId, kind, def],
  );

  const Component = def?.component as
    | React.ComponentType<{
        instance: PanelInstance;
        updateConfig: (next: Partial<Record<string, unknown>>) => void;
      }>
    | undefined;

  return (
    // A host element the subtree can resolve its own window from — after a
    // detach the panel lives in another document, and everything that reads a
    // viewport global (portal containers, listeners, devicePixelRatio) must use
    // THAT window, not the module-scope one.
    <div
      ref={(el) => {
        const win = (el?.ownerDocument?.defaultView as Window | null) ?? null;
        setPanelWindow((prev) => (prev === win ? prev : win));
      }}
      style={{ position: "relative", width: "100%", height: "100%", minHeight: 0 }}
    >
      <PanelWindowProvider window={panelWindow ?? (globalThis as unknown as { window: Window }).window}>
        {Component ? (
          <Component instance={instance} updateConfig={updateConfig} />
        ) : (
          <div style={{ padding: 16, fontSize: 12, color: "var(--app-muted)" }}>
            Unknown panel kind: <code>{kind}</code>
          </div>
        )}
      </PanelWindowProvider>
    </div>
  );
}

// ── Add panel button ─────────────────────────────────────────────────────────

function AddPanelButton({
  workspace,
  modelRef,
}: {
  workspace: WorkspaceManager;
  modelRef: React.MutableRefObject<Model | null>;
}) {
  const [open, setOpen] = useState(false);
  // `hidden` defs (legacy kind aliases) stay resolvable by the factory but must
  // not show up as duplicate entries in the picker.
  const defs = workspace.registry.list().filter((d) => !d.hidden);

  const handleAdd = useCallback(
    (def: PanelDefinition) => {
      addPanelToModel(workspace, modelRef.current, def.kind);
      setOpen(false);
    },
    [workspace, modelRef],
  );

  return (
    <div style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen(!open)} style={btnStyle}>
        + Add Panel
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 4,
            background: "var(--app-panel)",
            color: "var(--app-fg)",
            border: "1px solid var(--app-border)",
            borderRadius: 6,
            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
            minWidth: 180,
            zIndex: 1000,
            overflow: "hidden",
          }}
          onMouseLeave={() => setOpen(false)}
        >
          {defs.length === 0 && (
            <div style={{ padding: "8px 12px", color: "var(--app-muted)" }}>
              No panels registered
            </div>
          )}
          {defs.map((d) => (
            <button
              key={d.kind}
              type="button"
              onClick={() => handleAdd(d)}
              style={menuItemStyle}
            >
              {d.displayName ?? d.kind}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function addPanelToModel(
  workspace: WorkspaceManager,
  model: Model | null,
  kind: string,
  configOverride?: Record<string, unknown>,
  titleOverride?: string,
): string | null {
  if (!model) return null;
  const def = workspace.registry.get(kind);
  if (!def) {
    console.warn(`Workspace: no panel registered for kind "${kind}"`);
    return null;
  }
  const id = `panel-${kind}-${Date.now().toString(36)}`;
  const baseConfig = def.defaultConfig();
  const config = configOverride ? { ...baseConfig, ...configOverride } : baseConfig;
  const title = titleOverride ?? def.displayName ?? kind;
  const instance: PanelInstance = { id, kind, title, config };

  let targetId = model.getActiveTabset()?.getId();
  if (!targetId) {
    let found: string | null = null;
    model.visitNodes((node: FlexNode) => {
      if (!found && node.getType() === "tabset") found = node.getId();
    });
    targetId = found ?? undefined;
  }
  if (!targetId) return null;

  model.doAction(
    Actions.addNode(
      {
        id,
        type: "tab",
        name: title,
        component: kind,
        config: instance,
        // Tabs added after hydrate miss the stamping pass, so carry the detach
        // attributes here too (see TAB_MULTI_WINDOW_ATTRS).
        ...TAB_MULTI_WINDOW_ATTRS,
      },
      targetId,
      DockLocation.CENTER,
      -1,
      true,
    ),
  );
  return id;
}

function extractPanelsFromModel(model: Model): Record<string, PanelInstance> {
  const panels: Record<string, PanelInstance> = {};
  model.visitNodes((node: FlexNode) => {
    if (node.getType() === "tab") {
      const tab = node as TabNode;
      const cfg = tab.getConfig() as PanelInstance | undefined;
      if (cfg && cfg.id) {
        panels[cfg.id] = cfg;
      }
    }
  });
  return panels;
}

// ── Styles ───────────────────────────────────────────────────────────────────

const btnStyle: React.CSSProperties = {
  background: "var(--app-bg)",
  color: "var(--app-fg)",
  border: "1px solid var(--app-border)",
  borderRadius: 4,
  padding: "3px 10px",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: "ui-monospace, monospace",
};

const menuItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "transparent",
  color: "inherit",
  border: "none",
  padding: "8px 12px",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: "ui-monospace, monospace",
};
