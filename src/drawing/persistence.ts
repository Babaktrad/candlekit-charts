/**
 * Drawing persistence helpers. Storage-agnostic via a tiny KV interface so
 * drawings can live in localStorage, a remote store, or anywhere else. A
 * localStorage adapter is provided for the common browser case.
 *
 * `KVStore` / `localStorageKV` themselves live in `dom/kv` so the indicator
 * controller can persist through the same backend, and are re-exported here
 * unchanged — the package exports the same two names it always did.
 */

import { localStorageKV, type KVStore } from "../dom/kv";
import type { DrawingEngine } from "./DrawingEngine";

export { localStorageKV, type KVStore };

export function saveDrawings(engine: DrawingEngine, key: string, kv: KVStore = localStorageKV): void {
  kv.set(key, engine.export());
}

export function loadDrawings(engine: DrawingEngine, key: string, kv: KVStore = localStorageKV): void {
  const raw = kv.get(key);
  if (raw) engine.import(raw);
}
