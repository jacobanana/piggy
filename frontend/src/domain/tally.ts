/**
 * The read model: every figure that reaches the screen, worked out once.
 *
 * `balances.ts` holds the maths. This holds the *answers* — one call per card,
 * returning the numbers that card prints and nothing it has to work out for
 * itself. It exists because the alternative was what was here before: the
 * receipt summed the repayments one way, the repayment log summed them
 * another, the month card ran its own three reduces over the same items, and
 * the tally modal ran a fourth. Four sums of the same money in three files,
 * and when one of them drifted the app said 113.30 in one card and 111.80 in
 * the next with no way to tell which was lying.
 *
 * So the rule is: nothing in `app/` adds money up. It asks for a view, prints
 * what it is given, and formats. A figure that appears in two places is the
 * same field of the same view, which is what makes it impossible for them to
 * disagree. Adding a figure to a card means adding it here first.
 *
 * All cents, all base currency, planned entries out of everything that
 * describes money already spent.
 */
import type { AppState, Expense, LedgerItem, MonthKey, Settlement } from '../model/types';
import type { Debt, SpendSummary } from './balances';
import {
  categoryTotals, computeBalances, monthMoved, monthTally, paidBackTotals, paidByTotals,
  settlementsInMonth, simplifyDebts, spendSummary,
} from './balances';
import { itemsInScope, occurrencesFor, plannedInScope, plannedShares } from './selectors';
import { toBase } from './fx';
import { cents, monthOf } from '../lib/utils';

/** Base-currency cents of anything carrying an amount. */
function base(s: AppState, it: { amount: number; currency: string; fxRate?: number | null }): number {
  return cents(toBase(s.settings.rates, it.amount, it.currency, it.fxRate));
}

/* ---------- the tally card ---------- */

/**
 * The tally, for one scope: what it cost, what came back, and where the two
 * of you stand.
 *
 * Two figures, and they can point opposite ways — a month is a slice and the
 * debt is not. `debts` is the headline and the one Settle up hands the form;
 * `monthDebts` is the subtotal above it. `opposed` is true when the month runs
 * against the ledger, which is the one case the card has to say out loud.
 */
export interface TallyView {
  /** The month it covers, or null for the whole ledger (a trip). */
  month: MonthKey | null;
  /** Net position per person over the whole ledger. Positive: they are owed. */
  balances: Record<string, number>;
  /** Who owes whom, over the whole ledger — the headline, and Settle up's list. */
  debts: Debt[];
  /** What each person's accounts paid out, in scope. */
  paid: Record<string, number>;
  /** What each person handed back in repayments, in scope. */
  back: Record<string, number>;
  /** Whether the scope moved any money at all — spent, or handed back. */
  moved: boolean;
  /** Whether anybody handed anything back in scope. */
  anyBack: boolean;
  /** The month's own net position, or null when the scope has no month. */
  monthBalances: Record<string, number> | null;
  /** Who the month alone leaves owing whom. Empty when it squares. */
  monthDebts: Debt[];
  /** The month and the ledger leave the same person on opposite sides. */
  opposed: boolean;
}

export function tallyView(s: AppState, ledgerId: string, monthKey: MonthKey | null): TallyView {
  const balances = computeBalances(s, ledgerId);
  const t = monthKey ? monthTally(s, ledgerId, monthKey) : null;

  /* Scope every row to the month when there is one: the paid-by rows, the
     paid-back rows and the month's own subtotal all have to describe the same
     weeks, or the receipt stops adding up in front of you. */
  const paid = t ? t.paid : paidByTotals(s, ledgerId);
  const back = t ? t.back : paidBackTotals(s, ledgerId);

  const opposed = !!t && s.people.some((p) => {
    const m = t.balances[p.id] || 0, r = balances[p.id] || 0;
    /* Sub-cent noise is nobody's debt, which is the cent `simplifyDebts`
       ignores too. */
    return Math.abs(m) > 1 && Math.abs(r) > 1 && (m > 0) !== (r > 0);
  });

  return {
    month: monthKey,
    balances,
    debts: simplifyDebts(balances),
    paid,
    back,
    moved: t ? monthMoved(t) : true,
    anyBack: s.people.some((p) => (back[p.id] || 0) !== 0),
    monthBalances: t ? t.balances : null,
    monthDebts: t ? simplifyDebts(t.balances) : [],
    opposed,
  };
}

/* ---------- the repayment log ---------- */

