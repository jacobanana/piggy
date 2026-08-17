/**
 * Piggy as an installed app: the worker, the install suggestion, the update.
 *
 * Everything here resolves against `document.baseURI`, the same way
 * `storage/api.ts` finds the backend, so one build installs correctly at
 * `/piggy/` on Pages and at `/` on the box. Registering `'sw.js'` bare would
 * work by accident today and break the first time a page is served from a
 * sub-path; `new URL(...)` says what is meant.
 */
import { session } from './session';

const DISMISSED_KEY = 'piggy.pwa.dismissed.v1';

/** A platform that installs by hand, and therefore needs telling how. */
export type ManualInstall = 'ios' | 'firefox';

/** The non-standard event Chromium fires when the app is installable. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Which by-hand install route this browser has, if any.
 *
 * Pure, and taking what it reads rather than reaching for `navigator`, because
 * every branch is one user-agent string away from the next and a wrong answer
 * is invisible in the browser you happen to be testing in — it sends somebody
 * looking for a menu entry they do not have.
 *
 * iOS beats Firefox, because on iOS Firefox *is* WebKit: since 16.4 Apple has
 * exposed Add to Home Screen to every browser on the platform, so Chrome, Edge
 * and Firefox all install exactly the web app Safari does. Singling out Safari
 * leaves an iPhone on Chrome with no button and no instructions, which reads as
 * "this app cannot be installed". Firefox counts only on Android; the desktop
 * one installs nothing, so it gets silence rather than directions to a menu
 * entry that does not exist.
 *
 * @param userAgent `navigator.userAgent`
 * @param platform `navigator.platform` — iPadOS 13+ claims to be a Mac
 * @param maxTouchPoints `navigator.maxTouchPoints`, which gives that away
 */
export function manualInstallFor(
  userAgent: string,
  platform: string,
  maxTouchPoints: number,
): ManualInstall | null {
  const isIos =
    /iphone|ipad|ipod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
  if (isIos) return 'ios';
  if (/firefox/i.test(userAgent) && /android/i.test(userAgent)) return 'firefox';
  return null;
}

/**
 * Is the app already running installed?
 *
 * Two questions because iOS answers a different one: `display-mode: standalone`
 * is the standard, and every browser but Safari reports it. Safari has answered
 * `navigator.standalone` since long before the media query existed and still
 * does not implement it for home-screen apps, so checking only the standard way
 * shows an iPhone the install banner inside the installed app.
 */
function isInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/* ---------- the install suggestion ---------- */

let deferredPrompt: BeforeInstallPromptEvent | null = null;

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function remember(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    /* private mode; the banner comes back next launch and that is fine */
  }
}

function hideBanner(): void {
  bannerSize?.disconnect();
  bannerSize = null;
  document.getElementById('pwaBanner')?.remove();
  document.body.classList.remove('pwa-suggest');
  document.body.style.removeProperty('--pwa-banner-h');
}

let bannerSize: ResizeObserver | null = null;

/**
 * Publish the banner's height so the FAB and the page bottom can step over it.
 *
 * Measured rather than assumed: the card is two lines on Android, four on an
 * iPhone once the share-sheet instructions and the storage note are in it, and
 * more again when the text wraps at a large accessibility size or the phone is
 * turned. A constant here was wrong the first time it met the iOS copy — it
 * left the FAB sitting on top of the card — and it would be wrong again at the
 * next wording change, silently.
 */
function trackBannerHeight(banner: HTMLElement): void {
  const publish = (): void => {
    document.body.style.setProperty('--pwa-banner-h', `${banner.offsetHeight}px`);
  };
  publish();
  bannerSize = new ResizeObserver(publish);
  bannerSize.observe(banner);
}

function dismiss(): void {
  remember();
  hideBanner();
}

/**
 * The banner, drawn once and owning its own clicks.
 *
 * Not routed through `events.ts` like the rest of the app: that delegate opens
 * with `if (!S) return`, and the suggestion is chrome that can be on screen
 * before there is any book to act on — during the sign-in gate, most obviously.
 */
