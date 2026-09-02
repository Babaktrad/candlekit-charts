/**
 * Which browser window a panel subtree renders into.
 *
 * A detached panel renders through a portal into ANOTHER document while still
 * executing in the original window's JS realm. Anything that reaches for a
 * viewport global — `document.body` (portal containers for menus, tooltips and
 * dialogs), `document.hidden`, `matchMedia`, `devicePixelRatio`, window-level
 * listeners — must use the panel's OWN window, not the module-scope one.
 *
 * Panel code that already holds a DOM node should prefer `ownerWindowOf(node)`;
 * this context exists for the cases with no node to hand, chiefly portal
 * containers.
 *
 * The default is the ambient window, so every consumer without a provider keeps
 * working unchanged.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

const PanelWindowContext = createContext<Window | null>(null);

export interface PanelWindowProviderProps {
  /** The window this subtree renders into. */
  window: Window;
  children: ReactNode;
}

export function PanelWindowProvider({ window: win, children }: PanelWindowProviderProps) {
  return <PanelWindowContext.Provider value={win}>{children}</PanelWindowContext.Provider>;
}

/** Window this subtree renders into. Falls back to the ambient window. */
export function usePanelWindow(): Window {
  return useContext(PanelWindowContext) ?? (globalThis as unknown as { window: Window }).window;
}

/** Document this subtree renders into. Falls back to the ambient document. */
export function usePanelDocument(): Document {
  return usePanelWindow().document;
}

/**
 * Portal container for this subtree — pass it to any portal-based popover /
 * dialog so something opened from a detached panel renders in THAT window
 * instead of behind the main one.
 *
 * `undefined` while the document has no body yet, which is also the usual
 * "use the default" signal for portal APIs.
 */
export function usePortalContainer(): HTMLElement | undefined {
  const doc = usePanelDocument();
  return useMemo(() => doc.body ?? undefined, [doc]);
}

/** True when this subtree is rendering into a detached window. */
export function useIsDetachedPanel(): boolean {
  return usePanelWindow() !== (globalThis as unknown as { window: Window }).window;
}
