import type { AppState, LedgerItem, MonthKey, Settlement } from '../model/types';
import { itemsInScope } from './selectors';
import { splitCents } from './splits';
import { toBase } from './fx';
import { cents, monthOf } from '../lib/utils';

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
 * Net position per person, in base-currency cents.
 * Positive: the others owe them. Paying from an account credits its owners
 * by ownership share; each item's split debits whoever it was for;
 * settlements move the tally back towards zero.
 */
export function computeBalances(s: AppState, ledgerId: string, monthKey: MonthKey | null): Record<string, number> {
  const bal: Record<string, number> = {};
  s.people.forEach((p) => { bal[p.id] = 0; });
  const ids = s.people.map((p) => p.id);

  itemsInScope(s, ledgerId, monthKey).forEach((it) => {
    Object.entries(itemDeltas(s, it, ids)).forEach(([pid, c]) => { bal[pid] += c; });
  });

  s.settlements
    .filter((x) => x.ledgerId === ledgerId && (!monthKey || monthOf(x.date) === monthKey))
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

/** Base-currency cents each person's accounts actually paid out. */
export function paidByTotals(s: AppState, ledgerId: string, monthKey: MonthKey | null): Record<string, number> {
  const out: Record<string, number> = {};
  s.people.forEach((p) => { out[p.id] = 0; });
  itemsInScope(s, ledgerId, monthKey).forEach((it) => {
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

/** Repayments in scope, newest first. */
export function settlementsInScope(s: AppState, ledgerId: string, monthKey: MonthKey | null): Settlement[] {
  return s.settlements
    .filter((x) => x.ledgerId === ledgerId && (!monthKey || monthOf(x.date) === monthKey))
    .sort((a, b) => (a.date === b.date
      ? (b.createdAt || '').localeCompare(a.createdAt || '')
      : a.date < b.date ? 1 : -1));
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
