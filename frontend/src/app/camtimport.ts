/**
 * The bank-statement importer's screen side: pick a camt.053 file, show what
 * the classifier made of it, and turn the ticked rows into book data.
 *
 * The security posture, stated once and kept everywhere: the file is read
 * with FileReader and parsed by domain/camt053.ts *in this page* — it is
 * never uploaded, never persisted, and the parsed statement lives only in
 * this module's state, which is dropped the moment the sheet closes. The
 * only thing that outlives the sheet is what the reader ticked, as ordinary
 * expenses and bills. Everything drawn from the file goes through esc().
 */
import type { Split } from '../model/types';
import { S, activeLedger, baseCur, oneAccount, rateOf, accountEmoji, accountLabel } from './context';
import { commit } from './render';
import { closeModal, head, openModal, setModalCleanup, toast } from './modals';
import { myPersonId } from './session';
import { parseCamt053, type CamtStatement, type CamtTx } from '../domain/camt053';
import { classify, type TxGroup } from '../domain/classify';
import { defaultAccountId } from '../domain/selectors';
import { DEFAULT_RATES, FREQ_STEP, FREQ_TAG } from '../lib/constants';
import { $, addMonths, dayLabel, esc, fromCents, money, monthOf, uid } from '../lib/utils';

/** 10 MB is a decade of statements; anything bigger is not a statement. */
const MAX_FILE = 10 * 1024 * 1024;

interface CamtState {
  statements: CamtStatement[];
  groups: TxGroup[];
  left: { credits: number; pending: number; reversals: number };
  /** Ticked groups (every group starts ticked when it has anything new). */
  on: Set<string>;
  /** Recurring groups that should also become a recurring bill. */
  rules: Set<string>;
  /** Transactions already in the book — shown, never imported twice. */
  dups: Set<string>;
}

let C: CamtState | null = null;

const txKey = (date: string, currency: string, amountCents: number): string =>
  date + '|' + currency + '|' + amountCents;

/* ---------- picking the file ---------- */

export function openCamtPicker(): void {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.xml,text/xml,application/xml';
  inp.addEventListener('change', () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    if (file.size > MAX_FILE) { toast('That file is too big to be a statement'); return; }
    const fr = new FileReader();
    fr.onload = () => {
      try {
        review(parseCamt053(String(fr.result)));
      } catch (err) {
        toast(err instanceof Error ? err.message : "Couldn't read that file");
      }
    };
    fr.readAsText(file);
  });
  inp.click();
}

/* ---------- the review sheet ---------- */

function review(statements: CamtStatement[]): void {
  const booked = statements.flatMap((st) => st.txs).filter((t) => !t.pending && !t.reversal);
  const spends = booked.filter((t) => t.debit);
  const all = statements.flatMap((st) => st.txs);
  if (!spends.length) { toast('No payments out in that statement'); return; }

  const l = activeLedger();
  if (!l) { toast('Open a list first'); return; }
  const existing = new Set(
    S.expenses.filter((e) => e.ledgerId === l.id)
      .map((e) => txKey(e.date, e.currency, Math.round(e.amount * 100))),
  );
  const dups = new Set<string>();
  spends.forEach((t) => { const k = txKey(t.date, t.currency, t.amountCents); if (existing.has(k)) dups.add(k); });

  const groups = classify(spends);
  C = {
    statements, groups, dups,
    left: {
      credits: all.filter((t) => !t.debit && !t.reversal && !t.pending).length,
      pending: all.filter((t) => t.pending).length,
      reversals: all.filter((t) => t.reversal).length,
    },
    on: new Set(), rules: new Set(),
  };
  C.on = new Set(groups.filter((g) => newTxs(g).length).map((g) => g.key));
  C.rules = new Set(groups.filter((g) => g.kind === 'recurring').map((g) => g.key));
  openModal(sheet(), () => setModalCleanup(() => { C = null; }));
}

const newTxs = (g: TxGroup): CamtTx[] =>
  g.txs.filter((t) => !C!.dups.has(txKey(t.date, t.currency, t.amountCents)));

const groupMoney = (g: TxGroup): string => money(fromCents(g.amountCents), g.txs[0].currency);

function kindTag(g: TxGroup): string {
  if (g.kind === 'recurring') return '<span class="tag t-freq">' + FREQ_TAG[g.frequency!] + '</span>';
  if (g.kind === 'frequent') return '<span class="tag t-joint">no fixed rhythm</span>';
  return '';
}

