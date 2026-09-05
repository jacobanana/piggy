/**
 * The tally: who owes whom.
 *
 * It is kept two ways, and both are true at once. `computeBalances` runs from
 * the first entry to the last — that is the debt you actually settle, and it
 * has to span the ledger, because somebody paying on the 28th of July for
 * August's rent is settling a real debt and a balance that reset every month
 * would either lose that money or count it twice. `monthlyBalances` cuts the
 * same figures into the month each one belongs to, so a month can be read on
 * its own: what it cost, what came back, and what it left between you.
 *
 * Nothing is lost in the cut. Every item is filed under its own month, and a
 * repayment is split across the months of whatever it was ticked against, so
 * the months add back up to the running total.
 */
import type { AppState, LedgerItem, MonthKey, Settlement } from '../model/types';
import { itemsInScope, repayableItems } from './selectors';
import { splitCents } from './splits';
import { toBase } from './fx';
import { cents, monthIndex, monthOf, thisMonth } from '../lib/utils';

/**
 * What paying for one item credits each person, in base-currency cents: the
 * money left their account, by ownership share. Left unrounded — callers that
 * sum many items round once at the end.
 */
function paidShares(s: AppState, it: LedgerItem, ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  ids.forEach((id) => { out[id] = 0; });
  const tc = cents(toBase(s.settings.rates, it.amount, it.currency, it.fxRate));
  const acc = s.accounts.find((a) => a.id === it.accountId);
  if (acc) {
    Object.entries(acc.ownership).forEach(([pid, share]) => {
      if (out[pid] != null) out[pid] += tc * Number(share);
    });
  }
  return out;
}

/**
 * What one item alone does to each person's balance, in base-currency cents:
 * what they paid for it, less the share of it that was theirs. Unrounded, as
 * `paidShares` is.
 */
