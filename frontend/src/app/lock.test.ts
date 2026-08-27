import { describe, expect, it } from 'vitest';
import { fromB64u, toB64u } from './lock';

/**
 * The credential id round-trips through localStorage as base64url. Worth a
 * test rather than an eye because a wrong alphabet or a kept padding sign
 * fails invisibly here — the stored id simply never matches the one the
 * authenticator minted, and the lock screen turns into a door with no key.
 */
describe('credential id round-trip', () => {
  it('keeps every byte, including the ones base64 proper would encode as + and /', () => {
    // 0xfb 0xef 0xff... force '+' and '/' in plain base64; 62/63 must map to -_
    const bytes = new Uint8Array([0, 1, 2, 251, 239, 255, 62, 63, 128, 254]);
    expect(fromB64u(toB64u(bytes))).toEqual(bytes);
  });

  it('emits no padding and only URL-safe characters', () => {
    for (const len of [1, 2, 3, 16, 32]) {
      const bytes = new Uint8Array(Array.from({ length: len }, (_, i) => (i * 89 + 200) % 256));
      const s = toB64u(bytes);
      expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(fromB64u(s)).toEqual(bytes);
    }
  });

  it('reads the id WebAuthn itself would base64url-encode', () => {
    // "Piggy!!" — base64 "UGlnZ3khIQ==" — must come back from its url form.
    expect(Array.from(fromB64u('UGlnZ3khIQ'))).toEqual([80, 105, 103, 103, 121, 33, 33]);
  });
});
