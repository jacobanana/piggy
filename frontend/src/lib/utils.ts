import type { ISODate, MonthKey } from '../model/types';

/**
 * Client-generated entity id. A UUID so the same id can become the SQL
 * primary key unchanged when a book syncs to the backend; the prefix is
 * only a debugging nicety and part of the id string itself.
 */
export const uid = (p?: string): string =>
  (p || '') + (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

export const $ = <T extends HTMLElement = HTMLElement>(s: string, r?: ParentNode): T | null =>
  ((r || document).querySelector(s) as T | null);

export const esc = (s: unknown): string =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Round to 2 decimals. */
export const r2 = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;
export const cents = (n: unknown): number => Math.round((Number(n) || 0) * 100);
export const fromCents = (c: number): number => c / 100;

export const todayISO = (): ISODate => new Date().toISOString().slice(0, 10);
export const monthOf = (iso: string): MonthKey => String(iso).slice(0, 7);
export const thisMonth = (): MonthKey => todayISO().slice(0, 7);

export const addMonths = (key: MonthKey, n: number): MonthKey => {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
};
export const monthIndex = (key: MonthKey): number => {
  const [y, m] = key.split('-').map(Number);
  return y * 12 + (m - 1);
};
export const monthFromIndex = (i: number): MonthKey =>
  Math.floor(i / 12) + '-' + String((i % 12) + 1).padStart(2, '0');
export const daysInMonth = (key: MonthKey): number => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};
export const monthLabel = (key: MonthKey): string => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};
export const dayLabel = (iso: ISODate): string => {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

export function money(amount: number, code: string): string {
  const n = r2(amount);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: code, currencyDisplay: 'code', minimumFractionDigits: 2,
    }).format(n).replace(/\u00a0/g, ' ');
  } catch {
    return code + ' ' + n.toFixed(2);
  }
}
