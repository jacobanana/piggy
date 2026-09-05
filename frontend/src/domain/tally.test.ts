import { describe, expect, it } from 'vitest';
import { repaymentsView, spentView, tallyView } from './tally';
import { settlementByMonth, settlementMonths, tallyBreakdown } from './balances';
import { blankState } from '../model/state';
import type { AppState, Expense, Rule, Settlement } from '../model/types';

/** Two people, a personal account each. */
function fixture(): AppState {
  const s = blankState();
  s.people = [
    { id: 'lea', name: 'Léa', emoji: '🐰', color: '#111' },
    { id: 'marc', name: 'Marc', emoji: '🦊', color: '#222' },
  ];
  s.accounts = [
    { id: 'acc-lea', name: "Léa's money", kind: 'personal', ownership: { lea: 1 } },
    { id: 'acc-marc', name: "Marc's money", kind: 'personal', ownership: { marc: 1 } },
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

const rentRule = (over: Partial<Rule>): Rule => ({
  id: 'rule-rent', ledgerId: 'home', name: 'Rent', emoji: '🏠', amount: 1200, currency: 'CHF',
  frequency: 'monthly', dueDay: 1, startMonth: '2025-08', endMonth: '2025-08', accountId: 'acc-lea',
  method: 'transfer', split: { mode: 'equal', participants: [], values: {} }, active: true,
  notes: '', createdAt: '2025-01-01T00:00:00Z',
  ...over,
});

const settlement = (over: Partial<Settlement>): Settlement => ({
  id: 's1', ledgerId: 'home', date: '2025-03-15', fromPersonId: 'marc', toPersonId: 'lea',
  amount: 50, currency: 'CHF', fxRate: 1, method: 'cash', note: '', createdAt: '2025-03-15T00:00:00Z',
  ...over,
});

/**
 * The book that started this: Marc pays 800 in July towards two of August's
 * bills, and one of the two is deleted afterwards. The 200 it now overshoots
 * by used to fall into July — a month with nothing in it, printing a debt.
 */
function overpaidBook(): AppState {
  const s = fixture();
  s.rules = [rentRule({})];   // 1200, Léa's account, split evenly: Marc owes 600
  s.settlements = [settlement({
    date: '2025-07-28', amount: 800,
    itemIds: ['rule-rent|2025-08', 'rule-deleted|2025-08'],
  })];
  return s;
}

describe('tallyView', () => {
  it('leaves a month nothing happened in with nothing to show', () => {
    const v = tallyView(overpaidBook(), 'home', '2025-07');
    expect(v.moved).toBe(false);
    expect(v.anyBack).toBe(false);
    expect(v.debts).toEqual([]);
    expect(v.back).toEqual({ lea: 0, marc: 0 });
  });

  it('puts the whole repayment on the month it was paid towards', () => {
    const v = tallyView(overpaidBook(), 'home', '2025-08');
    expect(v.back.marc).toBe(80000);
    /* Marc owed 600 and handed over 800, so August alone leaves Léa owing him
       the 200 he overshot by. */
    expect(v.debts).toEqual([{ from: 'lea', to: 'marc', cents: 20000 }]);
  });

  it('leaves the ledger debt to the ledger scope', () => {
    const s = overpaidBook();
    /* The 800 was ticked against August, so July holds none of it and says
       so. The 200 it overshot by is the ledger's to report, and only on the
       scope that can settle it. */
    expect(tallyView(s, 'home', '2025-07').debts).toEqual([]);
    expect(tallyView(s, 'home', null).debts).toEqual([{ from: 'lea', to: 'marc', cents: 20000 }]);
  });

  it('answers with the month it was asked about, not the ledger', () => {
    const s = fixture();
    s.expenses = [
      expense({ id: 'e-jul', date: '2025-07-02', amount: 1000 }),   // Marc owes Léa 500
      expense({ id: 'e-aug', date: '2025-08-04', amount: 100, accountId: 'acc-marc' }),
    ];
    /* August leaves Léa owing 50 and the ledger leaves Marc owing 450: the
       two run opposite ways, which is exactly why they are two tabs. Each
       call answers for its own scope and knows nothing of the other. */
    expect(tallyView(s, 'home', '2025-08').debts).toEqual([{ from: 'lea', to: 'marc', cents: 5000 }]);
    expect(tallyView(s, 'home', '2025-07').debts).toEqual([{ from: 'marc', to: 'lea', cents: 50000 }]);
    expect(tallyView(s, 'home', null).debts).toEqual([{ from: 'marc', to: 'lea', cents: 45000 }]);
  });

  /**
   * The book behind "where does the 9.95 come from?": two months that mirror
   * each other exactly, so the ledger is square while each month on its own
   * is not. One card printed both, and the month's debt sat directly above an
   * ALL SQUARE stamp. Now Monthly prints the month and Total prints the
   * stamp, and neither is on screen with the other.
   */
  function mirroredBook(): AppState {
    const s = fixture();
    s.expenses = [expense({ id: 'e-aug', date: '2025-08-04', amount: 1000 })];
    /* Marc owes 500 for August and hands over 600, ticked against it — so
       August leaves Léa 100 behind and September gives it straight back. */
    s.settlements = [
      settlement({ id: 's-aug', date: '2025-08-10', amount: 600, itemIds: ['e-aug'] }),
      settlement({ id: 's-sep', date: '2025-09-10', amount: 100, fromPersonId: 'lea', toPersonId: 'marc' }),
    ];
    return s;
  }

  it('keeps a mirrored month and a square ledger in separate answers', () => {
    const s = mirroredBook();
    expect(tallyView(s, 'home', '2025-08').debts).toEqual([{ from: 'lea', to: 'marc', cents: 10000 }]);
    expect(tallyView(s, 'home', '2025-09').debts).toEqual([{ from: 'marc', to: 'lea', cents: 10000 }]);
    /* The one scope you can settle, and it owes nothing. */
    expect(tallyView(s, 'home', null).debts).toEqual([]);
  });

  it('scopes the paid and paid-back rows to the same weeks as the balance', () => {
    const s = mirroredBook();
    const aug = tallyView(s, 'home', '2025-08');
    expect(aug.paid).toEqual({ lea: 100000, marc: 0 });
    expect(aug.back).toEqual({ lea: 0, marc: 60000 });
    const sep = tallyView(s, 'home', '2025-09');
    /* September bought nothing: only the 100 handed back lands in it. */
    expect(sep.paid).toEqual({ lea: 0, marc: 0 });
    expect(sep.back).toEqual({ lea: 10000, marc: 0 });
    expect(sep.moved).toBe(true);
  });

  it('still tells the breakdown when other months cover the one on screen', () => {
    const b = tallyBreakdown(mirroredBook(), 'home', '2025-08');
    expect(b.cancelled).toBe(true);
    expect(b.people.find((x) => x.id === 'marc')?.net).toBe(10000);
    /* Never on the ledger scope: there is nothing outside it to do the
       covering. */
    expect(tallyBreakdown(mirroredBook(), 'home', null).cancelled).toBe(false);
  });

  it('sums the whole log for a scope with no month', () => {
    const s = overpaidBook();
    const v = tallyView(s, 'home', null);
    expect(v.back.marc).toBe(80000);
    expect(v.month).toBe(null);
    expect(v.moved).toBe(true);
  });
});

describe('repaymentsView', () => {
  it('lists a repayment under the month it was paid towards, and nowhere else', () => {
    const s = overpaidBook();
    expect(repaymentsView(s, 'home', '2025-08').list.map((x) => x.id)).toEqual(['s1']);
    expect(repaymentsView(s, 'home', '2025-07').list).toEqual([]);
  });

  it('adds up what moved, per pair and in all', () => {
    const s = fixture();
    s.settlements = [
      settlement({ id: 's1', date: '2025-03-02', amount: 50 }),
      settlement({ id: 's2', date: '2025-03-09', amount: 30 }),
      settlement({ id: 's3', date: '2025-03-11', amount: 20, fromPersonId: 'lea', toPersonId: 'marc' }),
    ];
    const v = repaymentsView(s, 'home', '2025-03');
    expect(v.moved).toBe(10000);
    expect(v.perPair).toEqual([
      { from: 'lea', to: 'marc', cents: 2000 },
      { from: 'marc', to: 'lea', cents: 8000 },
    ]);
  });

  it('heads the whole log with the month each repayment was filed under', () => {
    const s = overpaidBook();
    /* Handed over on 28 July, ticked against August's rent. The month tabs
       count it in August, so the log has to head it August. */
    const v = repaymentsView(s, 'home', null);
    expect(v.groups.map((g) => g.month)).toEqual(['2025-08']);
    expect(v.groups[0].list.map((x) => x.id)).toEqual(['s1']);
  });

  it('puts the newest month at the top of the whole log', () => {
    const s = fixture();
    s.rules = [rentRule({ startMonth: '2025-08', endMonth: '2025-10' })];
    s.settlements = [
      settlement({ id: 's-oct', date: '2025-09-20', itemIds: ['rule-rent|2025-10'] }),
      settlement({ id: 's-aug', date: '2025-08-02', itemIds: ['rule-rent|2025-08'] }),
      settlement({ id: 's-sep', date: '2025-08-30', itemIds: ['rule-rent|2025-09'] }),
    ];
    expect(repaymentsView(s, 'home', null).groups.map((g) => g.month))
      .toEqual(['2025-10', '2025-09', '2025-08']);
  });

  it('groups a trip by the month the money moved, and a month not at all', () => {
    const s = fixture();
    s.settlements = [
      settlement({ id: 's-jul', date: '2025-07-28' }),
      settlement({ id: 's-aug', date: '2025-08-15' }),
    ];
    expect(repaymentsView(s, 'home', null).groups.map((g) => g.month)).toEqual(['2025-08', '2025-07']);
    expect(repaymentsView(s, 'home', '2025-08').groups.map((g) => g.month)).toEqual(['2025-08']);
  });
});

describe('spentView', () => {
  it('keeps the bills apart from the extras and adds them to the total', () => {
    const s = fixture();
    s.rules = [rentRule({})];
    s.expenses = [expense({ id: 'e-aug', date: '2025-08-04', amount: 60 })];
    const v = spentView(s, 'home', '2025-08');
    expect(v.totals.recurring).toBe(120000);
    expect(v.totals.oneOff).toBe(6000);
    expect(v.totals.spent).toBe(126000);
  });

  it('costs a skipped bill nothing but still lists it', () => {
    const s = fixture();
    s.rules = [rentRule({})];
    s.overrides = [{ id: 'o1', ruleId: 'rule-rent', period: '2025-08', skipped: true }];
    const v = spentView(s, 'home', '2025-08');
    expect(v.recurring).toHaveLength(1);
    expect(v.totals.recurring).toBe(0);
  });

  it('keeps planned money off the spend and on its own total', () => {
    const s = fixture();
    s.expenses = [
      expense({ id: 'e-paid', date: '2025-08-04', amount: 60 }),
      expense({ id: 'e-soon', date: '2025-08-20', amount: 40, planned: true }),
    ];
    const v = spentView(s, 'home', '2025-08');
    expect(v.totals.spent).toBe(6000);
    expect(v.totals.planned).toBe(4000);
    expect(v.oneOff.map((e) => e.id)).toEqual(['e-paid']);
    expect(v.planned.map((e) => e.id)).toEqual(['e-soon']);
  });

  it('charts the same spend the figure above it prints', () => {
    const s = fixture();
    s.expenses = [
      expense({ id: 'e1', date: '2025-08-04', amount: 60, emoji: '🛒' }),
      expense({ id: 'e2', date: '2025-08-05', amount: 40, emoji: '🍕' }),
    ];
    const v = spentView(s, 'home', '2025-08');
    expect(v.categories.reduce((a, c) => a + c.cents, 0)).toBe(v.totals.spent);
  });
});

/**
 * The receipt and the breakdown behind it are two readings of the same money.
 * They used to be able to disagree — the tally counted 113.30 of paid-back
 * into a month whose own repayment list was empty — so these are the checks
 * that keep them welded together.
 */
describe('the figures agree with each other', () => {
  const books: [string, () => AppState][] = [
    ['an overpayment against a deleted bill', overpaidBook],
    ['a repayment ticked across two months', () => {
      const s = fixture();
      s.expenses = [
        expense({ id: 'e-jul', date: '2025-07-02' }),
        expense({ id: 'e-aug', date: '2025-08-04', amount: 300 }),
      ];
      s.settlements = [settlement({ date: '2025-09-01', amount: 400, itemIds: ['e-jul', 'e-aug'] })];
      return s;
    }],
    ['a repayment with nothing ticked', () => {
      const s = fixture();
      s.expenses = [expense({ date: '2025-07-02' })];
      s.settlements = [settlement({ date: '2025-07-28' })];
      return s;
    }],
    ['a repayment whose items are all gone', () => {
      const s = fixture();
      s.settlements = [settlement({ date: '2025-07-28', itemIds: ['e-deleted'] })];
      return s;
    }],
  ];

  const months = ['2025-07', '2025-08', '2025-09'];

  books.forEach(([what, build]) => {
    describe(what, () => {
      it('never files a cent under a month the log does not list', () => {
        const s = build();
        s.settlements.forEach((x) => {
          const listed = settlementMonths(s, x);
          Object.keys(settlementByMonth(s, x)).forEach((m) => expect(listed).toContain(m));
        });
      });

      it('files every cent of every repayment somewhere', () => {
        const s = build();
        s.settlements.forEach((x) => {
          const by = settlementByMonth(s, x);
          const filed = Object.values(by).reduce((a, b) => a + b, 0);
          expect(filed).toBe(Math.round(x.amount * 100));
        });
      });

      it("matches the month's paid-back rows to the repayments it lists", () => {
        const s = build();
        months.forEach((m) => {
          const v = tallyView(s, 'home', m);
          const b = tallyBreakdown(s, 'home', m);
          s.people.forEach((p) => {
            const listed = b.repayments
              .filter((x) => x.fromPersonId === p.id)
              .reduce((a, x) => a + (b.counted[x.id] || 0), 0);
            expect(v.back[p.id]).toBe(listed);
          });
        });
      });

      it("matches the month's subtotal to the breakdown behind it", () => {
        const s = build();
        months.forEach((m) => {
          const v = tallyView(s, 'home', m);
          const b = tallyBreakdown(s, 'home', m);
          b.people.forEach((x) => expect(x.net).toBe(v.balances[x.id]));
        });
      });

      it('adds the months back up to the headline', () => {
        const s = build();
        const running = tallyView(s, 'home', null).balances;
        const summed: Record<string, number> = { lea: 0, marc: 0 };
        months.forEach((m) => {
          const v = tallyView(s, 'home', m);
          s.people.forEach((p) => { summed[p.id] += v.balances[p.id]; });
        });
        expect(summed).toEqual(running);
      });

      it('never leaves a month printing a debt out of nothing', () => {
        const s = build();
        months.forEach((m) => {
          const v = tallyView(s, 'home', m);
          const b = tallyBreakdown(s, 'home', m);
          const empty = !b.recurring.length && !b.oneOff.length && !b.repayments.length;
          if (empty) expect(v.debts).toEqual([]);
        });
      });
    });
  });
});
