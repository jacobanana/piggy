/**
 * The fingerprint lock: Piggy behind the device's own biometric prompt.
 *
 * Entirely device-local, so it works identically on both deployment shapes:
 * a WebAuthn *platform* credential with `userVerification: 'required'` is
 * created when the lock is turned on, and opening the app then has to
 * complete a `credentials.get()` ceremony — which the OS refuses to finish
 * for the wrong finger or face. Nothing is sent anywhere and no signature is
 * checked: what unlocks Piggy is the ceremony succeeding at all. That makes
 * this a privacy latch, not encryption — the book is still readable through
 * devtools by whoever can unlock the phone itself. It keeps a lent phone or
 * a glance over the shoulder out of the tally, which is the ask.
 *
 * The lock is per device and per browser, exactly like the localStorage it
 * lives in, so it is offered from the device-side settings and never syncs.
 */
import { $ } from '../lib/utils';

const LOCK_KEY = 'piggy.lock.v1';

/**
 * Checking a message mid-expense and coming straight back should not demand
 * a face; a phone left on the table should. One minute in the background is
 * the line between the two.
 */
const RELOCK_AFTER_MS = 60_000;

/* The credential id is raw bytes and localStorage keeps strings: base64url,
   the alphabet WebAuthn itself uses on the wire. */
export const toB64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64u = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

interface LockConfig { credId: string }

function readLock(): LockConfig | null {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as LockConfig;
    return cfg && typeof cfg.credId === 'string' && cfg.credId ? cfg : null;
  } catch {
    return null;
  }
}

export const lockEnabled = (): boolean => readLock() !== null;

/**
 * Whether this device can do the prompt at all — answered once, at boot,
 * because the settings sheets render synchronously and cannot await it.
 * Until the probe lands the lock simply isn't offered, which errs the right
 * way: a toggle that appears a beat late beats one that fails when tapped.
 */
let platformAuth = false;

export function initLock(): void {
  try {
    if (typeof PublicKeyCredential !== 'undefined') {
      void PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
        .then((ok) => { platformAuth = ok; })
        .catch(() => { /* stays unavailable */ });
    }
  } catch { /* no WebAuthn here at all */ }

  /* Relock when the app has sat in the background too long. visibilitychange
     rather than pagehide because an installed app is backgrounded far more
     often than it is closed — this is the case that actually happens. */
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > RELOCK_AFTER_MS && lockEnabled()) void lockGate();
    hiddenAt = 0;
  });
}

/**
 * Turn the lock on: mint the credential, which runs the OS prompt right
 * there — so turning it on is also the proof that unlocking will work.
 * False means the device declined or the reader cancelled; nothing is stored.
 */
export async function enableLock(): Promise<boolean> {
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Piggy' },
        /* A random user id: this credential answers "is the device's owner
           present", not "which account is this" — accounts are the server
           build's email codes, and the Pages build has none at all. */
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'piggy', displayName: 'Piggy' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        attestation: 'none',
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    if (!cred) return false;
    localStorage.setItem(LOCK_KEY, JSON.stringify({ credId: toB64u(new Uint8Array(cred.rawId)) }));
    return true;
  } catch {
    return false;
  }
}

/** Reachable only from inside the app, which the lock itself keeps honest. */
export function disableLock(): void {
  try { localStorage.removeItem(LOCK_KEY); } catch { /* nothing to forget */ }
}

async function verify(credId: string): Promise<boolean> {
  try {
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: fromB64u(credId) }],
        userVerification: 'required',
        timeout: 60_000,
      },
    });
    return cred !== null;
  } catch {
    return false;
  }
}

let gate: Promise<void> | null = null;

/**
 * Stand the lock screen in front of everything until the ceremony succeeds.
 * Resolves immediately when the lock is off; boot awaits it first thing, and
 * the relock path just fires it and lets the overlay do the blocking. The
 * overlay is opaque and above every modal, so whatever is painted or still
 * painting underneath shows nothing.
 *
 * The OS prompt is attempted straight away — that is the "open the app, show
 * your face, you're in" feel — and falls back to the Unlock button on the
 * platforms that want a tap first, or after a wrong finger.
 */
export function lockGate(): Promise<void> {
  const cfg = readLock();
  if (!cfg) return Promise.resolve();
  if (gate) return gate;
  gate = new Promise((resolve) => {
    paintLock();
    const attempt = async (): Promise<void> => {
      const btn = $<HTMLButtonElement>('#lockBtn');
      if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
      if (await verify(cfg.credId)) {
        $('#lockScreen')?.remove();
        gate = null;
        resolve();
        return;
      }
      const hint = $('#lockHint');
      if (hint) hint.textContent = "That didn't work — try again.";
      const b = $<HTMLButtonElement>('#lockBtn');
      if (b) { b.disabled = false; b.textContent = '🔓 Unlock'; }
    };
    $('#lockScreen')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('#lockBtn')) void attempt();
    });
    void attempt();
  });
  return gate;
}

/**
 * Its own element with its own click handler, like the install banner and
 * for the same reason: it can be on screen when there is no book for the
 * data-act delegate to act on — and on relock it has to sit above whatever
 * modal was open, still typing into which would defeat the point.
 */
function paintLock(): void {
  if ($('#lockScreen')) return;
  /* A hardware keyboard keeps reaching a focused field under an overlay. */
  (document.activeElement as HTMLElement | null)?.blur?.();
  const el = document.createElement('div');
  el.id = 'lockScreen';
  el.className = 'lock-screen';
  el.innerHTML = '<div class="lock-card"><span class="lock-pig">🐷</span>' +
    '<h2>Piggy is locked</h2>' +
    '<p class="sub" id="lockHint">It opens with your fingerprint or face.</p>' +
    '<button class="btn primary wide" id="lockBtn">🔓 Unlock</button></div>';
  document.body.appendChild(el);
}

/* ---------- the settings section ---------- */

/**
 * The toggle, offered wherever this device's settings live: the bank sheet on
 * the Pages build, "Your account" on the server one. Hidden when the device
 * cannot do the prompt — unless the lock is somehow on anyway, when the off
 * switch must stay reachable.
 */
export function lockSection(): string {
  if (!lockEnabled() && !platformAuth) return '';
  return '<div class="divider"></div>' +
    '<div class="card-head"><h2>🔒 App lock</h2></div>' +
    '<div id="lockBody">' + lockBody() + '</div>';
}

function lockBody(): string {
  return lockEnabled()
    ? '<button class="btn soft wide" data-act="lock-off">Turn off app lock</button>' +
      '<div class="hint">Piggy asks for your fingerprint or face when it opens on this device.</div>'
    : '<button class="btn soft wide" data-act="lock-on">🔒 Lock Piggy behind your fingerprint</button>' +
      '<div class="hint">Piggy will only open with your fingerprint, face or device code. ' +
      "The prompt is your phone's own — nothing about your finger or face ever reaches Piggy. " +
      'It protects this device only; set it on each device you share a screen with.</div>';
}

/** Redraw the toggle in place, so the open sheet's other edits survive. */
export function refreshLockBody(): void {
  const el = $('#lockBody');
  if (el) el.innerHTML = lockBody();
}
