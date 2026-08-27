import { describe, expect, it } from 'vitest';
import type { CamtTx } from './camt053';
import { classify, detectFrequency, groupKey, suggestEmoji } from './classify';

const tx = (date: string, amountCents: number, party: string, over?: Partial<CamtTx>): CamtTx => ({
  date, amountCents, currency: 'CHF', debit: true, reversal: false, pending: false,
  party, info: '', method: 'card', ...over,
});

describe('groupKey', () => {
  it('sees through reference numbers and payment noise', () => {
    expect(groupKey(tx('2026-01-05', 100, 'COOP-4231 KARTE 21.03')))
      .toBe(groupKey(tx('2026-02-05', 100, 'COOP-1077 KARTE 04.04')));
    expect(groupKey(tx('2026-01-05', 100, 'Netflix International B.V.')))
      .toBe(groupKey(tx('2026-02-05', 100, 'NETFLIX INTERNATIONAL BV')));
  });
  it('keeps different merchants apart', () => {
    expect(groupKey(tx('2026-01-05', 100, 'MIGROS M LAUSANNE')))
      .not.toBe(groupKey(tx('2026-01-06', 100, 'COOP RENENS')));
  });
});

describe('detectFrequency', () => {
  it('hears a monthly rhythm through bank-day drift', () => {
    expect(detectFrequency(['2026-01-01', '2026-02-02', '2026-03-01', '2026-04-01'])).toBe('monthly');
  });
  it('hears quarterly and yearly', () => {
    expect(detectFrequency(['2025-01-10', '2025-04-11', '2025-07-10'])).toBe('quarterly');
    expect(detectFrequency(['2024-05-02', '2025-05-01', '2026-05-03'])).toBe('yearly');
  });
  it('does not invent a bill from too little or from a broken pattern', () => {
    expect(detectFrequency(['2026-01-01', '2026-02-01'])).toBe(null);           // two is coincidence
    expect(detectFrequency(['2026-01-01', '2026-02-01', '2026-05-01'])).toBe(null); // a skipped spring
    expect(detectFrequency(['2026-01-03', '2026-01-10', '2026-01-17'])).toBe(null); // weekly isn't a Piggy cadence
  });
});

describe('classify', () => {
  const statement = [
    // rent: monthly, fixed, on the 1st (give or take a weekend)
    tx('2026-01-01', 185000, 'Régie du Léman', { method: 'transfer' }),
    tx('2026-02-02', 185000, 'Régie du Léman', { method: 'transfer' }),
    tx('2026-03-01', 185000, 'Régie du Léman', { method: 'transfer' }),
    // electricity: quarterly, amounts move around
    tx('2025-10-06', 14230, 'Romande Energie SA', { method: 'direct-debit' }),
    tx('2026-01-07', 19850, 'Romande Energie SA', { method: 'direct-debit' }),
    tx('2026-04-06', 15120, 'Romande Energie SA', { method: 'direct-debit' }),
    // groceries: often, no rhythm
    tx('2026-03-02', 6115, 'MIGROS M LAUSANNE'),
    tx('2026-03-09', 4302, 'MIGROS M RENENS'),
    tx('2026-03-13', 8990, 'MIGROS M LAUSANNE'),
    tx('2026-03-27', 5210, 'MIGROS M LAUSANNE'),
    // once
    tx('2026-03-18', 24900, 'IKEA AUBONNE'),
  ];
  const groups = classify(statement);

  it('classifies recurring, frequent and one-off', () => {
    const rent = groups.find((g) => g.label.startsWith('Régie'))!;
    expect(rent.kind).toBe('recurring');
    expect(rent.frequency).toBe('monthly');
    expect(rent.dueDay).toBe(1);
    expect(rent.amountCents).toBe(185000);
    expect(rent.variable).toBe(false);
    expect(rent.method).toBe('transfer');

    const elec = groups.find((g) => g.label.startsWith('Romande'))!;
    expect(elec.kind).toBe('recurring');
    expect(elec.frequency).toBe('quarterly');
    expect(elec.variable).toBe(true);

    expect(groups.find((g) => g.label.startsWith('MIGROS'))!.kind).toBe('frequent');
    expect(groups.find((g) => g.label.startsWith('IKEA'))!.kind).toBe('one-off');
  });

  it('orders the review: recurring first, one-offs last', () => {
    expect(groups.map((g) => g.kind)).toEqual(['recurring', 'recurring', 'frequent', 'one-off']);
  });

  it('a same-day batch pair is one event, not a rhythm', () => {
    const pair = classify([
      tx('2026-03-09', 6115, 'BAKERY'), tx('2026-03-09', 4320, 'BAKERY'),
      tx('2026-04-09', 6115, 'BAKERY'), tx('2026-04-09', 4320, 'BAKERY'),
    ]);
    expect(pair).toHaveLength(1);
    expect(pair[0].kind).toBe('one-off'); // two distinct days — not enough for a pattern
  });
});

describe('suggestEmoji', () => {
  it('recognises the usual suspects', () => {
    expect(suggestEmoji('MIGROS M LAUSANNE', false)).toBe('🛒');
    expect(suggestEmoji('Netflix International B.V.', true)).toBe('📺');
    expect(suggestEmoji('Régie du Léman Loyer mars', true)).toBe('🏠');
    expect(suggestEmoji('CSS Assurance', true)).toBe('🛡️');
  });
  it('falls back by kind', () => {
    expect(suggestEmoji('SOMETHING NOBODY KNOWS', true)).toBe('🔁');
    expect(suggestEmoji('SOMETHING NOBODY KNOWS', false)).toBe('📦');
  });
});
