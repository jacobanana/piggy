import { describe, expect, it } from 'vitest';
import { computeBalances, pairwiseDebt, settlementsFor, simplifyDebts } from './balances';
import { blankState } from '../model/state';
import type { AppState, Expense, Settlement } from '../model/types';

/** Two people, personal accounts, and a 50/50 joint account. */
function fixture(): AppState {
  const s = blankState();
  s.people = [
    { id: 'lea', name: 'Léa', emoji: '🐰', color: '#111' },
    { id: 'marc', name: 'Marc', emoji: '🦊', color: '#222' },
  ];
  s.accounts = [
    { id: 'acc-lea', name: "Léa's money", kind: 'personal', ownership: { lea: 1 } },
    { id: 'acc-marc', name: "Marc's money", kind: 'personal', ownership: { marc: 1 } },
    { id: 'acc-joint', name: 'Joint', kind: 'joint', ownership: { lea: 0.5, marc: 0.5 } },
  ];
  s.ledgers = [{
    id: 'home', name: 'Home', emoji: '🏠', kind: 'household', currency: 'CHF',
    archived: false, createdAt: '2025-01-01T00:00:00Z',
  }];
  return s;
}

const expense = (over: Partial<Expense>): Expense => ({
  id: 'e1', ledgerId: 'home', name: 'Groceries', emoji: '🛒', amount: 100, currency: 'CHF',
  fxRate: 1, date: '2025-03-10', accountId: 'acc-lea', method: 'card', planned: false,
  split: { mode: 'equal', participants: [], values: {} }, notes: '', createdAt: '2025-03-10T00:00:00Z',
  ...over,
});

/** Marc handing Léa 50 — exactly half of the fixture's 100 expense. */
const settlement = (over: Partial<Settlement>): Settlement => ({
  id: 's1', ledgerId: 'home', date: '2025-03-15', fromPersonId: 'marc', toPersonId: 'lea',
  amount: 50, currency: 'CHF', fxRate: 1, method: 'cash', note: '', createdAt: '2025-03-15T00:00:00Z',
  ...over,
});

describe('computeBalances', () => {
  it('credits the payer and debits everyone their share', () => {
    const s = fixture();
    s.expenses = [expense({})];   // Léa pays 100, split evenly
    const bal = computeBalances(s, 'home');
    expect(bal.lea).toBe(5000);   // paid 10000, owes 5000
    expect(bal.marc).toBe(-5000);
  });

  it('keeps joint-account spending square when split evenly', () => {
    const s = fixture();
    s.expenses = [expense({ accountId: 'acc-joint' })];
    const bal = computeBalances(s, 'home');
    expect(bal.lea).toBe(0);
    expect(bal.marc).toBe(0);
  });

  it('leaves planned expenses out of the tally', () => {
    const s = fixture();
    s.expenses = [expense({ planned: true })];
    const bal = computeBalances(s, 'home');
    expect(bal.lea).toBe(0);
    expect(bal.marc).toBe(0);
  });

  it('converts foreign amounts through the snapshotted rate', () => {
    const s = fixture();
    s.expenses = [expense({ amount: 100, currency: 'EUR', fxRate: 0.9 })];
    const bal = computeBalances(s, 'home');
    expect(bal.lea).toBe(4500);
    expect(bal.marc).toBe(-4500);
  });

  it('cancels debts with settlements', () => {
    const s = fixture();
    s.expenses = [expense({})];
    s.settlements = [settlement({})];
    const bal = computeBalances(s, 'home');
    expect(bal.lea).toBe(0);
    expect(bal.marc).toBe(0);
  });

  it('carries on across months rather than resetting each one', () => {
    const s = fixture();
    s.expenses = [expense({}), expense({ id: 'e2', date: '2025-04-02' })];
    expect(computeBalances(s, 'home').marc).toBe(-10000);
  });

  /* The whole point of one running tally: money handed over in July for
     August's expenses is still money handed over. */
  it('counts a repayment made before the expenses it was for', () => {
    const s = fixture();
    s.expenses = [expense({ id: 'e-aug', date: '2025-08-04' })];
    s.settlements = [settlement({ date: '2025-07-28' })];
    expect(computeBalances(s, 'home').marc).toBe(0);
    expect(computeBalances(s, 'home').lea).toBe(0);
  });

  it('leaves a prepayment sitting as credit until the expense lands', () => {
    const s = fixture();
    s.settlements = [settlement({ date: '2025-07-28' })];
    expect(computeBalances(s, 'home').marc).toBe(5000);
    expect(computeBalances(s, 'home').lea).toBe(-5000);
  });
});