function groupRow(g: TxGroup): string {
  const fresh = newTxs(g);
  const on = C!.on.has(g.key);
  const dead = !fresh.length;
  const dupNote = fresh.length === g.txs.length ? '' :
    dead ? '<span class="tag">already in the book</span>'
      : '<span class="tag">' + (g.txs.length - fresh.length) + ' already in</span>';
  const meta = g.kind === 'one-off'
    ? '<span>' + dayLabel(g.txs[0].date) + '</span>'
    : '<span>' + g.txs.length + '×' + (g.kind === 'recurring' ? ' · day ' + g.dueDay : '') +
      (g.variable ? ' · ~' : ' · ') + groupMoney(g) + '</span>';
  const row = '<div class="item ' + (on ? 'on' : '') + (dead ? ' skip' : '') + '"' +
    (dead ? '' : ' data-act="camt-grp" data-id="' + esc(g.key) + '"') + '>' +
    '<span class="tick">' + (on ? '✓' : '') + '</span>' +
    '<div class="emo">' + esc(g.emoji) + '</div>' +
    '<div class="item-main"><div class="name">' + esc(g.label) + '</div>' +
    '<div class="meta">' + meta + kindTag(g) + dupNote + '</div></div>' +
    '<div class="amount">' + (g.kind === 'one-off' ? groupMoney(g)
      : money(fromCents(g.txs.reduce((s, t) => s + t.amountCents, 0)), g.txs[0].currency)) + '</div></div>';
  if (g.kind !== 'recurring' || dead) return row;
  const mk = C!.rules.has(g.key);
  return '<div class="itemcard ' + (on ? 'on' : '') + '">' + row +
    '<div class="itembar"><button class="' + (mk ? 'go' : '') + '" data-act="camt-rule" data-id="' + esc(g.key) + '">' +
    (mk ? '✓ Will become a recurring bill' : '＋ Also add as a recurring bill') + '</button></div></div>';
}

function section(title: string, gs: TxGroup[]): string {
  if (!gs.length) return '';
  return '<div class="receipt-title" style="text-align:left;margin:16px 0 8px">' + title + '</div>' +
    '<div class="list">' + gs.map(groupRow).join('') + '</div>';
}

function counts(): { exp: number; bills: number } {
  let exp = 0;
  C!.groups.forEach((g) => { if (C!.on.has(g.key)) exp += newTxs(g).length; });
  const bills = C!.groups.filter((g) => g.kind === 'recurring' && C!.rules.has(g.key) && newTxs(g).length).length;
  return { exp, bills };
}

function goLabel(): string {
  const { exp, bills } = counts();
  if (!exp && !bills) return 'Nothing ticked';
  return 'Add ' + exp + ' expense' + (exp === 1 ? '' : 's') + (bills ? ' · ' + bills + ' bill' + (bills === 1 ? '' : 's') : '');
}

function sheet(): string {
  const st = C!.statements;
  const span = (s: CamtStatement): string => {
    const dates = s.txs.map((t) => t.date).sort();
    const from = s.from || dates[0] || '';
    const to = s.to || dates[dates.length - 1] || '';
    return from && to ? dayLabel(from) + ' → ' + dayLabel(to) : '';
  };
  const summary = st.map((s) =>
    '<div class="rrow"><span>🏦 ' + esc(s.account || 'account') + '</span><span class="dots"></span>' +
    '<span class="val">' + esc(span(s)) + '</span></div>').join('');
  const { credits, pending, reversals } = C!.left;
  const left = [
    credits ? credits + ' received' : '',
    pending ? pending + ' still pending' : '',
    reversals ? reversals + ' reversed' : '',
  ].filter(Boolean).join(', ');

  const groups = C!.groups;
  const dupCount = groups.reduce((n, g) => n + (g.txs.length - newTxs(g).length), 0);
  return head('Bank statement') + `
    <div class="hint" style="margin:-6px 0 12px">🔒 Read on this device only — the file was parsed right here and never uploaded or kept. Only what you tick below goes in the book.</div>
    ${summary}
    ${left || dupCount ? '<div class="hint" style="margin:4px 0 0">Left out: ' + esc([left, dupCount ? dupCount + ' already in the book' : ''].filter(Boolean).join(' · ')) + '. Piggy tracks spending, so money in stays out.</div>' : ''}
    ${oneAccount() ? '' : '<div class="field" style="margin-top:14px"><label>Paid from</label><select class="input" id="camtAcc">' +
      S.accounts.map((a) => '<option value="' + a.id + '" ' + (a.id === defaultAccountId(S.accounts, myPersonId()) ? 'selected' : '') + '>' +
        accountEmoji(a.id) + ' ' + esc(accountLabel(a.id)) + '</option>').join('') + '</select>' +
      '<div class="hint">Every imported expense is paid from this account and split evenly — open any of them afterwards to change either.</div></div>'}
    ${section('🔁 Looks recurring', groups.filter((g) => g.kind === 'recurring'))}
    ${section('🧺 Often, no fixed rhythm', groups.filter((g) => g.kind === 'frequent'))}
    ${section('🧾 One-offs', groups.filter((g) => g.kind === 'one-off'))}
    <button class="btn primary wide" style="margin-top:16px" id="camtGo" data-act="camt-go" ${counts().exp || counts().bills ? '' : 'disabled'}>${goLabel()}</button>
    <div class="hint">Recurring bills are added from next month on, so the months the statement already covers aren't counted twice.</div>`;
}

