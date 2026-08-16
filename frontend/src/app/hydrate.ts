/**
 * Putting a loaded book on screen, and the last-resort error card.
 *
 * Its own module because two callers need it: the Pages boot path in
 * main.ts, and the sign-in screen once a server book arrives.
 */
import { UI, setState } from './context';
import { render } from './render';
import { applyTheme } from './theme';
import { normalize } from '../model/state';
import { thisMonth } from '../lib/utils';
import type { AppState } from '../model/types';

let booted = false;

export function fatal(msg: unknown): void {
  try {
    if (booted) { console.error(msg); return; }   // app is up and usable: log, don't wipe it
    const m = document.getElementById('main');
    if (!m) return;
    m.innerHTML = '<div class="card" style="margin-top:20px"><h2>Something broke 🙈</h2>' +
      '<p class="sub" style="margin:10px 0;line-height:1.5">The app hit an error while starting up. ' +
      'Reloading usually fixes it. If it keeps happening, send this line along:</p>' +
      '<div class="mono" style="font-size:12px;background:var(--tint);border-radius:10px;padding:10px;word-break:break-word">' +
      String(msg).replace(/</g, '&lt;') + '</div></div>';
  } catch { /* nothing left to do */ }
}

export function hydrate(loaded: AppState | null): void {
  const s = normalize(loaded);
  setState(s);
  applyTheme(s.settings.theme);
  UI.ledgerId = (s.ledgers.find((l) => !l.archived) || {}).id ?? null;
  UI.month = thisMonth();
  try {
    render();
    booted = s.people.length > 0;
  } catch (err) {
    booted = false;
    fatal((err as Error).message);
  }
}
