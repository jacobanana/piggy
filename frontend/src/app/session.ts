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

/**
 * The signed-in account's profile: the name and face that belong to the
 * person rather than to a piggy bank, and that a brand-new book starts its
 * first person from. Null on the Pages build, where there is no account —
 * onboarding there asks for a name the way it always has.
 */
export const profile = (): { name: string; emoji: string } | null =>
  session.user ? { name: session.user.name, emoji: session.user.emoji } : null;

/**
 * The profile's face, if a person about to be created under `name` is the
 * signed-in reader — that is, if the name is still the profile's own.
 *
 * Null is "somebody else": the box was prefilled with your name and typed
 * over, so the profile face would be a lie and the account must not be linked
 * to that person without asking.
 */
export function faceForName(name: string): string | null {
  const me = profile();
  return me && me.name && name.trim() === me.name.trim() ? me.emoji : null;
}

/**
 * The open book's name is held twice: `session.book.name`, which the switcher
 * and the share sheet read, and `meta.appName` in the state, which is the same
 * field on the wire — the sync endpoint writes it straight to `Book.name`.
 * Whenever one moves the other has to follow, or the share sheet keeps
 * offering an invite to a bank under a name nobody sees any more.
 */
export function syncBookName(appName: string): void {
  if (session.book && appName) session.book.name = appName;
}
/** Which person in the open book is the signed-in user, if they've said. */
export const myPersonId = (): string | null => session.book?.personId ?? null;

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
