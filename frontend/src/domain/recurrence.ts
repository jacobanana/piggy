import type { MonthKey, Occurrence, Rule, RuleOverride } from '../model/types';
import { FREQ_STEP } from '../lib/constants';
import { daysInMonth, monthIndex } from '../lib/utils';

/** Does this rule produce a bill in the given month? */
export function ruleHitsMonth(r: Rule, monthKey: MonthKey): boolean {
  if (!r.active) return false;
  if (r.startMonth && monthIndex(monthKey) < monthIndex(r.startMonth)) return false;
  if (r.endMonth && monthIndex(monthKey) > monthIndex(r.endMonth)) return false;
  const step = FREQ_STEP[r.frequency] || 1;
  const anchor = monthIndex(r.startMonth || monthKey);
  return (((monthIndex(monthKey) - anchor) % step) + step) % step === 0;
}

/** Materialise a rule for one month, applying that month's override if any. */
export function occurrence(r: Rule, monthKey: MonthKey, ov?: RuleOverride | null): Occurrence {
  const o = ov || ({} as Partial<RuleOverride>);
  const day = Math.min(r.dueDay || 1, daysInMonth(monthKey));
  return {
    kind: 'recurring',
    id: r.id + '|' + monthKey,
    ruleId: r.id,
    period: monthKey,
    ledgerId: r.ledgerId,
    date: o.date || monthKey + '-' + String(day).padStart(2, '0'),
    name: r.name,
    emoji: r.emoji,
    amount: o.amount != null ? o.amount : r.amount,
    currency: o.currency || r.currency,
    fxRate: null,
    accountId: o.accountId || r.accountId,
    method: r.method,
    split: o.split || r.split,
    frequency: r.frequency,
    skipped: !!o.skipped,
    notes: r.notes || '',
  };
}
