import { beforeEach, describe, expect, it } from 'vitest';
import { faceForName, profile, session } from './session';
import type { AuthUser } from '../storage/api';

const signedIn = (name: string, emoji: string): AuthUser =>
  ({ id: 'u1', email: 'lea@example.com', name, emoji, role: 'member' });

beforeEach(() => { session.user = null; session.book = null; session.mode = 'local'; });

/**
 * The profile is what a brand-new piggy bank starts its first person from, so
 * the rule that decides "this person is the reader" is worth pinning down.
 * Getting it wrong in the generous direction links somebody's account to a
 * person that is not them — every expense they enter then lands on the wrong
 * side of the tally, and nobody is ever asked to confirm it.
 */
describe('faceForName', () => {
  it('is nothing at all with no account (the Pages build)', () => {
    expect(profile()).toBeNull();
    expect(faceForName('Léa')).toBeNull();
  });

  it('hands back the profile face for the profile name', () => {
    session.user = signedIn('Léa', '🦊');
    expect(faceForName('Léa')).toBe('🦊');
    expect(faceForName('  Léa  ')).toBe('🦊');
  });

  it('refuses a name typed over the prefilled one', () => {
    session.user = signedIn('Léa', '🦊');
    expect(faceForName('Marc')).toBeNull();
    expect(faceForName('')).toBeNull();
  });

  it('refuses a nameless profile rather than matching an empty box', () => {
    session.user = signedIn('', '🦊');
    expect(faceForName('')).toBeNull();
  });
});
