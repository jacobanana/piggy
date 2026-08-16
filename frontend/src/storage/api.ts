/**
 * The backend client — only ever reached on the self-hosted deployment.
 *
 * On GitHub Pages `detectBackend()` answers false (nothing serves
 * /api/health) and nothing else in this module is ever called, so the Pages
 * build keeps its localStorage-only behaviour. Every path here is relative to
 * `document.baseURI`, so the same bundle works at the site root, under
 * /piggy/, or behind any reverse-proxy prefix.
 */
import type { AppState } from '../model/types';

const TOKENS_KEY = 'piggy.auth.v1';
const PROBE_TIMEOUT_MS = 3000;

const API_BASE = new URL('api/', document.baseURI).toString();
const url = (path: string): string => API_BASE + path;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface CodeRequested {
  verificationId: string;
  expiresAt: string;
}

interface Tokens { access: string; refresh: string }

/** A backend call that came back with something other than 2xx. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/* ---------- token storage ---------- */

let tokens: Tokens | null | undefined;   // undefined = not read from disk yet

function currentTokens(): Tokens | null {
  if (tokens === undefined) {
    try {
      const raw = localStorage.getItem(TOKENS_KEY);
      const t = raw ? (JSON.parse(raw) as Partial<Tokens>) : null;
      tokens = t && t.access && t.refresh ? { access: t.access, refresh: t.refresh } : null;
    } catch {
      tokens = null;
    }
  }
  return tokens;
}

function setTokens(t: Tokens | null): void {
  tokens = t;
  try {
    if (t) localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
    else localStorage.removeItem(TOKENS_KEY);
  } catch { /* private mode: the session simply won't survive a reload */ }
}

export const hasSession = (): boolean => currentTokens() !== null;
export const signOut = (): void => setTokens(null);

/* ---------- plumbing ---------- */

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string; name: string; role: string };
}

async function detailOf(res: Response, fallback: string): Promise<string> {
  try {
    const j = (await res.json()) as { detail?: unknown };
    return typeof j.detail === 'string' ? j.detail : fallback;
  } catch {
    return fallback;
  }
}

/** Swap the refresh token for a fresh pair. Clears the session when it fails. */
async function refreshSession(): Promise<boolean> {
  const t = currentTokens();
  if (!t) return false;
  try {
    const res = await fetch(url('auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: t.refresh }),
    });
    if (!res.ok) { setTokens(null); return false; }
    const j = (await res.json()) as TokenResponse;
    setTokens({ access: j.access_token, refresh: j.refresh_token });
    return true;
  } catch {
    return false;   // network blip, not a bad token — keep what we have
  }
}

/**
 * An authenticated call. A 401 buys exactly one refresh-and-retry; if that
 * fails the session is dropped and the caller sees a 401 ApiError.
 */
async function authed(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const t = currentTokens();
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (t) headers.set('Authorization', 'Bearer ' + t.access);
  const res = await fetch(url(path), { ...init, headers });
  if (res.status === 401 && retry && t && (await refreshSession())) {
    return authed(path, init, false);
  }
  if (res.status === 401) setTokens(null);
  return res;
}

async function json<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) throw new ApiError(res.status, await detailOf(res, fallback));
  return (await res.json()) as T;
}

/* ---------- public calls ---------- */

/**
 * Is a Piggy backend serving this page? One unauthenticated GET, short
 * timeout, and any non-JSON answer (a static host's 404 page) counts as no.
 */
export async function detectBackend(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url('health'), { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return false;
    const j = (await res.json()) as { status?: string };
    return j.status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Who the stored token belongs to, or null if it no longer signs anyone in. */
export async function whoami(): Promise<AuthUser | null> {
  if (!hasSession()) return null;
  try {
    const res = await authed('auth/me');
    if (!res.ok) return null;
    return (await res.json()) as AuthUser;
  } catch {
    return null;
  }
}

export async function requestCode(email: string): Promise<CodeRequested> {
  const res = await fetch(url('auth/code/request'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const j = await json<{ verification_id: string; expires_at: string }>(res, "Couldn't send a code.");
  return { verificationId: j.verification_id, expiresAt: j.expires_at };
}

export async function verifyCode(verificationId: string, code: string): Promise<AuthUser> {
  const res = await fetch(url('auth/code/verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verification_id: verificationId, code }),
  });
  const j = await json<TokenResponse>(res, 'That code did not work.');
  setTokens({ access: j.access_token, refresh: j.refresh_token });
  return j.user;
}

export async function getBook(): Promise<AppState> {
  return json<AppState>(await authed('book'), "Couldn't load your book.");
}

export async function putBook(state: AppState): Promise<AppState> {
  const res = await authed('book', { method: 'PUT', body: JSON.stringify(state) });
  return json<AppState>(res, "Couldn't save your book.");
}
