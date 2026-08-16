/** JSON/CSV export, JSON import, and the exchange-rate refresh. */
import { S, UI, baseCur, person, save, setState, accountLabel, toBase } from './context';
import { commit } from './render';
import { closeModal, settingsModal, toast } from './modals';
import { itemsInScope } from '../domain/selectors';
import { settlementsInScope } from '../domain/balances';
import { r2, todayISO } from '../lib/utils';
import type { AppState } from '../model/types';

export function download(name: string, text: string, type?: string): void {
  const b = new Blob([text], { type: type || 'application/json' });
  const u = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1500);
}

export function exportJSON(): void {
  download('piggy-' + todayISO() + '.json', JSON.stringify(S, null, 2));
}

export function exportCSV(): void {
  const rows: (string | number)[][] = [['list', 'type', 'date', 'name', 'amount', 'currency', 'amount_' + baseCur(), 'paid_from', 'method', 'split_mode', 'participants']];
  S.ledgers.forEach((l) => {
    itemsInScope(S, l.id, null, true).forEach((it) => {
      const planned = 'planned' in it && it.planned;
      const sp = it.split || { mode: 'equal', participants: [], values: {} };
      rows.push([l.name, planned ? 'planned' : it.kind, it.date, it.name, r2(it.amount), it.currency, toBase(it.amount, it.currency, it.fxRate),
        accountLabel(it.accountId), it.method || '', sp.mode || 'equal',
        (sp.participants && sp.participants.length ? sp.participants : S.people.map((p) => p.id)).map((i) => person(i)?.name || '').join('+')]);
    });
    settlementsInScope(S, l.id, null).forEach((s) => {
      rows.push([l.name, 'repayment', s.date, s.note || 'Repayment', r2(s.amount), s.currency,
        toBase(s.amount, s.currency, s.fxRate), person(s.fromPersonId)?.name || '', s.method || '', '',
        person(s.toPersonId)?.name || '']);
    });
  });
  download('piggy-expenses.csv', rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n'), 'text/csv');
}

export function importJSONFile(file: File): void {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const d = JSON.parse(String(fr.result)) as AppState;
      if (!d.schemaVersion || !d.people) throw new Error('not a piggy export');
      setState(d);
      UI.ledgerId = (d.ledgers[0] || {}).id ?? null;
      closeModal(); commit(); toast('Imported');
    } catch {
      toast("That file isn't a Piggy export");
    }
  };
  fr.readAsText(file);
}

export async function fetchRates(): Promise<void> {
  const codes = Object.keys(S.settings.rates).filter((c) => c !== baseCur());
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=' + baseCur() + '&symbols=' + codes.join(','));
    const j = (await res.json()) as { rates?: Record<string, number> };
    Object.entries(j.rates || {}).forEach(([c, v]) => {
      if (v > 0) S.settings.rates[c] = r2(1 / v * 10000) / 10000;
    });
    S.settings.ratesUpdatedAt = new Date().toISOString();
    save(); closeModal(); settingsModal(); toast('Rates updated');
  } catch {
    toast("Couldn't reach the rate service — type them in");
  }
}
