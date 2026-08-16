/**
 * Persistence for the GitHub Pages build: JSON in localStorage, with the
 * artifact-style `window.storage` used first when a host provides one.
 *
 * The interface is deliberately tiny so a backend-API adapter can slot in
 * behind the same two calls when the FastAPI server lands.
 */
import type { AppState } from '../model/types';
import { STORAGE_KEY } from '../model/state';

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

export const store: StorageAdapter = {
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
