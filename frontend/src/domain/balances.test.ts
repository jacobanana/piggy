import { describe, expect, it } from 'vitest';
import { computeBalances, pairwiseDebt, settledItemIds, settlementsFor, simplifyDebts, spendSummary } from './balances';
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

describe('settledItemIds', () => {
  it('gathers the items every repayment in the ledger was logged against', () => {
    const s = fixture();
    s.settlements = [
      settlement({ id: 's1', itemIds: ['e1', 'rule-rent|2025-03'] }),
      settlement({ id: 's2', itemIds: ['e2'] }),
    ];
    expect([...settledItemIds(s, 'home')].sort()).toEqual(['e1', 'e2', 'rule-rent|2025-03']);
  });

  it('leaves the repayment being edited out, so its own items stay pickable', () => {
    const s = fixture();
    s.settlements = [settlement({ id: 's1', itemIds: ['e1'] }), settlement({ id: 's2', itemIds: ['e2'] })];
    expect([...settledItemIds(s, 'home', 's1')]).toEqual(['e2']);
  });

  it('ignores repayments belonging to another ledger', () => {
    const s = fixture();
    s.settlements = [settlement({ ledgerId: 'trip', itemIds: ['e1'] })];
    expect([...settledItemIds(s, 'home')]).toEqual([]);
  });

  it('is empty when nothing was ticked', () => {
    const s = fixture();
    s.settlements = [settlement({})];
    expect([...settledItemIds(s, 'home')]).toEqual([]);
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

describe('spendSummary', () => {
  /** One person, one personal account — the book the tally is useless on. */
  function solo(): AppState {
    const s = fixture();
    s.people = [{ id: 'lea', name: 'Léa', emoji: '🐰', color: '#111' }];
    s.accounts = [{ id: 'acc-lea', name: "Léa's money", kind: 'personal', ownership: { lea: 1 } }];
    return s;
  }

  it('adds up the whole ledger, whatever month is on screen', () => {
    const s = solo();
    s.expenses = [
      expense({ id: 'e1', amount: 100, date: '2025-03-10' }),
      expense({ id: 'e2', amount: 40, date: '2025-05-02' }),
    ];
    const sum = spendSummary(s, 'home', '2025-05');
    expect(sum.total).toBe(14000);
    expect(sum.month).toBe(4000);
    expect(sum.count).toBe(2);
  });

  it('spreads the total over the months it was spent in, ends included', () => {
    const s = solo();
    s.expenses = [
      expense({ id: 'e1', amount: 100, date: '2025-03-10' }),
      expense({ id: 'e2', amount: 200, date: '2025-05-02' }),
    ];
    const sum = spendSummary(s, 'home', '2025-05');
    expect(sum.span).toBe(3);          // March, April, May
    expect(sum.perMonth).toBe(10000);
    expect(sum.since).toBe('2025-03');
  });

  /* A quiet ledger must not divide by zero, and an untouched one is not
     "0 a month across 0 months" — it is simply nothing yet. */
  it('survives a ledger with nothing on it', () => {
    const sum = spendSummary(solo(), 'home', '2025-05');
    expect(sum).toMatchObject({ total: 0, month: 0, count: 0, span: 1, perMonth: 0, since: null });
  });

  it('keeps planned money out of the spend and counts it on its own', () => {
    const s = solo();
    s.expenses = [
      expense({ id: 'e1', amount: 100, date: '2025-03-10' }),
      expense({ id: 'e2', amount: 60, date: '2025-03-20', planned: true }),
    ];
    const sum = spendSummary(s, 'home', '2025-03');
    expect(sum.total).toBe(10000);
    expect(sum.month).toBe(10000);
    expect(sum.count).toBe(1);
    expect(sum.planned).toBe(6000);
  });

  it('converts foreign spending at the rate the entry snapshotted', () => {
    const s = solo();
    s.expenses = [expense({ amount: 100, currency: 'EUR', fxRate: 0.95, date: '2025-03-10' })];
    expect(spendSummary(s, 'home', '2025-03').total).toBe(9500);
  });

  it('has no month figure when the scope has none — a trip', () => {
    const s = solo();
    s.expenses = [expense({ amount: 100, date: '2025-03-10' })];
    const sum = spendSummary(s, 'home', null);
    expect(sum.total).toBe(10000);
    expect(sum.month).toBe(0);
  });
});
