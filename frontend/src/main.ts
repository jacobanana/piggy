import './styles.css';
import { setState } from './app/context';
import { enterBooks, setPendingJoin } from './app/books';
import { wireEvents } from './app/events';
import { gateError, leaveGate, splash } from './app/gate';
import { fatal, hydrate } from './app/hydrate';
import { sessionExpired, signInScreen } from './app/auth';
import { toast } from './app/modals';
import { initPwa } from './app/pwa';
import { adoptRemote, pull, startSync } from './app/sync';
import { session } from './app/session';
import { blankState } from './model/state';
import { OFFLINE, detectBackend, hasSession, whoami } from './storage/api';
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
    initPwa();
    leaveGate();
    hydrate(local);
    return;
  }

  session.mode = 'server';
  /* After the mode is known, never before: the install suggestion says
     something different where the book lives in this browser and nowhere
     else. */
  initPwa();
  /* An invite link is followed after sign-in, never before: previewing one
     needs an account, so a stranger with a code learns nothing. */
  setPendingJoin(new URL(location.href).searchParams.get('join'));
  startSync();   // idles until a book is actually open

  if (!hasSession()) { signInScreen(); return; }
  splash('Signing you in…');
  const user = await whoami();
  /* Installed, this is the tunnel: the shell came out of the cache and the
     server is not there. The session is still good, so it is kept and the
     reader is told to come back — showing the sign-in form instead would be
     asking them to do the one thing that cannot work without a network. */
  if (user === OFFLINE) {
    gateError("You're offline", 'Piggy needs the network to open your shared book. Everything is still on the server — try again once you have signal.', 'boot-retry');
    return;
  }
  if (!user) { signInScreen(); return; }
  session.user = user;
  await enterBooks();
}

void boot().catch((err) => fatal((err as Error).message));
