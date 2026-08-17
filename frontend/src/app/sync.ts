/**
 * Keeping the open book in step with whoever else is editing it.
 *
 * The server merges concurrent writes, so our own saves already come back
 * with the other person's edits folded in. This adds the other half: a quiet
 * poll so their changes show up even when we aren't saving anything.
 */
import { S, setState } from './context';
import { render } from './render';
import { syncBookName } from './session';
import { normalize } from '../model/state';
import { isIdle, refresh, usingServer } from '../storage/store';
import type { AppState } from '../model/types';
import { $ } from '../lib/utils';

const POLL_MS = 15000;

/** Re-rendering under an open modal would yank the form out from under it. */
const modalOpen = (): boolean => Boolean($('#modalRoot')?.firstChild);

/**
 * A repaint we owe the screen because a modal was over it when the news
 * arrived. It has to be remembered: the state is adopted either way, and the
 * poll only hands a version back once — every later tick sees itself as
 * current and returns nothing — so a skipped repaint is never offered again.
 * That is how somebody else's expense could stay off the list for good, with
 * the app holding it in memory the whole time.
 */
let owedRepaint = false;

/** Take the server's copy as the truth, and only repaint if it says something new. */
export function adoptRemote(state: AppState): void {
  if (JSON.stringify(state) === JSON.stringify(S)) return;
  setState(normalize(state));
  // Straight setState, not replaceState: the server's name is the truth here —
  // somebody else may have renamed the bank, and that is news, not a clash.
  syncBookName(S.meta.appName);
  if (modalOpen()) { owedRepaint = true; return; }
  owedRepaint = false;
  render();
}

/** Paint what landed while a modal was covering the screen. Called on close. */
export function repaintIfOwed(): void {
  if (!owedRepaint) return;
  owedRepaint = false;
  render();
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
