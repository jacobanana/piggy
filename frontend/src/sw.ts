/// <reference lib="webworker" />

/**
 * The service worker: Piggy's shell, offline.
 *
 * Written by hand rather than pulled from a plugin, because the one thing this
 * app needs from a worker is the one thing a generated worker cannot be told:
 * **every URL here is relative to where the worker itself was served from.**
 * Piggy ships to two places from one build — `/piggy/` on GitHub Pages and `/`
 * behind the FastAPI box — and `vite.config.ts` keeps that working with
 * `base: './'`. A worker with a `/index.html` in it would precache the wrong
 * document on Pages and quietly serve somebody else's page. `ROOT` below is the
 * whole trick, and `storage/api.ts` resolves the backend the same way against
 * `document.baseURI`.
 *
 * What it does, in the order the events fire:
 *
 *   install    precache the built shell — the document, the bundle, the icons.
 *              Deliberately no `skipWaiting()`: a new worker waits until the
 *              reader asks for it (see `app/pwa.ts`), because taking over
 *              mid-session is how a half-typed expense gets thrown away.
 *   activate   drop the previous version's cache, then claim open tabs.
 *   fetch      navigations are answered from the precache and never wait for
 *              the network; hashed assets are cache-first because their name
 *              changes when their content does; fonts get their own cache that
 *              survives deploys; and the backend is never touched.
 *
 * **The backend is never cached, and that is a money rule, not an optimisation.**
 * A stale `GET api/book` served from a cache is a ledger that disagrees with the
 * one the other person is looking at. Everything under `api/` is left to the
 * network, so being offline fails loudly through the sync layer rather than
 * quietly through a cache.
 */

/**
 * Load-bearing, despite exporting nothing: it makes this file a module, which
 * is what lets the `self` below shadow the global one. As a plain script the
 * declaration collides with `WorkerGlobalScope`'s own `self` instead, and every
 * `event.respondWith` in here stops typechecking. Do not tidy it away.
 */
export {};

declare const self: ServiceWorkerGlobalScope;

/**
 * Injected at build time by the `piggy-service-worker` plugin in
 * `vite.config.ts`. `__PRECACHE__` is every file the build actually wrote,
 * relative to the app root; `__SW_VERSION__` is a digest of their contents, so
 * the cache name changes when — and only when — something shipped changed.
 */
declare const __SW_VERSION__: string;
declare const __PRECACHE__: readonly string[];

/** The app's own directory, wherever this worker happens to be served from. */
const ROOT = new URL('./', self.location.href);

const SHELL_CACHE = `piggy-shell-${__SW_VERSION__}`;

/** Unversioned: the webfonts are immutable, so a deploy has no reason to refetch them. */
const FONT_CACHE = 'piggy-fonts';

/** The document every in-app navigation resolves to; the app routes itself. */
const SHELL = new URL('index.html', ROOT).href;

/** Mirrors `API_BASE` in `storage/api.ts` — same base, same answer. */
const API_PREFIX = new URL('api/', ROOT).href;

const PRECACHE = __PRECACHE__.map((path) => new URL(path, ROOT).href);

/** Matched by path, so a cache-busting query string still finds its asset. */
const PRECACHED_PATHS = new Set(PRECACHE.map((href) => new URL(href).pathname));

const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // `reload` skips the HTTP cache: precaching a copy the browser already
      // had is how a deploy ships with last week's bundle inside it.
      await cache.addAll(PRECACHE.map((href) => new Request(href, { cache: 'reload' })));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('piggy-shell-') && name !== SHELL_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/** The page's "load the new version now" — see `app/pwa.ts`. */
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(fontFirst(request));
    return;
  }

  // The backend, another origin, or a neighbour app sharing this host: all
  // somebody else's business. The scope check matters on the box, where Piggy
  // is one of several small apps behind the same domain.
  if (request.url.startsWith(API_PREFIX)) return;
  if (url.origin !== self.location.origin) return;
  if (!request.url.startsWith(ROOT.href)) return;

  if (request.mode === 'navigate') {
    event.respondWith(shellForNavigation());
    return;
  }

  if (PRECACHED_PATHS.has(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

/**
 * Open the app from the precache, without waiting for the network.
 *
 * Deliberately not network-first. The shell is precached under a name that
 * changes with its contents, so freshness is already handled by the update
 * cycle — asking the network first would buy nothing and cost the reader a
 * round trip on every launch, on exactly the flaky platform an installed app
 * is meant to help with.
 *
 * The request itself is discarded on purpose: `?join=CODE` and any other query
 * belongs to the page, which reads `location` for itself once it boots.
 */
async function shellForNavigation(): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(SHELL);
  if (cached) return cached;

  try {
    return await fetch(SHELL);
  } catch {
    return new Response('Piggy is offline and has nothing cached yet.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/** Hashed assets: the name changes when the content does, so a hit is always right. */
async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

/**
 * Google's webfonts, kept in their own cache across deploys.
 *
 * Only `ok` responses are stored, which is why `index.html` marks the
 * stylesheet `crossorigin`: without it the request is no-cors, the response is
 * opaque, its status reads as 0 whether it succeeded or failed, and a failed
 * fetch cached once is a font that never recovers.
 */
async function fontFirst(request: Request): Promise<Response> {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}
