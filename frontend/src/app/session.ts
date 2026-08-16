/**
 * Who is signed in, which deployment we booted into, and which piggy bank is
 * open.
 *
 * Its own module, with no imports beyond types, so the sign-in screen, the
 * sharing sheet and the settings modal can all read it without importing
 * each other.
 */
import type { AuthUser, BookSummary } from '../storage/api';

export interface Session {
  /** 'local' = the Pages build (no backend answered); 'server' = self-hosted. */
  mode: 'local' | 'server';
  user: AuthUser | null;
  /** The book currently on screen, when there is a backend. */
  book: BookSummary | null;
}

export const session: Session = { mode: 'local', user: null, book: null };

export const onServer = (): boolean => session.mode === 'server';
export const isOwner = (): boolean => session.book?.role === 'owner';

/** Which book to reopen on the next visit. */
const LAST_BOOK_KEY = 'piggy.book.v1';

export function rememberBook(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_BOOK_KEY, id);
    else localStorage.removeItem(LAST_BOOK_KEY);
  } catch { /* private mode: we just reopen the first book instead */ }
}

export function lastBook(): string | null {
  try { return localStorage.getItem(LAST_BOOK_KEY); } catch { return null; }
}