function itemDeltas(s: AppState, it: LedgerItem, ids: string[]): Record<string, number> {
  const d = paidShares(s, it, ids);
  const tc = cents(toBase(s.settings.rates, it.amount, it.currency, it.fxRate));
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
  const ids = s.people.map((p) => p.id);
  const out: Record<string, number> = {};
  ids.forEach((id) => { out[id] = 0; });
  itemsInScope(s, ledgerId, null).forEach((it) => {
    Object.entries(paidShares(s, it, ids)).forEach(([pid, c]) => { out[pid] += c; });
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
 * Which month a ticked item belongs to. A recurring occurrence carries its
 * period in the id itself (`ruleId|YYYY-MM`); an ad-hoc expense is dated.
 * Null when the id names nothing that still exists.
 */
function itemMonth(s: AppState, id: string): MonthKey | null {
  if (id.includes('|')) return id.split('|')[1] || null;
  const e = s.expenses.find((x) => x.id === id);
  return e ? monthOf(e.date) : null;
}

/**
 * The month (or months) a repayment belongs to for the log.
 *
 * Ticking what a repayment covers says which month's money it is, whatever
 * day it was handed over: paying in July for August's rent belongs to August.
 * With nothing ticked there is only the date to go on, so it belongs to the
 * month the money moved — and that is the fallback too when everything it was
 * logged against has since been deleted.
 */
export function settlementMonths(s: AppState, x: Pick<Settlement, 'date'> & { itemIds?: string[] }): MonthKey[] {
  const out: MonthKey[] = [];
  (x.itemIds || []).forEach((id) => {
    const m = itemMonth(s, id);
    if (m && !out.includes(m)) out.push(m);
  });
  return out.length ? out.sort() : [monthOf(x.date)];
}

/**
 * The repayments one month should show, newest first: those ticked against
 * something that falls in the month, plus those with nothing ticked that were
 * made during it. A null month (a trip) means the whole log.
 */
export function settlementsInMonth(s: AppState, ledgerId: string, monthKey: MonthKey | null): Settlement[] {
  const all = settlementsFor(s, ledgerId);
  if (!monthKey) return all;
  return all.filter((x) => settlementMonths(s, x).includes(monthKey));
}

/**
 * How much of a repayment landed on each item it was ticked against, in
 * base-currency cents.
 *
 * The tally only ever moves by the repayment's own amount; the ticked items
 * say what that money was for. When it comes to less than they add up to —
 * a part payment — it is spread over them in proportion to what each one
 * owes, so half of two bills leaves half of each still due rather than one
 * cleared and one untouched. Anything beyond what they add up to lands
 * nowhere: it is money handed over above and beyond those items.
 *
 * Items the repayment names that no longer exist are ignored, so deleting an
 * expense never strands part of a repayment against it.
 */
function allocation(s: AppState, x: Settlement, byId: Map<string, LedgerItem>): Record<string, number> {
  const ids = (x.itemIds || []).filter((id) => byId.has(id));
  if (!ids.length) return {};
  const owed = ids.map((id) => pairwiseDebt(s, byId.get(id)!, x.fromPersonId, x.toPersonId));
  const total = owed.reduce((a, b) => a + b, 0);
  if (total <= 0) return {};

  const out: Record<string, number> = {};
  const paid = cents(toBase(s.settings.rates, x.amount, x.currency, x.fxRate));
  if (paid >= total) {
    ids.forEach((id, i) => { out[id] = owed[i]; });
    return out;
  }
  const share = owed.map((c) => Math.floor((paid * c) / total));
  /* Flooring loses up to one cent per item; the biggest debts take them back,
     the same "someone has to absorb the leftover" rule the splits follow. */
  let left = paid - share.reduce((a, b) => a + b, 0);
  owed
    .map((_, i) => i)
    .sort((a, b) => owed[b] - owed[a])
    .forEach((i) => { if (left > 0 && share[i] < owed[i]) { share[i]++; left--; } });
  ids.forEach((id, i) => { out[id] = share[i]; });
  return out;
}

/** One month of the tally, in base-currency cents. */
export interface MonthTally {
  month: MonthKey;
  /** Net position per person for this month alone. Positive: they are owed. */
  balances: Record<string, number>;
  /** What each person's accounts paid out for this month's entries. */
  paid: Record<string, number>;
  /** What each person handed back in repayments filed under this month. */
  back: Record<string, number>;
}

/**
 * Which month a repayment's money belongs to, cent by cent.
 *
 * The ticked items decide it, each taking the share `allocation` gave it and
 * filing it under its own month — half of July's rent is July's money whenever
 * it was handed over. Whatever is left over is money no item accounts for: a
 * repayment with nothing ticked, the part of one that overshot what it named,
 * or a share that was ticked against an entry since deleted. That has only the
 * date to go on, so it belongs to the month the money moved — the same
 * fallback `settlementMonths` uses for the log.
 */
function settlementByMonth(
  s: AppState,
  x: Settlement,
  byId: Map<string, LedgerItem>,
): Record<MonthKey, number> {
  const out: Record<MonthKey, number> = {};
  const add = (m: MonthKey, c: number): void => { out[m] = (out[m] || 0) + c; };
  let left = cents(toBase(s.settings.rates, x.amount, x.currency, x.fxRate));
  Object.entries(allocation(s, x, byId)).forEach(([id, c]) => {
    const m = itemMonth(s, id);
    if (!m || c <= 0) return;
    add(m, c);
    left -= c;
  });
  if (left > 0) add(monthOf(x.date), left);
  return out;
}

/**
 * The tally cut into months, oldest first — one entry per month anything
 * happened in, and none for the quiet months between.
 *
 * A month's balance is what its own entries did, less the repayments filed
 * under it. Summed, the months come back to `computeBalances`, give or take
 * the cent a joint share can lose to rounding each month rather than once at
 * the end.
 */
export function monthlyBalances(s: AppState, ledgerId: string): MonthTally[] {
  const ids = s.people.map((p) => p.id);
  const months = new Map<MonthKey, MonthTally>();
  const bucket = (m: MonthKey): MonthTally => {
    let t = months.get(m);
    if (!t) {
      t = { month: m, balances: {}, paid: {}, back: {} };
      ids.forEach((id) => { t!.balances[id] = 0; t!.paid[id] = 0; t!.back[id] = 0; });
      months.set(m, t);
    }
    return t;
  };

  itemsInScope(s, ledgerId, null).forEach((it) => {
    /* A bill belongs to the month it is for, which is not always the month it
       is dated: a rule due on the 28th still bills the period it names. */
    const t = bucket(it.kind === 'recurring' ? it.period : monthOf(it.date));
    Object.entries(paidShares(s, it, ids)).forEach(([pid, c]) => { t.paid[pid] += c; });
    Object.entries(itemDeltas(s, it, ids)).forEach(([pid, c]) => { t.balances[pid] += c; });
  });

  const byId = new Map(repayableItems(s, ledgerId).map((it) => [it.id, it]));
  s.settlements
    .filter((x) => x.ledgerId === ledgerId)
    .forEach((x) => {
      Object.entries(settlementByMonth(s, x, byId)).forEach(([m, c]) => {
        const t = bucket(m);
        if (t.balances[x.fromPersonId] != null) { t.balances[x.fromPersonId] += c; t.back[x.fromPersonId] += c; }
        if (t.balances[x.toPersonId] != null) t.balances[x.toPersonId] -= c;
      });
    });

  return [...months.values()]
    .map((t) => {
      ids.forEach((id) => {
        t.balances[id] = Math.round(t.balances[id]);
        t.paid[id] = Math.round(t.paid[id]);
        t.back[id] = Math.round(t.back[id]);
      });
      return t;
    })
    .sort((a, b) => monthIndex(a.month) - monthIndex(b.month));
}

/** One month of the tally, zeroed when nothing at all landed in it. */
export function monthTally(s: AppState, ledgerId: string, monthKey: MonthKey): MonthTally {
  const found = monthlyBalances(s, ledgerId).find((t) => t.month === monthKey);
  if (found) return found;
  const empty: MonthTally = { month: monthKey, balances: {}, paid: {}, back: {} };
  s.people.forEach((p) => { empty.balances[p.id] = 0; empty.paid[p.id] = 0; empty.back[p.id] = 0; });
  return empty;
}

/** Whether a month moved any money at all — spent, or handed back. */
export function monthMoved(t: MonthTally): boolean {
  return Object.keys(t.paid).some((id) => t.paid[id] !== 0 || t.back[id] !== 0);
}

/** One item a repayment can be logged against, and where it stands. */
export interface RepayPick {
  it: LedgerItem;
  /** What this item alone makes `from` owe `to`, in base-currency cents. */
  owed: number;
  /** How much of that earlier repayments already covered. */
  repaid: number;
  /** What is still due: `owed` less `repaid`, never below zero. */
  left: number;
  /** Money that hasn't moved yet — a planned expense, or a bill still to land. */
  ahead: boolean;
}

/**
 * Every item a repayment from `from` to `to` could name, newest first, each
 * with what it still owes after everything already repaid against it.
 *
 * Only repayments running the same way count: money going the other way is
 * its own debt, not a dent in this one. `exceptId` is the repayment being
 * edited — its own share goes back on the table so the form can restate it.
 *
 * What has actually been paid comes first, newest first, because that is what
 * a repayment is nearly always for. What hasn't landed yet follows, soonest
 * first — reachable, but never in the way of the bill you just split.
 */
export function repaymentPicks(
  s: AppState,
  ledgerId: string,
  from: string,
  to: string,
  exceptId?: string | null,
): RepayPick[] {
  const items = repayableItems(s, ledgerId);
  const byId = new Map(items.map((it) => [it.id, it]));
  const now = thisMonth();

  const repaid: Record<string, number> = {};
  s.settlements.forEach((x) => {
    if (x.ledgerId !== ledgerId || (exceptId && x.id === exceptId)) return;
    if (x.fromPersonId !== from || x.toPersonId !== to) return;
    Object.entries(allocation(s, x, byId)).forEach(([id, c]) => { repaid[id] = (repaid[id] || 0) + c; });
  });

  return items
    .map((it) => {
      const owed = pairwiseDebt(s, it, from, to);
      const done = repaid[it.id] || 0;
      return {
        it,
        owed,
        repaid: done,
        left: Math.max(0, owed - done),
        ahead: it.kind === 'recurring' ? monthIndex(it.period) > monthIndex(now) : it.planned,
      };
    })
    .sort((a, b) => {
      if (a.ahead !== b.ahead) return a.ahead ? 1 : -1;
      if (a.it.date === b.it.date) return 0;
      return (a.it.date < b.it.date ? 1 : -1) * (a.ahead ? -1 : 1);
    });
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
