/**
 * Who is signed in, and which deployment we booted into.
 *
 * Its own module, with no imports, so both the sign-in screen and the
 * settings modal can read it without importing each other.
 */
import type { AuthUser } from '../storage/api';

export interface Session {
  /** 'local' = the Pages build (no backend answered); 'server' = self-hosted. */
  mode: 'local' | 'server';
  user: AuthUser | null;
}

export const session: Session = { mode: 'local', user: null };

export const onServer = (): boolean => session.mode === 'server';
