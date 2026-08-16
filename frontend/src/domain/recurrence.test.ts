import { describe, expect, it } from 'vitest';
import { occurrence, ruleHitsMonth } from './recurrence';
import type { Rule } from '../model/types';

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 'r1', ledgerId: 'l1', name: 'Rent', emoji: '🏠', amount: 1500, currency: 'CHF',
  frequency: 'monthly', dueDay: 1, startMonth: '2025-01', endMonth: null,
  accountId: 'acc1', method: 'direct-debit',
  split: { mode: 'equal', participants: [], values: {} },
  active: true, notes: '', createdAt: '2025-01-01T00:00:00Z',
  ...over,
});

describe('ruleHitsMonth', () => {
  it('fires every month for monthly rules within range', () => {
    expect(ruleHitsMonth(rule(), '2025-03')).toBe(true);
    expect(ruleHitsMonth(rule(), '2024-12')).toBe(false);
  });

  it('respects the end month', () => {
    const r = rule({ endMonth: '2025-06' });
    expect(ruleHitsMonth(r, '2025-06')).toBe(true);
    expect(ruleHitsMonth(r, '2025-07')).toBe(false);
  });

  it('steps quarterly from the anchor month', () => {
    const r = rule({ frequency: 'quarterly', startMonth: '2025-02' });
    expect(ruleHitsMonth(r, '2025-02')).toBe(true);
    expect(ruleHitsMonth(r, '2025-03')).toBe(false);
    expect(ruleHitsMonth(r, '2025-05')).toBe(true);
    expect(ruleHitsMonth(r, '2026-02')).toBe(true);
  });

  it('never fires when paused', () => {
    expect(ruleHitsMonth(rule({ active: false }), '2025-03')).toBe(false);
  });
});

describe('occurrence', () => {
  it('clamps the due day to the length of the month', () => {
    const o = occurrence(rule({ dueDay: 31 }), '2025-02');
    expect(o.date).toBe('2025-02-28');
  });

  it('applies an override for that month only', () => {
    const o = occurrence(rule(), '2025-03', {
      id: 'ov1', ruleId: 'r1', period: '2025-03', amount: 1600, skipped: true,
    });
    expect(o.amount).toBe(1600);
    expect(o.skipped).toBe(true);
  });

  it('keeps the rule values without an override', () => {
    const o = occurrence(rule(), '2025-03');
    expect(o.amount).toBe(1500);
    expect(o.skipped).toBe(false);
    expect(o.id).toBe('r1|2025-03');
  });
});
