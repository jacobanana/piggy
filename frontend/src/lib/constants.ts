import type { Frequency } from '../model/types';

export const CATEGORIES: [string, string][] = [
  ['🏠', 'Home & rent'], ['💡', 'Utilities'], ['🛒', 'Groceries'], ['🌐', 'Internet & phone'],
  ['🛡️', 'Insurance'], ['🚆', 'Transport'], ['📺', 'Subscriptions'], ['💊', 'Health'],
  ['🧹', 'Cleaning'], ['🍜', 'Eating out'], ['🎉', 'Fun'], ['✈️', 'Travel'], ['🏨', 'Stay'],
  ['🎁', 'Gifts'], ['🐾', 'Pets'], ['👶', 'Kids'], ['🛋️', 'Furniture'], ['💅', 'Personal'],
  ['🍷', 'Drinks'], ['⛽', 'Car'], ['📦', 'Other'],
];

export interface Theme {
  label: string;
  ink: string; inkSoft: string; paper: string; paperA: string;
  glow1: string; glow2: string; glow3: string;
  tint: string; tint2: string; line: string;
  accent: string; mint: string; butter: string; sky: string; grape: string;
}

export const THEMES: Record<string, Theme> = {
  blueberry: { label: 'Blueberry', ink: '#23264F', inkSoft: '#6E739B', paper: '#F2F4FF', paperA: 'rgba(242,244,255,.85)',
    glow1: '#DDE4FF', glow2: '#D9F3F2', glow3: '#FFF0D6', tint: '#EEF1FF', tint2: '#FAFBFF', line: '#DFE3F2',
    accent: '#5A67E8', mint: '#17B39A', butter: '#FFB43D', sky: '#3EA7E8', grape: '#9B6DFF' },
  citrus: { label: 'Citrus', ink: '#3A2A1E', inkSoft: '#8A7259', paper: '#FFF8EE', paperA: 'rgba(255,248,238,.85)',
    glow1: '#FFE6C9', glow2: '#DDF3EC', glow3: '#FFF3C9', tint: '#FFF1DE', tint2: '#FFFCF6', line: '#F0E3D2',
    accent: '#F2683C', mint: '#1EA98D', butter: '#F5B400', sky: '#3FA9C9', grape: '#C07BE8' },
  meadow: { label: 'Meadow', ink: '#1E3A2E', inkSoft: '#5F7D6C', paper: '#F3FBF3', paperA: 'rgba(243,251,243,.85)',
    glow1: '#D8F0DC', glow2: '#E9F7CF', glow3: '#FFF1D8', tint: '#EAF6EA', tint2: '#FAFDF9', line: '#DCE9DC',
    accent: '#1FA968', mint: '#0FA3A3', butter: '#F2A93B', sky: '#3E8BD8', grape: '#8E7BE8' },
  midnight: { label: 'Midnight', ink: '#1B2440', inkSoft: '#6A7495', paper: '#EDF1F7', paperA: 'rgba(237,241,247,.85)',
    glow1: '#DCE6F5', glow2: '#E4DEF7', glow3: '#D9F0EA', tint: '#E9EEF7', tint2: '#F9FBFE', line: '#D9E0EC',
    accent: '#2F3E64', mint: '#12A594', butter: '#E0A02C', sky: '#4A90D9', grape: '#7C6BD4' },
  bubblegum: { label: 'Bubblegum', ink: '#2B2440', inkSoft: '#6C6484', paper: '#FFF1F4', paperA: 'rgba(255,241,244,.82)',
    glow1: '#FFE3EC', glow2: '#E4F6F1', glow3: '#FFF6DE', tint: '#FDF1F5', tint2: '#FFFBFC', line: '#E7DFEA',
    accent: '#FF5C8A', mint: '#18BFA0', butter: '#FFCB47', sky: '#6C8CFF', grape: '#A97BFF' },
};

export const METHODS: [string, string][] = [
  ['card', '💳 Card'], ['direct-debit', '🔁 Direct debit'], ['transfer', '🏦 Bank transfer'],
  ['cash', '💵 Cash / on the spot'], ['twint', '📲 Twint / app'], ['other', '✨ Other'],
];

/* how a repayment actually travelled — person to person, so no card or direct debit */
export const PAY_METHODS: [string, string][] = [
  ['cash', '💵 Cash'], ['transfer', '🏦 Transfer'], ['twint', '📲 Twint / app'], ['other', '✨ Other'],
];
export const PAY_LABEL = (m: string): string => {
  const f = PAY_METHODS.find((x) => x[0] === m);
  return f ? f[1] : '';
};

export const FREQS: [Frequency, string][] = [
  ['monthly', 'Every month'], ['bimonthly', 'Every 2 months'], ['quarterly', 'Every 3 months'],
  ['semiannual', 'Every 6 months'], ['yearly', 'Once a year'],
];
export const FREQ_STEP: Record<Frequency, number> = { monthly: 1, bimonthly: 2, quarterly: 3, semiannual: 6, yearly: 12 };
export const FREQ_TAG: Record<Frequency, string> = {
  monthly: 'monthly', bimonthly: '2-monthly', quarterly: 'quarterly', semiannual: '6-monthly', yearly: 'yearly',
};

export const DEFAULT_RATES: Record<string, number> = {
  CHF: 1, EUR: 0.94, USD: 0.81, GBP: 1.09, JPY: 0.0053, SEK: 0.085, NOK: 0.077, DKK: 0.126,
  CZK: 0.037, PLN: 0.22, HUF: 0.0024, THB: 0.024, TRY: 0.021, CAD: 0.59, AUD: 0.53,
};