function refreshGo(): void {
  const b = $('#camtGo') as HTMLButtonElement | null;
  if (!b) return;
  const { exp, bills } = counts();
  b.disabled = !exp && !bills;
  b.textContent = goLabel();
}

export function toggleCamtGroup(key: string, el: HTMLElement): void {
  if (!C) return;
  const on = !C.on.has(key);
  if (on) C.on.add(key); else C.on.delete(key);
  el.classList.toggle('on', on);
  el.closest('.itemcard')?.classList.toggle('on', on);
  const tick = el.querySelector('.tick');
  if (tick) tick.textContent = on ? '✓' : '';
  refreshGo();
}

export function toggleCamtRule(key: string, el: HTMLElement): void {
  if (!C) return;
  const on = !C.rules.has(key);
  if (on) C.rules.add(key); else C.rules.delete(key);
  el.classList.toggle('go', on);
  el.textContent = on ? '✓ Will become a recurring bill' : '＋ Also add as a recurring bill';
  refreshGo();
}

/* ---------- turning ticks into book data ---------- */

export function importCamt(): void {
  const c = C;
  const l = activeLedger();
  if (!c || !l) return;
  const accountId = ($('#camtAcc') as HTMLSelectElement | null)?.value
    || defaultAccountId(S.accounts, myPersonId()) || '';
  const everyone = (): Split => ({ mode: 'equal', participants: S.people.map((p) => p.id), values: {} });
  const createdAt = new Date().toISOString();
  const seen = new Set<string>();
  let exp = 0, bills = 0;

  const withRates = (cur: string): number => {
    if (cur !== baseCur() && !S.settings.rates[cur]) {
      S.settings.rates[cur] = DEFAULT_RATES[cur] || 1;
      if (!S.settings.currencies.includes(cur)) S.settings.currencies.push(cur);
    }
    return cur === baseCur() ? 1 : rateOf(cur);
  };

  c.groups.forEach((g) => {
    if (c.on.has(g.key)) {
      newTxs(g).forEach((tx) => {
        // The same movement twice in one statement window is a duplicate too.
        const k = txKey(tx.date, tx.currency, tx.amountCents);
        if (seen.has(k)) return;
        seen.add(k);
        S.expenses.push({
          id: uid('exp_'), ledgerId: l.id,
          name: g.kind === 'one-off' ? (tx.party.trim().slice(0, 60) || g.label) : g.label,
          emoji: g.emoji,
          amount: fromCents(tx.amountCents), currency: tx.currency, fxRate: withRates(tx.currency),
          date: tx.date, accountId, method: tx.method, planned: false,
          split: everyone(), notes: '', createdAt,
        });
        exp += 1;
      });
    }
    if (g.kind === 'recurring' && c.rules.has(g.key) && g.frequency && newTxs(g).length) {
      const already = S.rules.some((r) => r.ledgerId === l.id && r.name.toLowerCase() === g.label.toLowerCase());
      if (!already) {
        const cur = g.txs[0].currency;
        withRates(cur);
        S.rules.push({
          id: uid('rule_'), ledgerId: l.id, name: g.label, emoji: g.emoji,
          amount: fromCents(g.amountCents), currency: cur, frequency: g.frequency,
          dueDay: g.dueDay,
          /* The statement's months come in as expenses above; the bill starts
             one beat later, so nothing is ever counted twice. */
          startMonth: addMonths(monthOf(g.txs[g.txs.length - 1].date), FREQ_STEP[g.frequency]),
          endMonth: null, accountId, method: g.method, split: everyone(),
          active: true,
          notes: g.variable ? 'From a bank statement — the amount varies, this is the usual one.' : 'From a bank statement.',
          createdAt,
        });
        bills += 1;
      }
    }
  });

  C = null;
  closeModal(); commit();
  toast(exp || bills
    ? 'Added ' + exp + ' expense' + (exp === 1 ? '' : 's') + (bills ? ' and ' + bills + ' recurring bill' + (bills === 1 ? '' : 's') : '') + ' 🎉'
    : 'Nothing to add');
}
