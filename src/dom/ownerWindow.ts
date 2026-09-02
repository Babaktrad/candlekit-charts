/**
 * Owner-window helpers — multi-window correctness.
 *
 * A chart can be rendered into a second browser window (a panel detached onto
 * another monitor, a popout, an `<iframe>`-free portal) while the JavaScript
 * still runs in the original realm. Two consequences:
 *
 *   - An event fired inside that window bubbles to THAT window, never to the
 *     original one. A bare `window.addEventListener("keydown" | "mouseup" | …)`
 *     therefore goes deaf for the detached chart. It is not cosmetic: a missed
 *     `mouseup` leaves a drag latched, and a missed `keydown` kills Escape /
 *     Delete for every drawing in that window.
 *   - `document.body`, `document.hidden`, `matchMedia`, `devicePixelRatio` and
 *     `getBoundingClientRect` coordinates are all per-window.
 *
 * Rule inside this package: never bind a listener (or read a viewport global)
 * off the bare module `window` / `document`. Resolve it from a DOM node the
 * code already owns.
 *
 * Lives outside `core/` on purpose: `core/` is DOM-free by invariant. This is a
 * dependency-free leaf module (like `events/`) that every chart-coupled folder
 * — `chart/`, `drawing/`, `measurement/`, `indicators/`, `react/` — may import.
 * Nothing is read at module scope, so importing it stays side-effect-free.
 */

/** Owning window of a node, or the ambient window when it is not attached. */
export function ownerWindowOf(el: Node | null | undefined): Window {
  const view = el?.ownerDocument?.defaultView as Window | null | undefined;
  return view ?? (globalThis as unknown as { window: Window }).window;
}

/** Owning document of a node, or the ambient document when it is not attached. */
export function ownerDocumentOf(el: Node | null | undefined): Document {
  return el?.ownerDocument ?? (globalThis as unknown as { document: Document }).document;
}