/**
 * The repayments in scope, and what they came to.
 *
 * A month shows what was filed under it — whatever was ticked against one of
 * that month's items, plus anything logged that month with nothing ticked. A
 * trip has no months, so it gets the lot, grouped by the month the money
 * moved.
 */
export interface RepaymentsView {
  /** Every repayment in scope, newest first. */
  list: Settlement[];
  /** What they came to, all together. */
  moved: number;
  /** …and per pair of people, in the order the pairs first appear. */
  perPair: Debt[];
  /** The list cut into month headings. One group means no heading is wanted. */
  groups: { month: MonthKey; list: Settlement[] }[];
}

export function repaymentsView(s: AppState, ledgerId: string, monthKey: MonthKey | null): RepaymentsView {
  const list = settlementsInMonth(s, ledgerId, monthKey);
  const pairs = new Map<string, Debt>();
  let moved = 0;
  list.forEach((x) => {
    const c = base(s, x);
    moved += c;
    const k = x.fromPersonId + '>' + x.toPersonId;
    const p = pairs.get(k) || { from: x.fromPersonId, to: x.toPersonId, cents: 0 };
    p.cents += c;
    pairs.set(k, p);
  });

  const groups: { month: MonthKey; list: Settlement[] }[] = [];
  if (monthKey) {
    if (list.length) groups.push({ month: monthKey, list });
  } else {
    list.forEach((x) => {
      const m = monthOf(x.date);
      const g = groups.find((y) => y.month === m);
      if (g) g.list.push(x); else groups.push({ month: m, list: [x] });
    });
  }

  return { list, moved, perPair: [...pairs.values()], groups };
}

/* ---------- what a scope cost ---------- */

/**
 * Everything spent in one scope, and everything only booked so far.
 *
 * One call behind the month card, the two lists under it, the still-to-pay
 * card and the pie — so the figure at the top of the month is the same
 * addition as the rows beneath it rather than a second one that agrees by
 * luck.
 */
export interface SpentView {
  month: MonthKey | null;
  /** Recurring occurrences in scope, soonest first — skipped ones included,
      because the list shows them struck through. Empty for a trip. */
  recurring: LedgerItem[];
  /** One-off expenses in scope, newest first. */
  oneOff: (Expense & { kind: 'adhoc' })[];
  /** Booked but not paid yet, soonest first — a to-pay list. */
  planned: (Expense & { kind: 'adhoc' })[];
  totals: {
    /** The bills that actually landed — skipped ones cost nothing. */
    recurring: number;
    oneOff: number;
    /** The two together: what the scope cost. */
    spent: number;
    /** Booked but not paid. On no other total here. */
    planned: number;
  };
  /** What each person's share of the planned list will be, once it's paid. */
  plannedShares: Record<string, number>;
  /** Spend per category emoji, biggest first, and what they come to. */
  categories: { emoji: string; cents: number }[];
  /** The ledger read as one person's spending — the solo book's tally. */
  summary: SpendSummary;
}

export function spentView(s: AppState, ledgerId: string, monthKey: MonthKey | null): SpentView {
  const byDate = (a: { date: string; createdAt?: string }, b: { date: string; createdAt?: string }): number =>
    (a.date === b.date ? (b.createdAt || '').localeCompare(a.createdAt || '') : a.date < b.date ? 1 : -1);

  const recurring = monthKey ? occurrencesFor(s, ledgerId, monthKey) : [];
  const oneOff = s.expenses
    .filter((e) => e.ledgerId === ledgerId && !e.planned && (!monthKey || monthOf(e.date) === monthKey))
    .map((e) => ({ ...e, kind: 'adhoc' as const }))
    .sort(byDate);
  const planned = plannedInScope(s, ledgerId, monthKey);

  /* The bills come off `itemsInScope`, not off the list above: that is the
     same set the tally is built from, skipped occurrences already dropped. */
  const recTotal = itemsInScope(s, ledgerId, monthKey)
    .filter((it) => it.kind === 'recurring')
    .reduce((sum, it) => sum + base(s, it), 0);
  const oneTotal = oneOff.reduce((sum, e) => sum + base(s, e), 0);

  return {
    month: monthKey,
    recurring,
    oneOff,
    planned,
    totals: {
      recurring: recTotal,
      oneOff: oneTotal,
      spent: recTotal + oneTotal,
      planned: planned.reduce((sum, e) => sum + base(s, e), 0),
    },
    plannedShares: plannedShares(s, planned),
    categories: categoryTotals(s, ledgerId, monthKey).map(([emoji, c]) => ({ emoji, cents: c })),
    summary: spendSummary(s, ledgerId, monthKey),
  };
}
