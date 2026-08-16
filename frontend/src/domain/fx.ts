import type { CurrencyCode } from '../model/types';
import { r2 } from '../lib/utils';

/** Live rate to base currency; unknown codes count 1:1 rather than crash. */
export function rateOf(rates: Record<CurrencyCode, number>, code: CurrencyCode): number {
  const v = Number(rates[code]);
  return isFinite(v) && v > 0 ? v : 1;
}

/**
 * Convert to base currency. A snapshotted `fxRate` (saved on expenses and
 * settlements) wins over the live table, so old months never change.
 */
export function toBase(
  rates: Record<CurrencyCode, number>,
  amount: number,
  currency: CurrencyCode,
  fxRate?: number | null,
): number {
  const rate = fxRate != null && isFinite(Number(fxRate)) && Number(fxRate) > 0
    ? Number(fxRate)
    : rateOf(rates, currency);
  return r2((Number(amount) || 0) * rate);
}
