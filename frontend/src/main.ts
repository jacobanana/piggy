import './styles.css';
import { setState } from './app/context';
import { enterBooks, setPendingJoin } from './app/books';
import { wireEvents } from './app/events';
import { leaveGate, splash } from './app/gate';
import { fatal, hydrate } from './app/hydrate';
import { sessionExpired, signInScreen } from './app/auth';
import { toast } from './app/modals';
import { adoptRemote, pull, startSync } from './app/sync';
import { session } from './app/session';
import { blankState } from './model/state';
import { detectBackend, hasSession, whoami } from './storage/api';
import { store } from './storage/store';
import type { SyncDetail } from './storage/store';

window.addEventListener('error', (e) => { fatal(e.message || e); });
window.addEventListener('unhandledrejection', (e) => { fatal((e.reason && e.reason.message) || e.reason); });

/* Sync news from the server adapter. `state` is what the book actually looks
   like after the server merged our write with anyone else's, so we adopt it
   rather than assume our copy won. */
window.addEventListener('piggy:sync', (e) => {
  const d = (e as CustomEvent<SyncDetail>).detail;
  if (d.ok) { if (d.state) adoptRemote(d.state); return; }
  if (d.expired) { sessionExpired(); return; }
  if (d.conflict) { void pull(); toast('Caught up with the others'); return; }
  toast("Couldn't save to the server — your next change will try again");
});

window.addEventListener('piggy:signedout', () => sessionExpired());

wireEvents();
setState(blankState());

/**
 * Which deployment are we? One probe of /api/health decides:
 *
 * - nothing answers (GitHub Pages, a plain static host) — localStorage, no
 *   sign-in, exactly as before;
 * - a Piggy backend answers — nothing is rendered until somebody is signed
 *   in, and the book comes from the server.
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
  /* An invite link is followed after sign-in, never before: previewing one
     needs an account, so a stranger with a code learns nothing. */
  setPendingJoin(new URL(location.href).searchParams.get('join'));
  startSync();   // idles until a book is actually open

  if (!hasSession()) { signInScreen(); return; }
  splash('Signing you in…');
  const user = await whoami();
  if (!user) { signInScreen(); return; }
  session.user = user;
  await enterBooks();
}

void boot().catch((err) => fatal((err as Error).message));
