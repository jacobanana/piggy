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

/**
 * The account, and the profile that rides along with it: `name` and `emoji`
 * belong to the person rather than to any one piggy bank, which is what lets
 * a brand-new book prefill its first person from them.
 */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emoji: string;
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
  user: Partial<AuthUser> & { id: string; email: string };
}

/** The face an account wears until its owner picks another. Mirrors the backend. */
export const DEFAULT_FACE = '🙂';

/** A user row off the wire, with the profile bits an older server may omit. */
const asUser = (u: Partial<AuthUser> & { id: string; email: string }): AuthUser => ({
  id: u.id,
  email: u.email,
  name: u.name || u.email.split('@')[0],
  emoji: u.emoji || DEFAULT_FACE,
  role: u.role || 'member',
});

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
 * The last answer this browser got at this address, so an unreachable server
 * is not mistaken for one that was never there.
 *
 * Only written when something actually answered. Before the app could open
 * offline the distinction did not exist — a failed probe meant the page had not
 * loaded either — but an installed app opens on a train, and a probe that
 * timed out used to read as "no backend" and drop a signed-in reader into the
 * localStorage build. That is not a cosmetic wrong: it is a *different, empty
 * book*, and expenses typed into it are filed where nobody they share with will
 * ever see them.
 */
const BACKEND_KEY = 'piggy.backend.v1';

function rememberBackend(present: boolean): boolean {
  try {
    localStorage.setItem(BACKEND_KEY, present ? '1' : '0');
  } catch { /* private mode: we simply probe again next time */ }
  return present;
}

