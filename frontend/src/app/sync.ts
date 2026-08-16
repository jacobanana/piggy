/**
 * Keeping the open book in step with whoever else is editing it.
 *
 * The server merges concurrent writes, so our own saves already come back
 * with the other person's edits folded in. This adds the other half: a quiet
 * poll so their changes show up even when we aren't saving anything.
 */
import { S, setState } from './context';
import { render } from './render';
import { normalize } from '../model/state';
import { isIdle, refresh, usingServer } from '../storage/store';
import type { AppState } from '../model/types';
import { $ } from '../lib/utils';

const POLL_MS = 15000;

/** Re-rendering under an open modal would yank the form out from under it. */
const modalOpen = (): boolean => Boolean($('#modalRoot')?.firstChild);

/** Take the server's copy as the truth, and only repaint if it says something new. */
export function adoptRemote(state: AppState): void {
  if (JSON.stringify(state) === JSON.stringify(S)) return;
  setState(normalize(state));
  if (!modalOpen()) render();
}

export async function pull(): Promise<void> {
  if (!usingServer() || !isIdle()) return;
  try {
    const state = await refresh();
    if (state) adoptRemote(state);
  } catch { /* offline: the next tick tries again */ }
}

/**
 * Poll while the tab is in front, and catch up the moment it comes back —
 * a phone that was in a pocket should not show yesterday's tally.
 */
export function startSync(): void {
  setInterval(() => { if (!document.hidden) void pull(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void pull(); });
  window.addEventListener('focus', () => void pull());
}
