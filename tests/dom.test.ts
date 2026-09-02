import { describe, it, expect, afterEach } from "vitest";
import { ownerWindowOf, ownerDocumentOf } from "../src/dom/ownerWindow";
import { localStorageKV, type KVStore } from "../src/dom/kv";
import { paneKeyOf, indicatorPaneKeys, PRIMARY_PANE_KEY } from "../src/indicators/paneKeyRegistry";
import type { ISeriesApi, SeriesType } from "lightweight-charts";

const g = globalThis as unknown as Record<string, unknown>;

function stub(key: "window" | "document" | "localStorage", value: unknown) {
  const had = key in g;
  const prev = g[key];
  g[key] = value;
  return () => {
    if (had) g[key] = prev;
    else delete g[key];
  };
}

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

/** A node in another window: its ownerDocument.defaultView is NOT the ambient one. */
function nodeInWindow(win: unknown, doc: unknown): Node {
  return { ownerDocument: { ...(doc as object), defaultView: win } } as unknown as Node;
}

describe("ownerWindowOf / ownerDocumentOf", () => {
  it("resolves the node's own window, not the module global", () => {
    const ambient = { name: "ambient" };
    restores.push(stub("window", ambient));
    const other = { name: "detached" };
    const doc = { id: "other-doc" };

    // The whole point of the helper: a detached panel lives in another
    // document but the same JS realm, so the module global is the wrong answer.
    expect(ownerWindowOf(nodeInWindow(other, doc))).toBe(other);
    expect(ownerWindowOf(nodeInWindow(other, doc))).not.toBe(ambient);
  });

  it("falls back to the ambient window for null / detached nodes", () => {
    const ambient = { name: "ambient" };
    restores.push(stub("window", ambient));

    expect(ownerWindowOf(null)).toBe(ambient);
    expect(ownerWindowOf(undefined)).toBe(ambient);
    // Detached node: has an ownerDocument but it has no defaultView.
    expect(ownerWindowOf({ ownerDocument: { defaultView: null } } as unknown as Node)).toBe(ambient);
  });

  it("resolves the owning document, falling back to the ambient one", () => {
    const ambientDoc = { id: "ambient-doc" };
    restores.push(stub("document", ambientDoc));
    const otherDoc = { id: "other-doc", defaultView: {} };

    expect(ownerDocumentOf({ ownerDocument: otherDoc } as unknown as Node)).toBe(otherDoc);
    expect(ownerDocumentOf(null)).toBe(ambientDoc);
  });
});

describe("localStorageKV", () => {
  it("round-trips through localStorage", () => {
    const store = new Map<string, string>();
    restores.push(
      stub("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      }),
    );

    localStorageKV.set("ck:drawings", '{"a":1}');
    expect(localStorageKV.get("ck:drawings")).toBe('{"a":1}');
    expect(localStorageKV.get("missing")).toBeNull();
  });

  it("survives a throwing store instead of taking the caller down", () => {
    // Safari private mode / quota exceeded: setItem throws. Persistence is a
    // convenience, so losing it must not break the feature that called it.
    restores.push(
      stub("localStorage", {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      }),
    );

    expect(() => localStorageKV.set("k", "v")).not.toThrow();
    expect(localStorageKV.get("k")).toBeNull();
  });

  it("is inert when there is no localStorage at all (SSR)", () => {
    restores.push(stub("localStorage", undefined));
    expect(() => localStorageKV.set("k", "v")).not.toThrow();
    expect(localStorageKV.get("k")).toBeNull();
  });

  it("accepts any KVStore-shaped backend", () => {
    const mem = new Map<string, string>();
    const custom: KVStore = {
      get: (k) => mem.get(k) ?? null,
      set: (k, v) => void mem.set(k, v),
    };
    custom.set("x", "1");
    expect(custom.get("x")).toBe("1");
    expect(custom.get("y")).toBeNull();
  });
});

describe("paneKeyRegistry", () => {
  const series = (id: string) => ({ id }) as unknown as ISeriesApi<SeriesType>;

  it("reports the primary pane for unregistered and nullish series", () => {
    expect(paneKeyOf(series("price"))).toBe(PRIMARY_PANE_KEY);
    expect(paneKeyOf(null)).toBe(PRIMARY_PANE_KEY);
    expect(paneKeyOf(undefined)).toBe(PRIMARY_PANE_KEY);
  });

  it("reports the registered pane key for an oscillator series", () => {
    const rsi = series("rsi");
    indicatorPaneKeys.set(rsi, "RSI");
    expect(paneKeyOf(rsi)).toBe("RSI");
    // Distinct series stay independent.
    expect(paneKeyOf(series("macd"))).toBe(PRIMARY_PANE_KEY);
    indicatorPaneKeys.delete(rsi);
    expect(paneKeyOf(rsi)).toBe(PRIMARY_PANE_KEY);
  });
});