function showBanner(manual: ManualInstall | null): void {
  if (document.getElementById('pwaBanner')) return;

  const how =
    manual === 'ios'
      ? '<p class="pwa-how">Tap <b>Share</b> <span class="pwa-key">↑</span> below, then <b>Add to Home Screen</b>.</p>'
      : manual === 'firefox'
        ? '<p class="pwa-how">Open the <span class="pwa-key">⋮</span> menu, then <b>Install</b>.</p>'
        : '<p class="pwa-how">Opens full screen, and works with no signal.</p>';

  /* Only on iOS, and only where the book lives in this browser: Safari clears
     an ordinary site's storage after about a week of not being opened, and a
     home-screen app is exempt. On the self-hosted build the book is on the
     server, so the same sentence would be a scare rather than a reason. */
  const durability =
    manual === 'ios' && session.mode === 'local'
      ? '<p class="pwa-why">Installed, iOS also stops clearing your book after a week unused.</p>'
      : '';

  const banner = document.createElement('div');
  banner.className = 'pwa-banner';
  banner.id = 'pwaBanner';
  banner.innerHTML =
    '<div class="pwa-card">' +
    '<span class="pwa-pig">🐷</span>' +
    '<div class="pwa-copy"><b>Put Piggy on your home screen</b>' + how + durability + '</div>' +
    (deferredPrompt ? '<button class="btn sm" data-pwa="install">Install</button>' : '') +
    '<button class="icon-btn pwa-x" data-pwa="dismiss" aria-label="Not now">✕</button>' +
    '</div>';

  banner.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-pwa]')?.dataset.pwa;
    if (act === 'dismiss') dismiss();
    if (act === 'install') void install();
  });

  document.body.appendChild(banner);
  // Lifts the FAB and the page's bottom clear of the card; on a phone the FAB
  // and the suggestion share the same corner.
  document.body.classList.add('pwa-suggest');
  trackBannerHeight(banner);
}

async function install(): Promise<void> {
  if (!deferredPrompt) return;
  const prompt = deferredPrompt;
  deferredPrompt = null;   // a used prompt cannot be replayed
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome === 'accepted') hideBanner();
  else dismiss();
}

function wireInstallSuggestion(): void {
  if (isInstalled() || dismissed()) return;

  const manual = manualInstallFor(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();   // suppress Chromium's mini-infobar; we drive this
    deferredPrompt = e as BeforeInstallPromptEvent;
    if (!dismissed()) {
      hideBanner();       // redraw, now that there is a real button to offer
      showBanner(null);
    }
  });

  window.addEventListener('appinstalled', hideBanner);

  /* A platform we cannot prompt on is told how by hand. Waiting for an event
     that only Chromium fires is what leaves iPhone and Firefox users believing
     the app is not installable at all. */
  if (manual) showBanner(manual);
}

/* ---------- the update ---------- */

/**
 * Whether *this page* asked for the new version.
 *
 * The reload is gated on it rather than on `controllerchange` alone, because
 * that event has two causes and only one of them is ours. The other is the
 * first registration: a brand-new worker calls `clients.claim()`, the page it
 * just claimed sees its controller change, and reloading there means every
 * first visit to Piggy silently reloads itself. It also keeps a second tab from
 * being yanked out from under whoever is typing in it when the first tab takes
 * the update — their assets are hashed and still cached, so that tab is
 * perfectly fine where it is until it is next opened.
 */
let refreshRequested = false;

/** A toast that waits to be answered, rather than one that fades. */
function offerReload(worker: ServiceWorker): void {
  if (document.getElementById('pwaUpdate')) return;

  const bar = document.createElement('div');
  bar.className = 'toast toast-action';
  bar.id = 'pwaUpdate';
  bar.innerHTML = 'A new Piggy is ready <button class="btn sm" data-pwa="reload">Refresh</button>';
  bar.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('[data-pwa="reload"]')) return;
    bar.remove();
    refreshRequested = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  });
  document.body.appendChild(bar);
}

/**
 * Register the worker and watch for its replacement.
 *
 * The new version is never applied on its own. `sw.ts` deliberately does not
 * call `skipWaiting()`, so a build that lands while somebody is halfway through
 * entering an expense waits until they say so — an app that reloads itself
 * under a half-filled form is worse than one that is a version behind.
 */
function registerWorker(): void {
  const url = new URL('sw.js', document.baseURI);
  const scope = new URL('./', document.baseURI);

  void navigator.serviceWorker.register(url, { scope: scope.href }).then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offerReload(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        // No controller means this is the first install, not an update; there
        // is nothing for the reader to refresh into.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          offerReload(installing);
        }
      });
    });

    /* An installed app is opened, not loaded — it can sit in the background for
       days without ever asking the network whether it is current. Coming back
       to the foreground is the moment to check. */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void reg.update();
    });
  }).catch(() => {
    /* No worker is a working Piggy, just an online one. Nothing to report. */
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshRequested) return;
    refreshRequested = false;   // one reload per ask, whatever else fires
    location.reload();
  });
}

/**
 * Start the PWA machinery. Safe to call anywhere, on any deployment.
 *
 * The worker is production-only: `vite dev` serves modules straight from source
 * and never emits `sw.js`, so registering in dev would 404 on every reload and,
 * worse, a stale precache would start answering for files the dev server is
 * trying to hot-reload.
 */
export function initPwa(): void {
  wireInstallSuggestion();
  if (import.meta.env.PROD && 'serviceWorker' in navigator) registerWorker();
}
