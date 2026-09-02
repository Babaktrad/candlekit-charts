// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement as h, act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  PanelWindowProvider,
  usePanelWindow,
  usePanelDocument,
  usePortalContainer,
  useIsDetachedPanel,
} from "../src/react/workspace/PanelWindowContext";
import { useChartTheme } from "../src/react/hooks/useChartTheme";
import { resolveTheme } from "../src/core/theme";

// react-dom/client + act require this flag in React 18.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.classList.remove("dark");
});

/** Render `el` and hand back whatever the probe captured. */
function render(el: ReactElement) {
  act(() => root.render(el));
}

function probe<T>(use: () => T, sink: { value?: T }) {
  return function Probe() {
    sink.value = use();
    return null;
  };
}

/** A stand-in for a second browser window (a detached panel's own window). */
function fakeWindow() {
  const doc = document.implementation.createHTMLDocument("detached");
  return { document: doc } as unknown as Window;
}

describe("PanelWindowContext", () => {
  it("defaults to the ambient window when there is no provider", () => {
    const sink: { value?: Window } = {};
    const P = probe(usePanelWindow, sink);
    render(h(P));
    expect(sink.value).toBe(window);
  });

  it("hands a provided window to the subtree", () => {
    const other = fakeWindow();
    const sink: { value?: Window } = {};
    const P = probe(usePanelWindow, sink);
    render(h(PanelWindowProvider, { window: other } as never, h(P) as ReactNode));
    expect(sink.value).toBe(other);
    expect(sink.value).not.toBe(window);
  });

  it("resolves the document of the provided window, not the ambient one", () => {
    const other = fakeWindow();
    const sink: { value?: Document } = {};
    const P = probe(usePanelDocument, sink);
    render(h(PanelWindowProvider, { window: other } as never, h(P) as ReactNode));
    expect(sink.value).toBe(other.document);
    expect(sink.value).not.toBe(document);
  });

  it("gives a portal container in the panel's own document", () => {
    // The bug this prevents: a menu opened from a detached panel portalling
    // into the MAIN window's body, i.e. rendering behind the other monitor.
    const other = fakeWindow();
    const sink: { value?: HTMLElement | undefined } = {};
    const P = probe(usePortalContainer, sink);
    render(h(PanelWindowProvider, { window: other } as never, h(P) as ReactNode));
    expect(sink.value).toBe(other.document.body);
    expect(sink.value).not.toBe(document.body);
  });

  it("reports detachment only when the window differs from the ambient one", () => {
    const sink: { value?: boolean } = {};
    const P = probe(useIsDetachedPanel, sink);

    render(h(P));
    expect(sink.value).toBe(false);

    render(h(PanelWindowProvider, { window } as never, h(P) as ReactNode));
    expect(sink.value).toBe(false);

    render(h(PanelWindowProvider, { window: fakeWindow() } as never, h(P) as ReactNode));
    expect(sink.value).toBe(true);
  });
});

describe("useChartTheme", () => {
  it("resolves the document's dark mode", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const sink: { value?: ReturnType<typeof resolveTheme> } = {};
    const P = probe(() => useChartTheme(), sink);
    render(h(P));
    expect(sink.value).toEqual(resolveTheme("dark"));
  });

  it("resolves the document's light mode", () => {
    document.documentElement.setAttribute("data-theme", "light");
    const sink: { value?: ReturnType<typeof resolveTheme> } = {};
    const P = probe(() => useChartTheme(), sink);
    render(h(P));
    expect(sink.value).toEqual(resolveTheme("light"));
  });

  it("follows a theme flip without a remount", async () => {
    // The whole point of the hook: a page-wide theme toggle must reach a chart
    // that is already mounted, or a dark-only chrome survives into light mode.
    document.documentElement.setAttribute("data-theme", "dark");
    const sink: { value?: ReturnType<typeof resolveTheme> } = {};
    const P = probe(() => useChartTheme(), sink);
    render(h(P));
    expect(sink.value).toEqual(resolveTheme("dark"));

    // usePageTheme observes the attribute, so the update lands asynchronously.
    await act(async () => {
      document.documentElement.setAttribute("data-theme", "light");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sink.value).toEqual(resolveTheme("light"));
    expect(sink.value).not.toEqual(resolveTheme("dark"));
  });

  it("applies overrides without forking the palette", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const sink: { value?: ReturnType<typeof resolveTheme> } = {};
    const overrides = { background: "#123456" };
    const P = probe(() => useChartTheme(overrides), sink);
    render(h(P));

    expect(sink.value!.background).toBe("#123456");
    // Everything not overridden still comes from the resolved base palette.
    const base = resolveTheme("dark");
    expect(sink.value!.text).toBe(base.text);
    expect(sink.value!.grid).toBe(base.grid);
  });
});