function recallBackend(): boolean {
  try {
    return localStorage.getItem(BACKEND_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Is a Piggy backend serving this page? One unauthenticated GET, short
 * timeout, and any non-JSON answer (a static host's 404 page) counts as no.
 *
 * The two failure modes are answered differently, which is the whole point:
 * something that replies and is not Piggy is a definitive no, and is
 * remembered as one; nothing replying at all is not an answer, so the last
 * definitive one stands.
 */
export async function detectBackend(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url('health'), { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    } catch {
      return recallBackend();   // offline, or timed out — not a verdict
    }
    if (!res.ok) return rememberBackend(false);
    try {
      const j = (await res.json()) as { status?: string; openSignup?: boolean };
      signupOpen = j.openSignup === true;
      return rememberBackend(j.status === 'ok');
    } catch {
      return rememberBackend(false);   // answered, but it is not us
    }
  } finally {
    clearTimeout(timer);
  }
}

/* Whether this deployment takes new accounts. Answered by the same probe
   that found the backend, so the home page never offers a shut door — and
   stays false on Pages, where there is no backend to ask. */
let signupOpen = false;
export const signupIsOpen = (): boolean => signupOpen;

/** Make an account and start the same email round trip signing in uses. */
export async function signUp(email: string, name: string): Promise<CodeRequested> {
  const res = await fetch(url('auth/signup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name }),
  });
  const j = await json<{ verification_id: string; expires_at: string }>(res, "Couldn't make that account.");
  return { verificationId: j.verification_id, expiresAt: j.expires_at };
}

/** Who the stored token belongs to, or null if it no longer signs anyone in. */
/**
 * Nobody turned us away — we could not ask. Told apart from `null` because the
 * two want opposite screens: a rejected session belongs at the sign-in form, and
 * an unreachable server belongs behind a "try again", with the session left
 * exactly where it was.
 */
export const OFFLINE = 'offline';

export async function whoami(): Promise<AuthUser | typeof OFFLINE | null> {
  if (!hasSession()) return null;
  let res: Response;
  try {
    res = await authed('auth/me');
  } catch {
    return OFFLINE;
  }
  if (!res.ok) return null;
  try {
    return asUser((await res.json()) as AuthUser);
  } catch {
    return null;
  }
}

/**
 * Change your own name or face. It is the profile, not this book's person —
 * every piggy bank you make from here on starts you off with it.
 */
export const updateProfile = async (patch: { name?: string; emoji?: string }): Promise<AuthUser> =>
  asUser(
    await json<AuthUser>(
      await authed('auth/me', { method: 'PATCH', body: JSON.stringify(patch) }),
      "Couldn't save your profile.",
    ),
  );

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
  return asUser(j.user);
}

/* ---------- books ---------- */

/**
 * A book and the version it was at. The version rides in the ETag rather
 * than the body so the body stays byte-identical to AppState — that shape is
 * shared with localStorage and the export files.
 */
export interface VersionedBook { state: AppState; version: number | null }

function etag(res: Response): number | null {
  const raw = res.headers.get('ETag');
  if (!raw) return null;
  const n = Number(raw.replace(/^W\//, '').replace(/"/g, ''));
  return Number.isFinite(n) ? n : null;
}

export async function getBook(bookId: string | null): Promise<VersionedBook> {
  const res = await authed(bookId ? `books/${bookId}` : 'book');
  const state = await json<AppState>(res, "Couldn't load your book.");
  return { state, version: etag(res) };
}

export async function putBook(
  bookId: string | null,
  state: AppState,
  baseVersion: number | null,
): Promise<VersionedBook> {
  const res = await authed(bookId ? `books/${bookId}` : 'book', {
    method: 'PUT',
    body: JSON.stringify(state),
    headers: baseVersion === null ? undefined : { 'If-Match': `"${baseVersion}"` },
  });
  const merged = await json<AppState>(res, "Couldn't save your book.");
  return { state: merged, version: etag(res) };
}

export interface BookSummary {
  id: string;
  name: string;
  role: 'owner' | 'member';
  members: number;
  /** How many members own it — a book keeps one, so its only owner can't leave. */
  owners: number;
  personId: string | null;
}

export const listBooks = async (): Promise<BookSummary[]> =>
  json<BookSummary[]>(await authed('books'), "Couldn't list your piggy banks.");

export const createBook = async (name: string): Promise<BookSummary> =>
  json<BookSummary>(
    await authed('books', { method: 'POST', body: JSON.stringify({ name }) }),
    "Couldn't create that piggy bank.",
  );

/** Erase a piggy bank and everything in it, for everyone in it. Owners only. */
export async function deleteBook(bookId: string): Promise<void> {
  const res = await authed(`books/${bookId}`, { method: 'DELETE' });
  if (!res.ok) throw new ApiError(res.status, await detailOf(res, "Couldn't delete that piggy bank."));
}

/* ---------- members ---------- */

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: 'owner' | 'member';
  personId: string | null;
  isMe: boolean;
}

export const listMembers = async (bookId: string): Promise<Member[]> =>
  json<Member[]>(await authed(`books/${bookId}/members`), "Couldn't list the members.");

export const claimPerson = async (bookId: string, personId: string | null): Promise<Member> =>
  json<Member>(
    await authed(`books/${bookId}/members/me/person`, { method: 'PUT', body: JSON.stringify({ personId }) }),
    "Couldn't link you to that person.",
  );

export async function removeMember(bookId: string, userId: string): Promise<void> {
  const res = await authed(`books/${bookId}/members/${userId}`, { method: 'DELETE' });
  if (!res.ok) throw new ApiError(res.status, await detailOf(res, "Couldn't remove them."));
}

/* ---------- the invite link ---------- */

/** A piggy bank has one link, and it opens that piggy bank and no other. */
export interface Invite { id: string; code: string; expiresAt: string }

export const getInvite = async (bookId: string): Promise<Invite | null> =>
  json<Invite | null>(await authed(`books/${bookId}/invite`), "Couldn't fetch the invite link.");

/** Idempotent: hands back the live link if there is one, so a link already
    sent stays the one that works. */
export const createInvite = async (bookId: string): Promise<Invite> =>
  json<Invite>(await authed(`books/${bookId}/invite`, { method: 'POST' }), "Couldn't make an invite link.");

export async function revokeInvite(bookId: string): Promise<void> {
  const res = await authed(`books/${bookId}/invite`, { method: 'DELETE' });
  if (!res.ok) throw new ApiError(res.status, await detailOf(res, "Couldn't revoke that link."));
}

export interface InvitePreview { code: string; bookName: string; members: number; alreadyMember: boolean }

export const previewInvite = async (code: string): Promise<InvitePreview> =>
  json<InvitePreview>(await authed(`invites/${encodeURIComponent(code)}`), "That invite didn't work.");

/**
 * Sign in against an invite code, making the account if this is a first
 * visit. The only way into Piggy without an admin running `manage create`,
 * and it needs a live code — so it is the invited person's front door.
 */
export async function claimInvite(code: string, email: string): Promise<CodeRequested> {
  const res = await fetch(url(`invites/${encodeURIComponent(code)}/claim`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const j = await json<{ verification_id: string; expires_at: string }>(res, "That invite code didn't work.");
  return { verificationId: j.verification_id, expiresAt: j.expires_at };
}

export const acceptInvite = async (code: string): Promise<BookSummary> =>
  json<BookSummary>(
    await authed(`invites/${encodeURIComponent(code)}/accept`, { method: 'POST' }),
    "Couldn't join that piggy bank.",
  );

/** The link you actually send someone. */
export const inviteUrl = (code: string): string =>
  location.origin + location.pathname + '?join=' + code;
