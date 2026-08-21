/**
 * The tally: who owes whom, across the whole ledger.
 *
 * Expenses belong to a month; the tally never does. Somebody paying on the
 * 28th of July for August's rent is settling a real debt, and a tally that
 * reset every month would either lose that money or count it twice. So the
 * balance, what each side has paid, and the repayment log all run from the
 * first entry to the last — only `categoryTotals` below, which describes one
 * month's spending rather than the debt between people, takes a month.
 */
import type { AppState, LedgerItem, MonthKey, Settlement } from '../model/types';
import { itemsInScope } from './selectors';
import { splitCents } from './splits';
import { toBase } from './fx';
import { cents, monthIndex, monthOf } from '../lib/utils';

/**
 * What one item alone does to each person's balance, in base-currency cents.
 * Left unrounded: callers that sum many items round once at the end.
 */
function itemDeltas(s: AppState, it: LedgerItem, ids: string[]): Record<string, number> {
  const d: Record<string, number> = {};
  ids.forEach((id) => { d[id] = 0; });
  const tc = cents(toBase(s.settings.rates, it.amount, it.currency, it.fxRate));
  const acc = s.accounts.find((a) => a.id === it.accountId);
  if (acc) {
    Object.entries(acc.ownership).forEach(([pid, share]) => {
      if (d[pid] != null) d[pid] += tc * Number(share);
    });
  }
  const owed = splitCents(it.split, tc, ids);
  Object.entries(owed).forEach(([pid, c]) => { if (d[pid] != null) d[pid] -= c; });
  return d;
}

/**
 * What this one item makes `from` owe `to`, in base-currency cents — the
 * amount to repay if you were settling that item and nothing else. Never
 * negative: an item that leaves `from` in credit owes nothing.
 */
export function pairwiseDebt(s: AppState, it: LedgerItem, from: string, to: string): number {
  if (from === to) return 0;
  const d = itemDeltas(s, it, s.people.map((p) => p.id));
  return Math.max(0, Math.round(Math.min(-(d[from] || 0), d[to] || 0)));
}

/**
 * Net position per person over the whole ledger, in base-currency cents.
 * Positive: the others owe them. Paying from an account credits its owners
 * by ownership share; each item's split debits whoever it was for;
 * repayments move the tally back towards zero whichever month they landed in.
 */
export function computeBalances(s: AppState, ledgerId: string): Record<string, number> {
  const bal: Record<string, number> = {};
  s.people.forEach((p) => { bal[p.id] = 0; });
  const ids = s.people.map((p) => p.id);

  itemsInScope(s, ledgerId, null).forEach((it) => {
    Object.entries(itemDeltas(s, it, ids)).forEach(([pid, c]) => { bal[pid] += c; });
  });

  s.settlements
    .filter((x) => x.ledgerId === ledgerId)
    .forEach((x) => {
      const c = cents(toBase(s.settings.rates, x.amount, x.currency, x.fxRate));
      if (bal[x.fromPersonId] != null) bal[x.fromPersonId] += c;
      if (bal[x.toPersonId] != null) bal[x.toPersonId] -= c;
    });

  Object.keys(bal).forEach((k) => { bal[k] = Math.round(bal[k]); });
  return bal;
}

/** Fewest transfers that clear the balances. Sub-cent noise is ignored. */
export function simplifyDebts(bal: Record<string, number>): { from: string; to: string; cents: number }[] {
  const cred: [string, number][] = [];
  const deb: [string, number][] = [];
  Object.entries(bal).forEach(([id, c]) => {
    if (c > 1) cred.push([id, c]);
    else if (c < -1) deb.push([id, -c]);
  });
  cred.sort((a, b) => b[1] - a[1]);
  deb.sort((a, b) => b[1] - a[1]);
  const out: { from: string; to: string; cents: number }[] = [];
  let i = 0, j = 0;
  while (i < deb.length && j < cred.length) {
    const amt = Math.min(deb[i][1], cred[j][1]);
    if (amt > 0) out.push({ from: deb[i][0], to: cred[j][0], cents: amt });
    deb[i][1] -= amt;
    cred[j][1] -= amt;
    if (deb[i][1] <= 0) i++;
    if (cred[j][1] <= 0) j++;
  }
  return out;
}

