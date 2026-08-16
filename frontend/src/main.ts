import './styles.css';
import { UI, setState } from './app/context';
import { render } from './app/render';
import { wireEvents } from './app/events';
import { applyTheme } from './app/theme';
import { blankState, normalize } from './model/state';
import { store } from './storage/store';
import { thisMonth } from './lib/utils';
import type { AppState } from './model/types';

let booted = false;

function fatal(msg: unknown): void {
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
window.addEventListener('error', (e) => { fatal(e.message || e); });
window.addEventListener('unhandledrejection', (e) => { fatal((e.reason && e.reason.message) || e.reason); });

function hydrate(loaded: AppState | null): void {
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

wireEvents();

/* Boot immediately with an empty book, then swap in saved data once storage
   answers. A slow or blocked storage layer can never leave the app dead. */
setState(blankState());
hydrate(null);
(() => {
  let done = false;
  const finish = (data: AppState | null): void => { if (done) return; done = true; if (data) hydrate(data); };
  setTimeout(() => finish(null), 2500);
  Promise.resolve().then(() => store.load()).then(finish).catch(() => finish(null));
})();
