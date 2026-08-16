/**
 * Central mutable app context: the loaded book (S), the view state (UI),
 * entity lookups, and the debounced save.
 *
 * Kept as a module-level singleton on purpose — the app is a small
 * event-delegated DOM app, not a component tree.
 */
import type { AppState, Account, Ledger, Person, Rule } from '../model/types';
import { blankState } from '../model/state';
import { store } from '../storage/store';
import { thisMonth } from '../lib/utils';
import { rateOf as fxRateOf, toBase as fxToBase } from '../domain/fx';

export interface UIState {
  ledgerId: string | null;
  month: string;
  scope: 'month' | 'all';
}

export let S: AppState = blankState();
export const UI: UIState = { ledgerId: null, month: thisMonth(), scope: 'month' };

export function setState(next: AppState): void { S = next; }

let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function save(): void {
  S.meta.updatedAt = new Date().toISOString();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.save(S), 120);
}

/* ---------- lookups ---------- */
export const person = (id: string | undefined): Person | undefined => S.people.find((p) => p.id === id);
export const account = (id: string | undefined): Account | undefined => S.accounts.find((a) => a.id === id);
export const ledger = (id: string | null | undefined): Ledger | undefined => S.ledgers.find((l) => l.id === id);
export const rule = (id: string | undefined): Rule | undefined => S.rules.find((r) => r.id === id);
export const activeLedger = (): Ledger | undefined => ledger(UI.ledgerId) || S.ledgers[0];
export const baseCur = (): string => S.settings.baseCurrency;

export const rateOf = (code: string): number => fxRateOf(S.settings.rates, code);

export function accountLabel(id: string): string {
  const a = account(id);
  if (!a) return '—';
  if (a.kind === 'personal') {
    const p = person(Object.keys(a.ownership)[0]);
    return p ? p.name : a.name;
  }
  return a.name;
}

export function accountEmoji(id: string): string {
  const a = account(id);
  if (!a) return '💰';
  if (a.kind === 'joint') return '💞';
  const p = person(Object.keys(a.ownership)[0]);
  return p ? p.emoji : '💰';
}

/** Convert an amount to the base currency, preferring a snapshotted rate. */
export const toBase = (amount: number, currency: string, fxRate?: number | null): number =>
  fxToBase(S.settings.rates, amount, currency, fxRate);