/** Base-currency cents each person's accounts have paid out, all told. */
export function paidByTotals(s: AppState, ledgerId: string): Record<string, number> {
  const out: Record<string, number> = {};
  s.people.forEach((p) => { out[p.id] = 0; });
  itemsInScope(s, ledgerId, null).forEach((it) => {
    const tc = cents(toBase(s.settings.rates, it.amount, it.currency, it.fxRate));
    const acc = s.accounts.find((a) => a.id === it.accountId);
    if (acc) {
      Object.entries(acc.ownership).forEach(([pid, sh]) => {
        if (out[pid] != null) out[pid] += tc * Number(sh);
      });
    }
  });
  Object.keys(out).forEach((k) => { out[k] = Math.round(out[k]); });
  return out;
}

/** Every repayment in the ledger, newest first — one list, not one a month. */
export function settlementsFor(s: AppState, ledgerId: string): Settlement[] {
  return s.settlements
    .filter((x) => x.ledgerId === ledgerId)
    .sort((a, b) => (a.date === b.date
      ? (b.createdAt || '').localeCompare(a.createdAt || '')
      : a.date < b.date ? 1 : -1));
}

/**
 * Ledger item ids already logged against a repayment — settled once, so not
 * worth offering again next time. `exceptId` is the repayment being edited,
 * whose own items stay on the table.
 */
export function settledItemIds(s: AppState, ledgerId: string, exceptId?: string | null): Set<string> {
  const out = new Set<string>();
  s.settlements.forEach((x) => {
    if (x.ledgerId !== ledgerId || (exceptId && x.id === exceptId)) return;
    (x.itemIds || []).forEach((id) => out.add(id));
  });
  return out;
}

/** Spend per category emoji, biggest first, in base-currency cents. */
export function categoryTotals(s: AppState, ledgerId: string, monthKey: MonthKey | null): [string, number][] {
  const map: Record<string, number> = {};
  itemsInScope(s, ledgerId, monthKey).forEach((it) => {
    const k = it.emoji || '📦';
    map[k] = (map[k] || 0) + cents(toBase(s.settings.rates, it.amount, it.currency, it.fxRate));
  });
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

/**
 * What one person's ledger adds up to — the figures that stand in for the
 * tally on a book with nobody to owe. All base-currency cents, planned
 * entries kept out of everything except `planned` itself.
 */
export interface SpendSummary {
  /** Everything actually paid, first entry to last. */
  total: number;
  /** Paid inside `monthKey`, or 0 when the scope has no month (a trip). */
  month: number;
  /** How many entries make up `total`. */
  count: number;
  /** Calendar months from the first entry to the last, inclusive. Never 0. */
  span: number;
  /** `total` spread evenly over `span` — what a typical month costs. */
  perMonth: number;
  /** The month the first entry landed in, or null when there are none. */
  since: MonthKey | null;
  /** Booked but not paid yet, whole ledger — the only planned figure here. */
  planned: number;
}

export function spendSummary(s: AppState, ledgerId: string, monthKey: MonthKey | null): SpendSummary {
  const base = (it: { amount: number; currency: string; fxRate: number | null }): number =>
    cents(toBase(s.settings.rates, it.amount, it.currency, it.fxRate));
  const all = itemsInScope(s, ledgerId, null);
  const total = all.reduce((sum, it) => sum + base(it), 0);
  const months = all.map((it) => monthOf(it.date)).sort();
  const since = months.length ? months[0] : null;
  /* The span runs to the last entry, not to today: a ledger that stopped in
     March shouldn't have its typical month diluted by every quiet month since. */
  const span = months.length ? monthIndex(months[months.length - 1]) - monthIndex(months[0]) + 1 : 1;
  const month = monthKey
    ? itemsInScope(s, ledgerId, monthKey).reduce((sum, it) => sum + base(it), 0)
    : 0;
  const planned = s.expenses
    .filter((e) => e.ledgerId === ledgerId && e.planned)
    .reduce((sum, e) => sum + base(e), 0);
  return { total, month, count: all.length, span, perMonth: Math.round(total / span), since, planned };
}
