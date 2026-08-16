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

/**
 * Which book to reopen on the next visit, remembered per account: two people
 * sharing a phone must not inherit each other's, and signing out must not
 * lose it — coming back to the wrong piggy bank files your expenses where
 * nobody you share with can see them.
 */
const LAST_BOOK_KEY = 'piggy.book.v1';

const bookKey = (): string => (session.user ? LAST_BOOK_KEY + '.' + session.user.id : LAST_BOOK_KEY);

export function rememberBook(id: string | null): void {
  try {
    if (id) localStorage.setItem(bookKey(), id);
    else localStorage.removeItem(bookKey());
  } catch { /* private mode: we just ask which book instead */ }
}

export function lastBook(): string | null {
  try {
    // The unkeyed value is what installs from before per-account memory left
    // behind; it is still the right book for whoever is signed in there.
    return localStorage.getItem(bookKey()) ?? localStorage.getItem(LAST_BOOK_KEY);
  } catch {
    return null;
  }
}
