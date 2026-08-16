import type { Account, AppState, Expense, LedgerItem, MonthKey, Occurrence } from '../model/types';
import { occurrence, ruleHitsMonth } from './recurrence';
import { splitCents } from './splits';
import { toBase } from './fx';
import { cents, monthFromIndex, monthIndex, monthOf, thisMonth, addMonths } from '../lib/utils';

/**
 * Which account to pre-select as the payer of a new entry.
 *
 * Whoever is filling the form nearly always paid for it themselves, so their
 * own account leads: a personal one first, then any pot they hold a share of.
 * With nobody signed in — the Pages build, or a member who hasn't said which
 * person they are — it stays the first account, exactly as it always was.
 */
export function defaultAccountId(accounts: Account[], personId: string | null): string | undefined {
  const mine = (a: Account): boolean => !!personId && (a.ownership[personId] || 0) > 0;
  const own = accounts.find((a) => a.kind === 'personal' && mine(a)) || accounts.find(mine);
  return (own || accounts[0])?.id;
}

export const overrideOf = (s: AppState, ruleId: string, period: MonthKey) =>
  s.overrides.find((o) => o.ruleId === ruleId && o.period === period);

/** Every recurring bill landing in a month, soonest first. */
export function occurrencesFor(s: AppState, ledgerId: string, monthKey: MonthKey): Occurrence[] {
  return s.rules
    .filter((r) => r.ledgerId === ledgerId && ruleHitsMonth(r, monthKey))
    .map((r) => occurrence(r, monthKey, overrideOf(s, r.id, monthKey)))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** The next few non-monthly bills on the horizon. */
export function upcomingRules(s: AppState, ledgerId: string, fromMonth: MonthKey, months: number): Occurrence[] {
  const out: Occurrence[] = [];
  for (let i = 1; i <= months; i++) {
    const mk = addMonths(fromMonth, i);
    s.rules
      .filter((r) => r.ledgerId === ledgerId && r.frequency !== 'monthly' && ruleHitsMonth(r, mk))
      .forEach((r) => {
        const o = occurrence(r, mk, overrideOf(s, r.id, mk));
        if (!o.skipped) out.push(o);
      });
  }
  return out.slice(0, 4);
}

/** Every occurrence from the earliest rule start up to the current month. */
export function allOccurrencesEver(s: AppState, ledgerId: string): Occurrence[] {
  const rs = s.rules.filter((r) => r.ledgerId === ledgerId);
  if (!rs.length) return [];
  const from = Math.min(...rs.map((r) => monthIndex(r.startMonth || thisMonth())));
  const to = Math.max(from, monthIndex(thisMonth()));
  const out: Occurrence[] = [];
  for (let i = from; i <= to; i++) {
    const mk = monthFromIndex(i);
    occurrencesFor(s, ledgerId, mk).forEach((o) => { if (!o.skipped) out.push(o); });
  }
  return out;
}

/**
 * Everything that actually cost money in scope (a month, or all time when
 * monthKey is null). Planned entries are money that hasn't moved yet, so they
 * stay out of every total that describes reality — pass withPlanned for the
 * budgeting view instead.
 */
export function itemsInScope(
  s: AppState,
  ledgerId: string,
  monthKey: MonthKey | null,
  withPlanned?: boolean,
): LedgerItem[] {
  const ad = s.expenses
    .filter((e) => e.ledgerId === ledgerId && (!monthKey || monthOf(e.date) === monthKey) && (withPlanned || !e.planned))
    .map((e) => ({ ...e, kind: 'adhoc' as const }));
  const rec = monthKey
    ? occurrencesFor(s, ledgerId, monthKey).filter((o) => !o.skipped)
    : allOccurrencesEver(s, ledgerId);
  return [...rec, ...ad];
}

/** Booked-but-not-paid entries, soonest first — it's a to-pay list. */
export function plannedInScope(s: AppState, ledgerId: string, monthKey: MonthKey | null): (Expense & { kind: 'adhoc' })[] {
  return s.expenses
    .filter((e) => e.ledgerId === ledgerId && e.planned && (!monthKey || monthOf(e.date) === monthKey))
    .map((e) => ({ ...e, kind: 'adhoc' as const }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** What each person's share of a planned list will be, once it's all paid. */
export function plannedShares(s: AppState, list: LedgerItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  s.people.forEach((p) => { out[p.id] = 0; });
  const ids = s.people.map((p) => p.id);
  list.forEach((it) => {
    const owed = splitCents(it.split, cents(toBase(s.settings.rates, it.amount, it.currency, it.fxRate)), ids);
    Object.entries(owed).forEach(([pid, c]) => { if (out[pid] != null) out[pid] += c; });
  });
  return out;
}
