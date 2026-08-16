import { describe, expect, it } from 'vitest';
import { splitCents } from './splits';

const PEOPLE = ['a', 'b'];

describe('splitCents', () => {
  it('splits evenly and gives the remainder cent to the last participant', () => {
    expect(splitCents({ mode: 'equal', participants: ['a', 'b'], values: {} }, 1001, PEOPLE))
      .toEqual({ a: 501, b: 500 });
  });

  it('defaults to everyone when participants are empty', () => {
    expect(splitCents({ mode: 'equal', participants: [], values: {} }, 1000, PEOPLE))
      .toEqual({ a: 500, b: 500 });
    expect(splitCents(null, 1000, PEOPLE)).toEqual({ a: 500, b: 500 });
  });

  it('ignores participants that no longer exist', () => {
    expect(splitCents({ mode: 'equal', participants: ['a', 'ghost'], values: {} }, 1000, PEOPLE))
      .toEqual({ a: 1000 });
  });

  it('weights by shares', () => {
    expect(splitCents({ mode: 'shares', participants: ['a', 'b'], values: { a: 2, b: 1 } }, 900, PEOPLE))
      .toEqual({ a: 600, b: 300 });
  });

  it('always distributes the exact total in shares mode', () => {
    const out = splitCents({ mode: 'shares', participants: ['a', 'b'], values: { a: 1, b: 2 } }, 1000, PEOPLE);
    expect(out.a + out.b).toBe(1000);
  });

  it('falls back to even when all shares are zero', () => {
    expect(splitCents({ mode: 'shares', participants: ['a', 'b'], values: {} }, 1000, PEOPLE))
      .toEqual({ a: 500, b: 500 });
  });

  it('uses exact amounts and puts rounding drift on the first participant', () => {
    expect(splitCents({ mode: 'exact', participants: ['a', 'b'], values: { a: 3, b: 6 } }, 1000, PEOPLE))
      .toEqual({ a: 400, b: 600 });
  });
});
