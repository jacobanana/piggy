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
import { syncBookName } from './session';
import { thisMonth } from '../lib/utils';
import { rateOf as fxRateOf, toBase as fxToBase } from '../domain/fx';

/** `month` scopes the expense lists only — the tally always spans the ledger. */
export interface UIState {
  ledgerId: string | null;
  month: string;
}

export let S: AppState = blankState();
export const UI: UIState = { ledgerId: null, month: thisMonth() };

export function setState(next: AppState): void { S = next; }

/**
 * Swap the whole book out — erasing it, or loading a file into it — without
 * taking its name along.
 *
 * `meta.appName` is not a label this build owns: on the self-hosted build it
 * *is* the shared piggy bank's name, because the sync endpoint writes it
 * straight to `Book.name`. So replacing the state renamed the bank for
 * everybody in it — an import called it whatever the file did. A bank is
 * named in exactly two places, the switcher when it is made and the name box
 * in this piggy bank's settings, and loading a file into it is neither.
 *
 * `keepName` is false only for a local import, where the export is a
 * whole-app backup and the name in it is part of what is being restored —
 * there is no shared bank there to rename.
 */
export function replaceState(next: AppState, keepName: boolean): void {
  const was = S.meta.appName;
  S = next;
  if (keepName && was) S.meta.appName = was;
  syncBookName(S.meta.appName);
}

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

/**
 * A book with one person on it. There is nobody to owe and nobody to repay,
 * so every field about who paid whom — the tally, the repayment log, the
 * split editor — is left out rather than shown with one answer in it.
 */
export const solo = (): boolean => S.people.length === 1;

/** One place the money can come from, so "paid from" is not a question. */
export const oneAccount = (): boolean => S.accounts.length < 2;

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
