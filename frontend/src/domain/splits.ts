import type { Split } from '../model/types';
import { cents } from '../lib/utils';

/**
 * Divide `totalCents` between people according to a split.
 * Always distributes the total exactly: rounding leftovers go to the first
 * participant (exact mode) or the last one (equal/shares), same as always.
 */
export function splitCents(
  split: Split | null | undefined,
  totalCents: number,
  allPeopleIds: string[],
): Record<string, number> {
  let parts = (split && split.participants && split.participants.length
    ? split.participants
    : allPeopleIds
  ).filter((id) => allPeopleIds.includes(id));
  if (!parts.length) parts = allPeopleIds.slice();

  const out: Record<string, number> = {};
  const mode = (split && split.mode) || 'equal';
  const vals = (split && split.values) || {};

  if (mode === 'exact') {
    let sum = 0;
    parts.forEach((id) => { const c = cents(vals[id]); out[id] = c; sum += c; });
    const diff = totalCents - sum;
    if (diff !== 0) out[parts[0]] = (out[parts[0]] || 0) + diff;
    return out;
  }

  let w = parts.map((id) => (mode === 'shares' ? Number(vals[id]) || 0 : 1));
  if (w.reduce((a, b) => a + b, 0) <= 0) w = parts.map(() => 1);
  const tw = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  parts.forEach((id, i) => {
    const c = i === parts.length - 1 ? totalCents - acc : Math.round((totalCents * w[i]) / tw);
    out[id] = c;
    acc += c;
  });
  return out;
}
