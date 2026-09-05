import { describe, expect, it } from 'vitest';
import { computeBalances, monthTally, monthlyBalances, pairwiseDebt, repaymentPicks, settlementsFor, settlementsInMonth, simplifyDebts, spendSummary } from './balances';
import type { RepayPick } from './balances';
import { REPAY_AHEAD } from './selectors';
import { blankState } from '../model/state';
import { addMonths, thisMonth } from '../lib/utils';
import type { AppState, Expense, Rule, Settlement } from '../model/types';

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

/** A monthly bill Léa's account pays, split evenly. */
const rentRule = (): Rule => ({
  id: 'rule-rent', ledgerId: 'home', name: 'Rent', emoji: '🏠', amount: 1200, currency: 'CHF',
  frequency: 'monthly', dueDay: 1, startMonth: '2025-01', endMonth: null, accountId: 'acc-lea',
  method: 'transfer', split: { mode: 'equal', participants: [], values: {} }, active: true,
  notes: '', createdAt: '2025-01-01T00:00:00Z',
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

describe('monthlyBalances', () => {
  /** What every month adds up to, person by person — the sum the cut must keep. */
  const summed = (s: AppState): Record<string, number> => {
    const out: Record<string, number> = { lea: 0, marc: 0 };
    monthlyBalances(s, 'home').forEach((t) => {
      out.lea += t.balances.lea;
      out.marc += t.balances.marc;
    });
    return out;
  };

  it('files each month under itself instead of running one figure on', () => {
    const s = fixture();
    s.expenses = [expense({}), expense({ id: 'e2', date: '2025-04-02', amount: 40 })];
    const months = monthlyBalances(s, 'home');
    expect(months.map((t) => t.month)).toEqual(['2025-03', '2025-04']);
    expect(months[0].balances.marc).toBe(-5000);
    expect(months[1].balances.marc).toBe(-2000);
  });

  it('adds back up to the running tally', () => {
    const s = fixture();
    s.expenses = [expense({}), expense({ id: 'e2', date: '2025-04-02', amount: 40 })];
    s.settlements = [settlement({ amount: 30 })];
    expect(summed(s)).toEqual(computeBalances(s, 'home'));
  });

  it('says what a month cost and what came back, not just the balance', () => {
    const s = fixture();
    s.expenses = [expense({})];
    s.settlements = [settlement({ amount: 20 })];
    const [mar] = monthlyBalances(s, 'home');
    expect(mar.paid).toEqual({ lea: 10000, marc: 0 });
    expect(mar.back).toEqual({ lea: 0, marc: 2000 });
    expect(mar.balances.marc).toBe(-3000);
  });

  /* The one thing a per-month tally could get wrong: money handed over in July
     for August's groceries is August's money, not July's. */
  it('files a repayment under the month of what it was ticked against', () => {
    const s = fixture();
    s.expenses = [expense({ id: 'e-aug', date: '2025-08-04' })];
    s.settlements = [settlement({ date: '2025-07-28', itemIds: ['e-aug'] })];
    const months = monthlyBalances(s, 'home');
    expect(months.map((t) => t.month)).toEqual(['2025-08']);
    expect(months[0].balances).toEqual({ lea: 0, marc: 0 });
  });

  it('splits one repayment across every month it covers', () => {
    const s = fixture();
    s.expenses = [
      expense({ id: 'e-jul', date: '2025-07-02' }),          // Marc owes 50
      expense({ id: 'e-aug', date: '2025-08-04', amount: 300 }),  // Marc owes 150
    ];
    s.settlements = [settlement({ date: '2025-09-01', amount: 200, itemIds: ['e-jul', 'e-aug'] })];
    const months = monthlyBalances(s, 'home');
    expect(months.map((t) => t.month)).toEqual(['2025-07', '2025-08']);
    expect(months[0].back.marc).toBe(5000);
    expect(months[1].back.marc).toBe(15000);
    expect(summed(s)).toEqual(computeBalances(s, 'home'));
  });

  it('files a repayment with nothing ticked under the month it moved', () => {
    const s = fixture();
    s.settlements = [settlement({ date: '2025-07-28' })];
    const months = monthlyBalances(s, 'home');
    expect(months.map((t) => t.month)).toEqual(['2025-07']);
    expect(months[0].balances.marc).toBe(5000);
  });

  it('lands the part of a repayment no item accounts for on its own date', () => {
    const s = fixture();
    s.expenses = [expense({ id: 'e-jul', date: '2025-07-02' })];   // Marc owes 50
    s.settlements = [settlement({ date: '2025-09-01', amount: 80, itemIds: ['e-jul'] })];
    const months = monthlyBalances(s, 'home');
    expect(months.map((t) => t.month)).toEqual(['2025-07', '2025-09']);
    expect(months[0].back.marc).toBe(5000);
    expect(months[1].back.marc).toBe(3000);
    expect(summed(s)).toEqual(computeBalances(s, 'home'));
  });

  it('falls back to the date once the item a repayment named is gone', () => {
    const s = fixture();
    s.settlements = [settlement({ date: '2025-07-28', itemIds: ['e-deleted'] })];
    expect(monthlyBalances(s, 'home').map((t) => t.month)).toEqual(['2025-07']);
  });

  it('bills a recurring rule to the month it is for', () => {
    const s = fixture();
    s.rules = [{ ...rentRule(), startMonth: '2025-01', endMonth: '2025-02' }];
    const months = monthlyBalances(s, 'home');
    expect(months.map((t) => t.month)).toEqual(['2025-01', '2025-02']);
    months.forEach((t) => { expect(t.balances.marc).toBe(-60000); });
    expect(summed(s)).toEqual(computeBalances(s, 'home'));
  });

  it('skips the quiet months between rather than printing zeros', () => {
    const s = fixture();
    s.expenses = [expense({}), expense({ id: 'e2', date: '2025-06-02' })];
    expect(monthlyBalances(s, 'home').map((t) => t.month)).toEqual(['2025-03', '2025-06']);
  });

  it('ignores another ledger entirely', () => {
    const s = fixture();
    s.expenses = [expense({}), expense({ id: 'e2', ledgerId: 'trip', date: '2025-04-02' })];
    expect(monthlyBalances(s, 'home').map((t) => t.month)).toEqual(['2025-03']);
  });
});

describe('monthTally', () => {
  it('hands back a month that saw nothing as zeros, not nothing', () => {
    const s = fixture();
    s.expenses = [expense({})];
    const t = monthTally(s, 'home', '2025-05');
    expect(t.month).toBe('2025-05');
    expect(t.balances).toEqual({ lea: 0, marc: 0 });
    expect(t.paid).toEqual({ lea: 0, marc: 0 });
  });

  it('picks the month out of the series', () => {
    const s = fixture();
    s.expenses = [expense({}), expense({ id: 'e2', date: '2025-04-02', amount: 40 })];
    expect(monthTally(s, 'home', '2025-04').balances.marc).toBe(-2000);
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

describe('settlementsInMonth', () => {
  it('files a repayment under the month of what it was ticked against', () => {
    const s = fixture();
    s.expenses = [expense({ id: 'e-aug', date: '2025-08-04' })];
    // handed over in July, but it covers August's grocery run
    s.settlements = [settlement({ id: 's1', date: '2025-07-28', itemIds: ['e-aug'] })];
    expect(settlementsInMonth(s, 'home', '2025-08').map((x) => x.id)).toEqual(['s1']);
    expect(settlementsInMonth(s, 'home', '2025-07')).toEqual([]);
  });

  it('reads the month of a recurring bill straight off the item id', () => {
    const s = fixture();
    s.settlements = [settlement({ id: 's1', date: '2025-07-28', itemIds: ['rule-rent|2025-09'] })];
    expect(settlementsInMonth(s, 'home', '2025-09').map((x) => x.id)).toEqual(['s1']);
    expect(settlementsInMonth(s, 'home', '2025-07')).toEqual([]);
  });

  it('files a repayment with nothing ticked under the month it was made', () => {
    const s = fixture();
    s.settlements = [settlement({ id: 's1', date: '2025-07-28' })];
    expect(settlementsInMonth(s, 'home', '2025-07').map((x) => x.id)).toEqual(['s1']);
    expect(settlementsInMonth(s, 'home', '2025-08')).toEqual([]);
  });

  it('shows one repayment in every month it covers', () => {
    const s = fixture();
    s.expenses = [expense({ id: 'e-jul', date: '2025-07-02' })];
    s.settlements = [settlement({ id: 's1', date: '2025-07-28', itemIds: ['e-jul', 'rule-rent|2025-08'] })];
    expect(settlementsInMonth(s, 'home', '2025-07').map((x) => x.id)).toEqual(['s1']);
    expect(settlementsInMonth(s, 'home', '2025-08').map((x) => x.id)).toEqual(['s1']);
  });

  it('falls back to its own date once the items it named are gone', () => {
    const s = fixture();
    s.settlements = [settlement({ id: 's1', date: '2025-07-28', itemIds: ['e-deleted'] })];
    expect(settlementsInMonth(s, 'home', '2025-07').map((x) => x.id)).toEqual(['s1']);
  });

  it('keeps a repayment dated in the future, filed under that month', () => {
    const s = fixture();
    s.settlements = [settlement({ id: 's1', date: '2099-01-05' })];
    expect(settlementsInMonth(s, 'home', '2099-01').map((x) => x.id)).toEqual(['s1']);
  });

  it('gives a trip the whole log, newest first', () => {
    const s = fixture();
    s.settlements = [
      settlement({ id: 's-jul', date: '2025-07-28' }),
      settlement({ id: 's-aug', date: '2025-08-15', itemIds: ['rule-rent|2025-09'] }),
    ];
    expect(settlementsInMonth(s, 'home', null).map((x) => x.id)).toEqual(['s-aug', 's-jul']);
  });
});

describe('repaymentPicks', () => {
  /** Léa pays 100 for the pair of them, so Marc owes her 50. */
  const owing = (): AppState => {
    const s = fixture();
    s.expenses = [expense({})];
    return s;
  };
  const pick = (picks: RepayPick[], id: string): RepayPick =>
    picks.find((c) => c.it.id === id) as RepayPick;
  const owed = (s: AppState, id: string, from = 'marc', to = 'lea'): RepayPick =>
    pick(repaymentPicks(s, 'home', from, to), id);

  it('offers what one owes the other, and nothing the other way round', () => {
    const s = owing();
    expect(owed(s, 'e1').left).toBe(5000);
    expect(owed(s, 'e1', 'lea', 'marc').left).toBe(0);
  });

  it('leaves the rest of an item due after a part payment', () => {
    const s = owing();
    s.settlements = [settlement({ amount: 20, itemIds: ['e1'] })];
    expect(owed(s, 'e1').repaid).toBe(2000);
    expect(owed(s, 'e1').left).toBe(3000);
  });

  it('takes an item off the table once it is paid in full', () => {
    const s = owing();
    s.settlements = [settlement({ amount: 50, itemIds: ['e1'] })];
    expect(owed(s, 'e1').left).toBe(0);
  });

  it('adds part payments up until nothing is left', () => {
    const s = owing();
    s.settlements = [
      settlement({ id: 's1', amount: 20, itemIds: ['e1'] }),
      settlement({ id: 's2', amount: 30, itemIds: ['e1'] }),
    ];
    expect(owed(s, 'e1').left).toBe(0);
  });

  it('spreads short money over the ticked items in proportion', () => {
    const s = fixture();
    s.expenses = [expense({}), expense({ id: 'e2', amount: 300 })];   // 50 and 150 owed
    s.settlements = [settlement({ amount: 100, itemIds: ['e1', 'e2'] })];
    expect(owed(s, 'e1').left).toBe(2500);
    expect(owed(s, 'e2').left).toBe(7500);
  });

  it('gives the leftover cent to the biggest of the ticked items', () => {
    const s = fixture();
    s.expenses = [expense({ amount: 2 }), expense({ id: 'e2', amount: 4 })];   // 100 and 200 owed
    s.settlements = [settlement({ amount: 1, itemIds: ['e1', 'e2'] })];        // 100 of 300
    expect(owed(s, 'e1').repaid).toBe(33);
    expect(owed(s, 'e2').repaid).toBe(67);
  });

  it('never spills an overpayment onto anything that was not ticked', () => {
    const s = fixture();
    s.expenses = [expense({}), expense({ id: 'e2', amount: 300 })];
    s.settlements = [settlement({ amount: 200, itemIds: ['e1'] })];   // far over the 50 owed
    expect(owed(s, 'e1').left).toBe(0);
    expect(owed(s, 'e2').left).toBe(15000);
  });

  it('leaves an item alone when the money went the other way', () => {
    const s = owing();
    s.settlements = [settlement({ fromPersonId: 'lea', toPersonId: 'marc', amount: 20, itemIds: ['e1'] })];
    expect(owed(s, 'e1').left).toBe(5000);
  });

  it('ignores repayments belonging to another ledger', () => {
    const s = owing();
    s.settlements = [settlement({ ledgerId: 'trip', amount: 20, itemIds: ['e1'] })];
    expect(owed(s, 'e1').left).toBe(5000);
  });

  it('puts the repayment being edited back on the table', () => {
    const s = owing();
    s.settlements = [settlement({ id: 's1', amount: 20, itemIds: ['e1'] })];
    expect(pick(repaymentPicks(s, 'home', 'marc', 'lea', 's1'), 'e1').left).toBe(5000);
  });

  it('counts a foreign repayment through its snapshotted rate', () => {
    const s = owing();
    s.settlements = [settlement({ amount: 20, currency: 'EUR', fxRate: 0.9, itemIds: ['e1'] })];
    expect(owed(s, 'e1').repaid).toBe(1800);
  });

  it('offers a planned expense, flagged as money that has not moved', () => {
    const s = fixture();
    s.expenses = [expense({ planned: true })];
    expect(owed(s, 'e1').left).toBe(5000);
    expect(owed(s, 'e1').ahead).toBe(true);
    expect(computeBalances(s, 'home').marc).toBe(0);   // and still out of the tally
  });

  it('offers the bills still to land, and only those are flagged', () => {
    const s = fixture();
    s.rules = [rentRule()];
    expect(owed(s, 'rule-rent|' + addMonths(thisMonth(), 1)).left).toBe(60000);
    expect(owed(s, 'rule-rent|' + addMonths(thisMonth(), 1)).ahead).toBe(true);
    expect(owed(s, 'rule-rent|' + thisMonth()).ahead).toBe(false);
  });

  it('puts what is paid first, newest first, and what is not last, soonest first', () => {
    const s = fixture();
    s.rules = [rentRule()];
    s.expenses = [expense({ id: 'old', date: '2025-02-01' }), expense({ id: 'new', date: '2025-04-01' })];
    const picks = repaymentPicks(s, 'home', 'marc', 'lea');
    const landed = picks.filter((c) => !c.ahead);
    const ahead = picks.filter((c) => c.ahead);
    expect(picks.slice(0, landed.length).every((c) => !c.ahead)).toBe(true);
    expect(landed.map((c) => c.it.date)).toEqual([...landed.map((c) => c.it.date)].sort().reverse());
    expect(ahead.map((c) => c.it.date)).toEqual([...ahead.map((c) => c.it.date)].sort());
  });

  it('stops offering bills past the horizon', () => {
    const s = fixture();
    s.rules = [rentRule()];
    const picks = repaymentPicks(s, 'home', 'marc', 'lea');
    expect(pick(picks, 'rule-rent|' + addMonths(thisMonth(), REPAY_AHEAD))).toBeDefined();
    expect(pick(picks, 'rule-rent|' + addMonths(thisMonth(), REPAY_AHEAD + 1))).toBeUndefined();
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
