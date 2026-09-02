/**
 * Tiny storage-agnostic key/value contract, plus a `localStorage` adapter.
 *
 * Shared by every feature that can persist a snapshot (drawings, indicator
 * sets, …) so a consumer can redirect all of them to one backend — a remote
 * store, an in-memory map in tests, a per-user server document — by passing a
 * single object. Lives outside `core/` because the default adapter touches a
 * browser global; the interface itself is environment-free.
 */

export interface KVStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const localStorageKV: KVStore = {
  get(key) {
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
    } catch {
      /* quota / unavailable */
    }
  },
};
