import { describe, expect, it } from 'vitest';
import { defaultAccountId } from './selectors';
import type { Account } from '../model/types';

const acc = (id: string, kind: Account['kind'], ownership: Record<string, number>): Account =>
  ({ id, name: id, kind, ownership });

const ANA = acc('acc_ana', 'personal', { ana: 1 });
const BEN = acc('acc_ben', 'personal', { ben: 1 });
const JOINT = acc('acc_joint', 'joint', { ana: 0.5, ben: 0.5 });

describe('defaultAccountId', () => {
  it('picks the signed-in person\'s own account, not the first one', () => {
    expect(defaultAccountId([ANA, BEN, JOINT], 'ben')).toBe('acc_ben');
  });

  it('falls back to the first account when nobody is signed in', () => {
    expect(defaultAccountId([ANA, BEN, JOINT], null)).toBe('acc_ana');
  });

  it('falls back to the first account when the person owns nothing', () => {
    expect(defaultAccountId([ANA, BEN, JOINT], 'cleo')).toBe('acc_ana');
  });

  it('prefers a personal account over a joint one the person shares', () => {
    expect(defaultAccountId([JOINT, BEN], 'ben')).toBe('acc_ben');
  });

  it('takes a joint account when the person has no personal one', () => {
    expect(defaultAccountId([ANA, JOINT], 'ben')).toBe('acc_joint');
  });

  it('ignores a zero share', () => {
    expect(defaultAccountId([ANA, acc('acc_x', 'joint', { ben: 0 })], 'ben')).toBe('acc_ana');
  });

  it('survives an empty book', () => {
    expect(defaultAccountId([], 'ben')).toBeUndefined();
  });
});
