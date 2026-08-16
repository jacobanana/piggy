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
 * of DOM imports.
 *
 * `state` is what the server ended up with — after a merge that can hold
 * somebody else's edits, so the app adopts it rather than assuming its own
 * copy won. `expired` means the session is gone; `conflict` means we drifted
 * too far to merge and have to reload.
 */
export interface SyncDetail {
  ok: boolean;
  expired: boolean;
  conflict: boolean;
  state?: AppState;
}

function announce(detail: Partial<SyncDetail> & { ok: boolean }): void {
  window.dispatchEvent(new CustomEvent<SyncDetail>('piggy:sync', {
    detail: { expired: false, conflict: false, ...detail },
  }));
}

/**
 * Which book we are synced to, and the version it was at. The version is what
 * lets the server merge somebody else's writes into ours instead of letting
 * whoever saves last flatten the other.
 */
let bookId: string | null = null;
let version: number | null = null;

export function useServerBook(id: string | null): void {
  bookId = id;
  version = null;
  useAdapter(serverAdapter);
}

export const currentBookId = (): string | null => bookId;

/**
 * Writes are chained rather than fired in parallel: the endpoint replaces the
 * whole book, so two overlapping PUTs could land out of order and the older
 * one would win.
 */
let queue: Promise<unknown> = Promise.resolve();
let writing = 0;

export const isIdle = (): boolean => writing === 0;

export const serverAdapter: StorageAdapter = {
  async load() {
    const got = await getBook(bookId);   // a failure here is fatal to boot; the caller decides what to show
    version = got.version;
    return got.state;
  },
  save(data) {
    const snapshot = JSON.parse(JSON.stringify(data)) as AppState;
    writing += 1;
    const run = queue.then(async () => {
      try {
        const saved = await putBook(bookId, snapshot, version);
        version = saved.version;
        writing -= 1;
        /* Only hand the merged copy back when nothing else is queued. An
           earlier response is missing whatever was edited while it was in
           flight, and adopting it would undo those edits on screen. */
        announce({ ok: true, state: writing === 0 ? saved.state : undefined });
        return true;
      } catch (err) {
        writing -= 1;
        const status = err instanceof ApiError ? err.status : 0;
        announce({ ok: false, expired: status === 401, conflict: status === 409 });
        return false;
      }
    });
    queue = run;
    return run;
  },
};

/**
 * Pull the book if somebody else has moved it on. Returns null when we are
 * already current, so the caller only re-renders on real news.
 */
export async function refresh(): Promise<AppState | null> {
  if (!usingServer() || version === null) return null;
  const got = await getBook(bookId);
  if (version !== null && got.version !== null && got.version <= version) return null;
  version = got.version;
  return got.state;
}

let active: StorageAdapter = localAdapter;

export function useAdapter(adapter: StorageAdapter): void { active = adapter; }
export const usingServer = (): boolean => active === serverAdapter;

export const store: StorageAdapter = {
  load: () => active.load(),
  save: (data) => active.save(data),
};
