import type { AppState } from './types';
import { DEFAULT_RATES } from '../lib/constants';

export const SCHEMA = 1;
export const STORAGE_KEY = 'piggy.ledger.v1';

export function blankState(): AppState {
  return {
    schemaVersion: SCHEMA,
    meta: { appName: 'Piggy', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    settings: {
      theme: 'blueberry',
      baseCurrency: 'CHF',
      currencies: ['CHF', 'EUR', 'USD'],
      rates: { ...DEFAULT_RATES },
      ratesUpdatedAt: null,
    },
    people: [], accounts: [], ledgers: [], rules: [], overrides: [], expenses: [], settlements: [],
  };
}

/** Repair a loaded (possibly older/partial) state so the app can always boot. */
export function normalize(loaded: unknown): AppState {
  const s = (loaded && (loaded as AppState).people ? (loaded as AppState) : blankState());
  if (!s.meta) s.meta = blankState().meta;
  if (!s.settings) s.settings = blankState().settings;
  if (!s.settings.rates) s.settings.rates = { ...DEFAULT_RATES };
  (['people', 'accounts', 'ledgers', 'rules', 'overrides', 'expenses', 'settlements'] as const)
    .forEach((k) => { if (!Array.isArray(s[k])) (s as unknown as Record<string, unknown>)[k] = []; });
  if (!s.settings.rates[s.settings.baseCurrency]) s.settings.rates[s.settings.baseCurrency] = 1;
  return s;
}
