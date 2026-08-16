import './styles.css';
import { setState } from './app/context';
import { wireEvents } from './app/events';
import { fatal, hydrate } from './app/hydrate';
import { enterApp, leaveGate, sessionExpired, signInScreen, splash } from './app/auth';
import { toast } from './app/modals';
import { session } from './app/session';
import { blankState } from './model/state';
import { detectBackend, hasSession, whoami } from './storage/api';
import { serverAdapter, store, useAdapter } from './storage/store';
import type { SyncDetail } from './storage/store';

window.addEventListener('error', (e) => { fatal(e.message || e); });
window.addEventListener('unhandledrejection', (e) => { fatal((e.reason && e.reason.message) || e.reason); });

/* Sync news from the server adapter. A write that didn't land is worth a
   word; a session the server has stopped honouring sends us back to the gate
   rather than letting edits pile up against nothing. */
window.addEventListener('piggy:sync', (e) => {
  const d = (e as CustomEvent<SyncDetail>).detail;
  if (d.ok) return;
  if (d.expired) sessionExpired();
  else toast("Couldn't save to the server — your next change will try again");
});

wireEvents();
setState(blankState());

/**
 * Which deployment are we? One probe of /api/health decides:
 *
 * - nothing answers (GitHub Pages, a plain static host) — localStorage, no
 *   sign-in, exactly as before;
 * - a Piggy backend answers — nothing is rendered until somebody is signed
 *   in, and the book comes from GET /api/book.
 *
 * The splash is deliberately late: the probe against a static host 404s in a
 * few milliseconds, so the Pages build normally paints straight to the book
 * with nothing flashing in between.
 */
async function boot(): Promise<void> {
  const splashTimer = setTimeout(() => splash('Warming up…'), 300);
  const [backend, local] = await Promise.all([
    detectBackend(),
    store.load().catch(() => null),   // local adapter is still the active one here
  ]);
  clearTimeout(splashTimer);

  if (!backend) {
    session.mode = 'local';
    leaveGate();
    hydrate(local);
    return;
  }

  session.mode = 'server';
  useAdapter(serverAdapter);   // from here on nothing reads or writes localStorage
  if (!hasSession()) { signInScreen(); return; }

  splash('Signing you in…');
  const user = await whoami();
  if (!user) { signInScreen(); return; }
  session.user = user;
  await enterApp();
}

void boot().catch((err) => fatal((err as Error).message));
