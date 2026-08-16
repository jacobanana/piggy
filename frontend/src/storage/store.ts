/**
 * Persistence, behind two calls. Two adapters implement them:
 *
 * - `localAdapter` — JSON in localStorage (the GitHub Pages build), with the
 *   artifact-style `window.storage` used first when a host provides one.
 * - `serverAdapter` — GET/PUT /api/book on the self-hosted build.
 *
 * `store` delegates to whichever is active, so callers never learn which
 * deployment they are in. Boot picks one via `useAdapter`; the default is
 * local, which is what keeps a backend-less Pages build working.
 */
import type { AppState } from '../model/types';
import { STORAGE_KEY } from '../model/state';
import { ApiError, getBook, putBook } from './api';

interface HostStorage {
  get(key: string): Promise<{ value?: string } | null>;
  set(key: string, value: string): Promise<unknown>;
}

declare global {
  interface Window { storage?: HostStorage }
}

export interface StorageAdapter {
  load(): Promise<AppState | null>;
  save(data: AppState): Promise<boolean>;
}

export const localAdapter: StorageAdapter = {
  async load() {
    if (typeof window !== 'undefined' && window.storage) {
      try {
        const r = await window.storage.get(STORAGE_KEY);
        return r && r.value ? (JSON.parse(r.value) as AppState) : null;
      } catch {
        return null;
      }
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as AppState) : null;
    } catch {
      return null;
    }
  },
  async save(data) {
    const json = JSON.stringify(data);
    if (typeof window !== 'undefined' && window.storage) {
      try { await window.storage.set(STORAGE_KEY, json); return true; } catch { /* fall through */ }
    }
    try { localStorage.setItem(STORAGE_KEY, json); return true; } catch { return false; }
  },
};

/**
 * Sync news for the app layer, as a window event so that storage stays free
 * of DOM imports. `ok: false` means the last write did not land; `expired`
 * means the session is gone and the sign-in screen has to come back.
 */
export interface SyncDetail { ok: boolean; expired: boolean }

function announce(ok: boolean, expired = false): void {
  window.dispatchEvent(new CustomEvent<SyncDetail>('piggy:sync', { detail: { ok, expired } }));
}

/**
 * Writes are chained rather than fired in parallel: the endpoint replaces the
 * whole book, so two overlapping PUTs could land out of order and the older
 * one would win.
 */
let queue: Promise<unknown> = Promise.resolve();

export const serverAdapter: StorageAdapter = {
  async load() {
    return getBook();   // a failure here is fatal to boot; main.ts decides what to show
  },
  save(data) {
    const snapshot = JSON.parse(JSON.stringify(data)) as AppState;
    const run = queue.then(async () => {
      try {
        await putBook(snapshot);
        announce(true);
        return true;
      } catch (err) {
        announce(false, err instanceof ApiError && err.status === 401);
        return false;
      }
    });
    queue = run;
    return run;
  },
};

let active: StorageAdapter = localAdapter;

export function useAdapter(adapter: StorageAdapter): void { active = adapter; }
export const usingServer = (): boolean => active === serverAdapter;

export const store: StorageAdapter = {
  load: () => active.load(),
  save: (data) => active.save(data),
};