describe('settlementsFor', () => {
  it('returns every repayment in the ledger, newest first', () => {
    const s = fixture();
    s.settlements = [
      settlement({ id: 's-jul', date: '2025-07-28' }),
      settlement({ id: 's-sep', date: '2025-09-02' }),
      settlement({ id: 's-aug', date: '2025-08-15' }),
    ];
    expect(settlementsFor(s, 'home').map((x) => x.id)).toEqual(['s-sep', 's-aug', 's-jul']);
  });

  it('ignores repayments belonging to another ledger', () => {
    const s = fixture();
    s.settlements = [settlement({}), settlement({ id: 's2', ledgerId: 'trip' })];
    expect(settlementsFor(s, 'home').map((x) => x.id)).toEqual(['s1']);
  });
});

describe('pairwiseDebt', () => {
  const item = (over: Partial<Expense>) => ({ ...expense(over), kind: 'adhoc' as const });

  it('is the other side\'s share of an expense one person paid', () => {
    const s = fixture();
    expect(pairwiseDebt(s, item({}), 'marc', 'lea')).toBe(5000);
  });

  it('owes nothing back the other way', () => {
    const s = fixture();
    expect(pairwiseDebt(s, item({}), 'lea', 'marc')).toBe(0);
  });

  it('follows the split rather than the total', () => {
    const s = fixture();
    const it = item({ split: { mode: 'shares', participants: ['lea', 'marc'], values: { lea: 3, marc: 1 } } });
    expect(pairwiseDebt(s, it, 'marc', 'lea')).toBe(2500);
  });

  it('is nil when a joint account paid an even split', () => {
    const s = fixture();
    expect(pairwiseDebt(s, item({ accountId: 'acc-joint' }), 'marc', 'lea')).toBe(0);
  });

  it('converts through the snapshotted rate', () => {
    const s = fixture();
    expect(pairwiseDebt(s, item({ amount: 100, currency: 'EUR', fxRate: 0.9 }), 'marc', 'lea')).toBe(4500);
  });

  it('adds up to the tally over a month of items', () => {
    const s = fixture();
    s.expenses = [expense({}), expense({ id: 'e2', accountId: 'acc-marc', amount: 40 })];
    const owed = s.expenses.reduce(
      (sum, e) => sum + pairwiseDebt(s, { ...e, kind: 'adhoc' }, 'marc', 'lea')
        - pairwiseDebt(s, { ...e, kind: 'adhoc' }, 'lea', 'marc'),
      0,
    );
    expect(owed).toBe(-computeBalances(s, 'home').marc);
  });
});

describe('simplifyDebts', () => {
  it('produces one transfer for a two-person imbalance', () => {
    expect(simplifyDebts({ lea: 5000, marc: -5000 }))
      .toEqual([{ from: 'marc', to: 'lea', cents: 5000 }]);
  });

  it('ignores sub-cent noise', () => {
    expect(simplifyDebts({ lea: 1, marc: -1 })).toEqual([]);
  });

  it('settles three people with the fewest transfers', () => {
    const out = simplifyDebts({ a: 6000, b: -4000, c: -2000 });
    expect(out).toEqual([
      { from: 'b', to: 'a', cents: 4000 },
      { from: 'c', to: 'a', cents: 2000 },
    ]);
  });
});
