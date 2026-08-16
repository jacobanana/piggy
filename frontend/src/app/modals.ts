/** Modal forms and their save handlers. Transient form state lives in F. */
import type { Account, Expense, Ledger, LedgerItem, Person, Rule, Settlement, Split, SplitMode } from '../model/types';
import { S, UI, account, activeLedger, baseCur, ledger, person, rateOf, rule, accountEmoji, accountLabel } from './context';
import { COLORS } from './theme';
import { avatar, commit } from './render';
import { myPersonId, onServer, session } from './session';
import { repaintIfOwed } from './sync';
import { CATEGORIES, FREQS, FREQ_TAG, METHODS, PAY_METHODS, THEMES } from '../lib/constants';
import { $, dayLabel, esc, fromCents, monthLabel, monthOf, r2, todayISO, uid } from '../lib/utils';
import { computeBalances, pairwiseDebt, settledItemIds, simplifyDebts } from '../domain/balances';
import { occurrence } from '../domain/recurrence';
import { defaultAccountId, itemsInScope, overrideOf } from '../domain/selectors';

/** Transient form state (emoji + split being edited, etc.). Cleared on close. */
export const F: {
  emoji?: string; color?: string; kind?: string; own?: Record<string, number>;
  method?: string; planned?: boolean; skip?: boolean; active?: boolean;
  split?: { mode: SplitMode; participants: string[]; values: Record<string, number | string> };
  /** Ledger items a repayment is being logged against, in the order ticked. */
  items?: string[];
  /** The repayment being edited, if any — its own items stay pickable. */
  settleId?: string;
  /** The amount the repayment form opened with, and the last one it filled in
      by itself — the pair is how a hand-typed override is recognised. */
  openAmount?: string; autoAmount?: string;
} = {};

function clearF(): void { (Object.keys(F) as (keyof typeof F)[]).forEach((k) => delete F[k]); }

export function openModal(html: string, onMount?: () => void): void {
  const root = $('#modalRoot');
  if (!root) return;
  root.innerHTML = '<div class="backdrop" data-act="backdrop"><div class="modal" data-stop>' +
    '<div class="grab"></div>' + html + '</div></div>';
  document.body.style.overflow = 'hidden';
  if (onMount) onMount();
}

export function closeModal(): void {
  const root = $('#modalRoot');
  if (root) root.innerHTML = '';
  document.body.style.overflow = '';
  clearF();
  repaintIfOwed();   // the sync poll may have landed while this was on top
}

export function toast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

export function head(title: string, extra?: string): string {
  return '<div class="modal-head"><h3>' + title + '</h3>' + (extra || '') + '<button class="icon-btn" data-act="close">✕</button></div>';
}

function emojiPicker(sel: string): string {
  return '<div class="emopick" id="emoPick">' + CATEGORIES.map((c) =>
    '<button type="button" data-act="emo" data-v="' + c[0] + '" class="' + (c[0] === sel ? 'on' : '') + '" title="' + c[1] + '">' + c[0] + '</button>').join('') + '</div>';
}
function curOptions(sel: string): string {
  const list = Array.from(new Set([baseCur(), ...S.settings.currencies, ...Object.keys(S.settings.rates)]));
  return list.map((c) => '<option value="' + c + '" ' + (c === sel ? 'selected' : '') + '>' + c + '</option>').join('');
}
function accountOptions(sel?: string): string {
  return S.accounts.map((a) => '<option value="' + a.id + '" ' + (a.id === sel ? 'selected' : '') + '>' + accountEmoji(a.id) + ' ' + esc(accountLabel(a.id)) + '</option>').join('');
}
function methodOptions(sel?: string): string {
  return METHODS.map((m) => '<option value="' + m[0] + '" ' + (m[0] === sel ? 'selected' : '') + '>' + m[1] + '</option>').join('');
}

/* ---------- split editor ---------- */
export function splitBox(): string {
  const sp = F.split!;
  const mode = sp.mode;
  let inner: string;
  if (mode === 'equal') {
    inner = '<div class="chips">' + S.people.map((p) => {
      const on = sp.participants.includes(p.id);
      return '<button type="button" class="chip ' + (on ? 'on' : '') + '" data-act="split-who" data-id="' + p.id + '">' +
        '<span class="tick">' + (on ? '✓' : '') + '</span>' + avatar(p, 'sm') + esc(p.name) + '</button>';
    }).join('') + '</div><div class="hint">Split evenly between everyone ticked. Untick one person and the other pays it all.</div>';
  } else {
    inner = S.people.map((p) => {
      const on = sp.participants.includes(p.id);
      return '<div class="splitrow"><button type="button" class="chip ' + (on ? 'on' : '') + '" data-act="split-who" data-id="' + p.id + '" style="flex:1">' +
        '<span class="tick">' + (on ? '✓' : '') + '</span>' + avatar(p, 'sm') + esc(p.name) + '</button>' +
        '<input class="input" inputmode="decimal" data-act="split-val" data-id="' + p.id + '" value="' + (sp.values[p.id] != null ? sp.values[p.id] : '') + '" placeholder="' + (mode === 'shares' ? '1' : '0.00') + '"></div>';
    }).join('') + '<div class="hint">' + (mode === 'shares'
      ? 'Weights, not money — 2 and 1 means two thirds / one third.'
      : 'Exact amounts in the expense currency. Any rounding difference goes to the first person.') + '</div>';
  }
  return '<div class="seg" style="margin-bottom:10px">' +
    ([['equal', 'Evenly'], ['shares', 'By shares'], ['exact', 'Exact']] as const).map((m) =>
      '<button type="button" data-act="split-mode" data-v="' + m[0] + '" class="' + (mode === m[0] ? 'on' : '') + '">' + m[1] + '</button>').join('') +
    '</div>' + inner;
}
export function refreshSplit(): void {
  const el = $('#splitBox');
  if (el) el.innerHTML = splitBox();
}
function readSplit(): Split {
  const f = F.split!;
  const sp: Split = { mode: f.mode, participants: f.participants.slice(), values: {} };
  if (sp.mode !== 'equal') {
    Object.entries(f.values).forEach(([k, v]) => { if (sp.participants.includes(k)) sp.values[k] = Number(v) || 0; });
  }
  if (!sp.participants.length) sp.participants = S.people.map((p) => p.id);
  return sp;
}
function initSplit(split?: Split | null): void {
  F.split = {
    mode: (split && split.mode) || 'equal',
    participants: split && split.participants && split.participants.length ? split.participants.slice() : S.people.map((p) => p.id),
    values: Object.assign({}, split && split.values),
  };
}

/* ---------- shared money fields ---------- */
function moneyFields(amount: number | string | undefined, currency: string, fxRate?: number | null, withRate?: boolean): string {
  const foreign = currency !== baseCur() && withRate !== false;
  return `<div class="field"><label>Amount</label>
    <div class="amt-row">
      <input class="input" id="fAmount" inputmode="decimal" value="${amount != null ? amount : ''}" placeholder="0.00">
      <select class="input" id="fCur">${curOptions(currency)}</select>
    </div></div>
    ${withRate === false ? '<div class="hint" style="margin-top:-6px">Foreign bills use the live rate from settings, so they follow the exchange rate over time.</div>' : ''}
    <div class="field" id="rateRow" style="${withRate === false ? 'display:none' : foreign ? '' : 'display:none'}">
      <label>Rate — 1 <span id="rateCode">${esc(currency)}</span> = ? ${esc(baseCur())}</label>
      <input class="input mono" id="fRate" inputmode="decimal" value="${fxRate != null ? fxRate : rateOf(currency)}">
      <div class="hint">Saved with the expense so old months never change.</div>
    </div>`;
}
function wireMoney(): void {
  const cur = $<HTMLSelectElement>('#fCur');
  if (cur) cur.addEventListener('change', () => {
    if (!$('#rateRow')) return;
    const foreign = cur.value !== baseCur();
    $('#rateRow')!.style.display = foreign ? '' : 'none';
    $('#rateCode')!.textContent = cur.value;
    ($('#fRate') as HTMLInputElement).value = String(rateOf(cur.value));
  });
}
const readAmount = (): number => Number(($('#fAmount') as HTMLInputElement).value.replace(',', '.')) || 0;
const readRate = (): number => {
  const c = ($('#fCur') as HTMLSelectElement).value;
  return c === baseCur() ? 1 : Number(($('#fRate') as HTMLInputElement).value.replace(',', '.')) || rateOf(c);
};

/* ---------- expense form ---------- */
export function expenseForm(exp?: Expense): void {
  const l = activeLedger()!;
  const isNew = !exp;
  const e: Partial<Expense> = exp || {
    emoji: '🛒', name: '', currency: l.kind === 'trip' ? l.currency || baseCur() : baseCur(),
    date: l.kind === 'trip' ? clampToTrip(l) : defaultDate(),
    accountId: defaultAccountId(S.accounts, myPersonId()),
    method: 'card', notes: '',
  };
  F.emoji = e.emoji || '🛒';
  F.planned = !!e.planned;
  initSplit(e.split);
  openModal(head(isNew ? 'New expense' : 'Edit expense') + `
    <div class="field"><label>What was it?</label><input class="input" id="fName" value="${esc(e.name)}" placeholder="Groceries at Coop" autocomplete="off"></div>
    <div class="field"><label>Icon</label>${emojiPicker(F.emoji)}</div>
    ${moneyFields(e.amount, e.currency!, e.fxRate)}
    <div class="field"><label>Has it been paid?</label>
      <div class="seg"><button type="button" data-act="exp-planned" data-v="0" class="${e.planned ? '' : 'on'}">Paid</button>
      <button type="button" data-act="exp-planned" data-v="1" class="${e.planned ? 'on' : ''}">Still to pay</button></div>
      <div class="hint">Something booked but not paid — a hotel, a deposit — counts towards the budget and stays out of the tally until the money actually goes.</div>
    </div>
    <div class="two">
      <div class="field"><label id="dateLbl">${e.planned ? 'Due' : 'Date'}</label><input class="input" id="fDate" type="date" value="${e.date}"></div>
      <div class="field"><label id="accLbl">${e.planned ? "Who'll pay" : 'Paid from'}</label><select class="input" id="fAcc">${accountOptions(e.accountId)}</select></div>
    </div>
    <div class="field"><label>How</label><select class="input" id="fMethod">${methodOptions(e.method)}</select></div>
    <div class="field"><label>Who's it for?</label><div id="splitBox">${splitBox()}</div></div>
    <div class="field"><label>Note (optional)</label><input class="input" id="fNotes" value="${esc(e.notes || '')}" placeholder="—"></div>
    <div class="row-btns">
      <button class="btn primary" style="flex:1" data-act="save-exp" data-id="${e.id || ''}">${isNew ? 'Add it 🎉' : 'Save changes'}</button>
      ${e.id ? '<button class="btn danger" data-act="del-exp" data-id="' + e.id + '">Delete</button>' : ''}
    </div>`, () => {
    wireMoney();
    if (isNew) setTimeout(() => { const n = $('#fName'); if (n) n.focus(); }, 80);
  });
}
export function defaultDate(): string {
  const t = todayISO();
  return monthOf(t) === UI.month ? t : UI.month + '-15';
}
export function clampToTrip(l: Ledger): string {
  const t = todayISO();
  if (l.startDate && t < l.startDate) return l.startDate;
  if (l.endDate && t > l.endDate) return l.endDate;
  return t;
}
export function saveExpense(id?: string): void {
  const l = activeLedger()!;
  const name = ($('#fName') as HTMLInputElement).value.trim() || 'Expense';
  const data = {
    ledgerId: l.id, name, emoji: F.emoji!,
    amount: r2(readAmount()), currency: ($('#fCur') as HTMLSelectElement).value, fxRate: readRate(),
    date: ($('#fDate') as HTMLInputElement).value || todayISO(),
    accountId: ($('#fAcc') as HTMLSelectElement).value,
    method: ($('#fMethod') as HTMLSelectElement).value as Expense['method'],
    planned: !!F.planned,
    split: readSplit(), notes: ($('#fNotes') as HTMLInputElement).value.trim(),
  };
  if (id) {
    const e = S.expenses.find((x) => x.id === id);
    if (e) Object.assign(e, data);
  } else {
    S.expenses.push(Object.assign({ id: uid('exp_'), createdAt: new Date().toISOString() }, data));
  }
  if (!id && monthOf(data.date) !== UI.month && l.kind !== 'trip') UI.month = monthOf(data.date);
  closeModal(); commit(); toast(id ? 'Saved' : 'Added ' + shortName(name));
}
const shortName = (n: string): string => (n.length > 18 ? n.slice(0, 18) + '…' : n);

/* ---------- rule form ---------- */
export function ruleForm(r?: Rule): void {
  const isNew = !r;
  const x: Partial<Rule> = r || {
    emoji: '🏠', name: '', currency: baseCur(), frequency: 'monthly',
    startMonth: UI.month, dueDay: 1, accountId: (S.accounts[0] || {}).id, method: 'direct-debit', active: true, notes: '',
  };
  F.emoji = x.emoji || '🏠';
  initSplit(x.split);
  openModal(head(isNew ? 'New recurring bill' : 'Edit recurring bill') + `
    <div class="field"><label>Name</label><input class="input" id="fName" value="${esc(x.name)}" placeholder="Rent, Netflix, insurance…" autocomplete="off"></div>
    <div class="field"><label>Icon</label>${emojiPicker(F.emoji)}</div>
    ${moneyFields(x.amount, x.currency!, null, false)}
    <div class="two">
      <div class="field"><label>How often</label><select class="input" id="fFreq">${FREQS.map((f) => '<option value="' + f[0] + '" ' + (f[0] === x.frequency ? 'selected' : '') + '>' + f[1] + '</option>').join('')}</select></div>
      <div class="field"><label>Day of month</label><input class="input" id="fDay" type="number" min="1" max="31" value="${x.dueDay || 1}"></div>
    </div>
    <div class="two">
      <div class="field"><label>First charge</label><input class="input" id="fStart" type="month" value="${x.startMonth}"></div>
      <div class="field"><label>Last charge (optional)</label><input class="input" id="fEnd" type="month" value="${x.endMonth || ''}"></div>
    </div>
    <div class="two">
      <div class="field"><label>Paid from</label><select class="input" id="fAcc">${accountOptions(x.accountId)}</select></div>
      <div class="field"><label>How</label><select class="input" id="fMethod">${methodOptions(x.method)}</select></div>
    </div>
    <div class="field"><label>Who's it for?</label><div id="splitBox">${splitBox()}</div></div>
    <div class="field"><label>Note (optional)</label><input class="input" id="fNotes" value="${esc(x.notes || '')}" placeholder="—"></div>
    ${x.id ? '<div class="field"><label>Status</label><div class="seg"><button type="button" data-act="rule-active" data-v="1" class="' + (x.active ? 'on' : '') + '">Active</button><button type="button" data-act="rule-active" data-v="0" class="' + (!x.active ? 'on' : '') + '">Paused</button></div></div>' : ''}
    <div class="row-btns">
      <button class="btn primary" style="flex:1" data-act="save-rule" data-id="${x.id || ''}">${isNew ? 'Add bill 🔁' : 'Save changes'}</button>
      ${x.id ? '<button class="btn danger" data-act="del-rule" data-id="' + x.id + '">Delete</button>' : ''}
    </div>
    ${x.id ? '<div class="hint">Deleting removes it from every month, past included. To stop it going forward, set a last charge or pause it.</div>' : ''}
  `, () => {
    wireMoney();
    F.active = x.active !== false;
    if (isNew) setTimeout(() => { const n = $('#fName'); if (n) n.focus(); }, 80);
  });
}
export function saveRule(id?: string): void {
  const l = activeLedger()!;
  const data = {
    ledgerId: l.id, name: ($('#fName') as HTMLInputElement).value.trim() || 'Bill', emoji: F.emoji!,
    amount: r2(readAmount()), currency: ($('#fCur') as HTMLSelectElement).value,
    frequency: ($('#fFreq') as HTMLSelectElement).value as Rule['frequency'],
    dueDay: Math.max(1, Math.min(31, Number(($('#fDay') as HTMLInputElement).value) || 1)),
    startMonth: ($('#fStart') as HTMLInputElement).value || UI.month,
    endMonth: ($('#fEnd') as HTMLInputElement).value || null,
    accountId: ($('#fAcc') as HTMLSelectElement).value,
    method: ($('#fMethod') as HTMLSelectElement).value as Rule['method'],
    split: readSplit(), notes: ($('#fNotes') as HTMLInputElement).value.trim(),
    active: F.active !== false,
  };
  if (id) {
    const r = rule(id);
    if (r) Object.assign(r, data);
  } else {
    S.rules.push(Object.assign({ id: uid('rule_'), createdAt: new Date().toISOString() }, data));
  }
  closeModal(); commit(); toast(id ? 'Saved' : 'Recurring bill added');
}

/* ---------- occurrence (one month of a rule) ---------- */
export function occurrenceModal(occId: string): void {
  const [ruleId, period] = occId.split('|');
  const r = rule(ruleId);
  if (!r) return;
  const ov = overrideOf(S, ruleId, period);
  const o = occurrence(r, period, ov);
  openModal(head(esc(o.emoji) + ' ' + esc(o.name)) + `
    <div class="sub" style="margin:-8px 0 14px">${monthLabel(period)} · ${FREQ_TAG[r.frequency]} · normally ${money2(r.amount, r.currency)}</div>
    <div class="field"><label>This month it is</label>
      <div class="amt-row">
        <input class="input" id="oAmount" inputmode="decimal" value="${o.amount}">
        <select class="input" id="oCur">${curOptions(o.currency)}</select>
      </div>
    </div>
    <div class="two">
      <div class="field"><label>Paid from</label><select class="input" id="oAcc">${accountOptions(o.accountId)}</select></div>
      <div class="field"><label>Date</label><input class="input" id="oDate" type="date" value="${o.date}"></div>
    </div>
    <div class="field"><label>Skip it this month?</label>
      <div class="seg"><button type="button" data-act="occ-skip" data-v="0" class="${o.skipped ? '' : 'on'}">Counts</button>
      <button type="button" data-act="occ-skip" data-v="1" class="${o.skipped ? 'on' : ''}">Skipped</button></div>
      <div class="hint">Handy when a bill didn't come, or you paused a subscription for a month.</div>
    </div>
    <div class="row-btns">
      <button class="btn primary" style="flex:1" data-act="save-occ" data-id="${occId}">Save this month</button>
      ${ov ? '<button class="btn soft" data-act="reset-occ" data-id="' + occId + '">Reset</button>' : ''}
    </div>
    <div class="divider"></div>
    <button class="btn soft wide" data-act="edit-rule" data-id="${ruleId}">Edit the whole bill 🔁</button>
  `, () => { F.skip = o.skipped; });
}
import { money as money2 } from '../lib/utils';
export function saveOccurrence(occId: string): void {
  const [ruleId, period] = occId.split('|');
  let ov = overrideOf(S, ruleId, period);
  if (!ov) {
    ov = { id: uid('ovr_'), ruleId, period };
    S.overrides.push(ov);
  }
  ov.amount = r2(Number(($('#oAmount') as HTMLInputElement).value.replace(',', '.')) || 0);
  ov.currency = ($('#oCur') as HTMLSelectElement).value;
  ov.accountId = ($('#oAcc') as HTMLSelectElement).value;
  ov.date = ($('#oDate') as HTMLInputElement).value;
  ov.skipped = !!F.skip;
  closeModal(); commit(); toast('Updated for ' + monthLabel(period));
}

/* ---------- rules manager ---------- */
export function rulesModal(): void {
  const l = activeLedger()!;
  const rs = S.rules.filter((r) => r.ledgerId === l.id);
  const body = rs.length ? '<div class="list">' + rs.map((r) =>
    '<div class="item ' + (r.active ? '' : 'skip') + '" data-act="edit-rule" data-id="' + r.id + '">' +
    '<div class="emo">' + esc(r.emoji) + '</div><div class="item-main"><div class="name">' + esc(r.name) + '</div>' +
    '<div class="meta">' + FREQ_TAG[r.frequency] + ' · day ' + r.dueDay + ' · ' + accountEmoji(r.accountId) + ' ' + esc(accountLabel(r.accountId)) +
    (r.method === 'direct-debit' ? '<span class="tag t-dd">direct debit</span>' : '') + (r.active ? '' : '<span class="tag">paused</span>') + '</div></div>' +
    '<div class="amount">' + money2(r.amount, r.currency) + '</div></div>').join('') + '</div>'
    : '<div class="empty"><span class="big">🔁</span>No recurring bills in this list yet.</div>';
  openModal(head('Recurring bills') +
    '<div class="sub" style="margin:-8px 0 14px">Rent, insurance, quarterly water, yearly Spotify — anything that repeats.</div>' +
    body + '<button class="btn primary wide" style="margin-top:14px" data-act="new-rule">＋ New recurring bill</button>');
}

/* ---------- settle up ---------- */
export function settleModal(): void {
  const l = activeLedger()!;
  const debts = simplifyDebts(computeBalances(S, l.id));
  const body = debts.length ? debts.map((d) => {
    const a = person(d.from), b = person(d.to);
    return '<div class="debt" style="flex-wrap:wrap">' + avatar(a, 'lg') + '<span class="arrow">→</span>' + avatar(b, 'lg') +
      '<span class="amt">' + money2(fromCents(d.cents), baseCur()) + '</span>' +
      '<button class="btn mint sm" data-act="do-settle" data-from="' + d.from + '" data-to="' + d.to + '" data-c="' + d.cents + '">Paid in full</button>' +
      '<button class="btn soft sm" data-act="new-settle" data-from="' + d.from + '" data-to="' + d.to + '" data-c="' + d.cents + '">Part of it…</button></div>';
  }).join('') : '<div class="empty"><span class="big">🎉</span>Nothing to settle.</div>';
  openModal(head('Settle up') +
    '<div class="sub" style="margin:-8px 0 14px">Tap Paid in full once the money has actually moved — it is logged on today\'s date and comes straight off the running tally. Part of it… lets you log a smaller amount.</div>' +
    (debts.length ? '<div class="field"><label>How it travelled</label>' + payMethodChips(lastPayMethod()) + '</div>' : '') +
    body +
    '<div class="divider"></div>' +
    '<button class="btn soft wide" data-act="new-settle">＋ Log some other repayment</button>',
    () => { F.method = lastPayMethod(); });
}
export function doSettle(from: string, to: string, c: string | number): void {
  const l = activeLedger()!;
  /* Dated today whatever month is on screen: a repayment is recorded when the
     money moved, not against the month whose expenses it happens to cover. */
  const date = todayISO();
  const method = F.method || lastPayMethod();
  S.settings.lastPayMethod = method;
  S.settlements.push({
    id: uid('set_'), ledgerId: l.id, date, createdAt: new Date().toISOString(),
    fromPersonId: from, toPersonId: to, amount: fromCents(Number(c)), currency: baseCur(), fxRate: 1,
    method, note: 'Settle up',
  });
  closeModal(); commit(); toast('Logged 🤝');
}

/* ---------- one repayment ---------- */
export function payMethodChips(sel: string): string {
  return '<div class="chips" id="payPick">' + PAY_METHODS.map((m) =>
    '<button type="button" class="chip ' + (m[0] === sel ? 'on' : '') + '" data-act="pay-method" data-v="' + m[0] + '">' +
    '<span class="tick">' + (m[0] === sel ? '✓' : '') + '</span>' + m[1] + '</button>').join('') + '</div>';
}
export const lastPayMethod = (): string => S.settings.lastPayMethod || 'cash';
function personOptions(sel?: string): string {
  return S.people.map((p) => '<option value="' + p.id + '" ' + (p.id === sel ? 'selected' : '') + '>' + esc(p.emoji + ' ' + p.name) + '</option>').join('');
}
/* ---------- what a repayment is for ---------- */

/** Beyond this the picker would be a wall of rows, so it stops and says so. */
const PICK_LIMIT = 40;

/** Everything in the ledger that ever cost money, whatever month it fell in. */
const everyItem = (): LedgerItem[] => itemsInScope(S, activeLedger()!.id, null);

/**
 * Items worth offering for a repayment from -> to, newest first, each with
 * what it alone makes `from` owe `to`.
 */
function pickable(from: string, to: string): { it: LedgerItem; owed: number }[] {
  const picked = F.items || [];
  const done = settledItemIds(S, activeLedger()!.id, F.settleId);
  return everyItem()
    .map((it) => ({ it, owed: pairwiseDebt(S, it, from, to) }))
    /* Every month is on offer, not just the one on screen — paying in July for
       August's rent is the ordinary case. Something already ticked stays listed
       even once it is square, so editing an old repayment never drops it — but
       anything an earlier repayment already covered is gone from the list. */
    .filter((c) => picked.includes(c.it.id) || (c.owed > 0 && !done.has(c.it.id)))
    .sort((a, b) => (a.it.date === b.it.date ? 0 : a.it.date < b.it.date ? 1 : -1));
}

/** Whether the picker is empty only because earlier repayments took it all. */
function allAlreadyCovered(from: string, to: string): boolean {
  const done = settledItemIds(S, activeLedger()!.id, F.settleId);
  return everyItem().some((it) => done.has(it.id) && pairwiseDebt(S, it, from, to) > 0);
}

export function pickBox(from: string, to: string): string {
  const all = pickable(from, to);
  if (!all.length) {
    return '<div class="hint" style="margin-top:0">' + (allAlreadyCovered(from, to)
      ? 'Everything between these two is already on an earlier repayment — just put the amount in below.'
      : 'Nothing outstanding between these two right now — just put the amount in below.') + '</div>';
  }
  const picked = F.items || [];
  const rows = all.slice(0, PICK_LIMIT).map(({ it, owed }) => {
    const on = picked.includes(it.id);
    return '<div class="item ' + (on ? 'on' : '') + '" data-act="pick-item" data-id="' + esc(it.id) + '">' +
      '<span class="tick">' + (on ? '✓' : '') + '</span>' +
      '<div class="emo">' + esc(it.emoji) + '</div>' +
      '<div class="item-main"><div class="name">' + esc(it.name) + '</div>' +
      '<div class="meta"><span>' + dayLabel(it.date) + '</span><span>·</span><span>of ' + money2(it.amount, it.currency) + '</span>' +
      (it.kind === 'recurring' ? '<span class="tag">bill</span>' : '') + '</div></div>' +
      '<div class="amount">' + money2(fromCents(owed), baseCur()) + '</div></div>';
  }).join('');
  return '<div class="picklist">' + rows + '</div>' +
    (all.length > PICK_LIMIT ? '<div class="hint">Showing the ' + PICK_LIMIT + ' most recent of ' + all.length + '.</div>' : '');
}

const settleFrom = (): string => ($('#sFrom') as HTMLSelectElement | null)?.value || '';
const settleTo = (): string => ($('#sTo') as HTMLSelectElement | null)?.value || '';

/** What the ticked items come to, in base-currency cents. */
function pickedCents(): number {
  const picked = F.items || [];
  if (!picked.length) return 0;
  const from = settleFrom(), to = settleTo();
  const byId = new Map(everyItem().map((it) => [it.id, it]));
  return picked.reduce((sum, id) => {
    const it = byId.get(id);
    return sum + (it ? pairwiseDebt(S, it, from, to) : 0);
  }, 0);
}

/** The same total in whatever currency the form is showing. */
function pickedAmountStr(): string {
  if (!(F.items || []).length) return F.openAmount || '';
  const cur = ($('#fCur') as HTMLSelectElement).value;
  const rate = cur === baseCur() ? 1 : readRate();
  return r2(fromCents(pickedCents()) / (rate || 1)).toFixed(2);
}

/**
 * Push the ticked total into the amount box — unless the amount has been
 * typed over, which is the whole point of being able to repay part of
 * something. `force` is the "use the total" escape hatch.
 */
export function syncPickedAmount(force?: boolean): void {
  const inp = $('#fAmount') as HTMLInputElement | null;
  if (!inp) return;
  const want = pickedAmountStr();
  const overridden = !force && F.autoAmount != null && inp.value.trim() !== F.autoAmount;
  if (!overridden) { inp.value = want; F.autoAmount = want; }

  const hint = $('#pickHint');
  if (!hint) return;
  const n = (F.items || []).length;
  hint.style.display = n ? '' : 'none';
  if (!n) { hint.innerHTML = ''; return; }
  const total = money2(fromCents(pickedCents()), baseCur());
  hint.innerHTML = n + (n === 1 ? ' item' : ' items') + ' ticked · ' + total + ' owed' +
    (overridden
      ? ' — logging a different amount. <button type="button" class="linkish" data-act="use-picked-total">Use the total</button>'
      : '. Type over the amount for a part payment.');
}

/** Redraw the picker after the people (and so the direction) changed. */
export function refreshPickBox(): void {
  const box = $('#pickBox');
  if (!box) return;
  const from = settleFrom(), to = settleTo();
  const still = new Set(pickable(from, to).filter((c) => c.owed > 0).map((c) => c.it.id));
  F.items = (F.items || []).filter((id) => still.has(id));
  box.innerHTML = pickBox(from, to);
  syncPickedAmount(true);
}

export function settlementForm(st?: Settlement | null, prefill?: { from?: string; to?: string; amount?: number | null; method?: string }): void {
  const l = activeLedger()!;
  const isNew = !st;
  const pre = prefill || {};
  const other = (id?: string) => (S.people.find((p) => p.id !== id) || S.people[0] || {}).id;
  const x: Partial<Settlement> = st || {
    fromPersonId: pre.from || (S.people[0] || {}).id,
    toPersonId: pre.to || other(pre.from || (S.people[0] || {}).id),
    amount: pre.amount != null ? pre.amount : undefined,
    currency: baseCur(), fxRate: null, method: pre.method || lastPayMethod(),
    date: l.kind === 'trip' ? clampToTrip(l) : defaultDate(), note: '',
  };
  F.method = x.method || lastPayMethod();
  F.settleId = st ? st.id : undefined;
  F.items = (st && st.itemIds ? st.itemIds.slice() : []);
  const openAmount = x.amount != null ? String(x.amount) : '';
  F.openAmount = openAmount;
  F.autoAmount = openAmount;
  openModal(head(isNew ? 'Log a repayment' : 'Edit repayment') + `
    <div class="sub" style="margin:-8px 0 14px">Money one of you actually handed over — cash, a transfer, a Twint. It cancels out against the tally rather than changing any expense.</div>
    <div class="two">
      <div class="field"><label>Who paid</label><select class="input" id="sFrom">${personOptions(x.fromPersonId)}</select></div>
      <div class="field"><label>Who got it</label><select class="input" id="sTo">${personOptions(x.toPersonId)}</select></div>
    </div>
    <button class="btn soft sm" data-act="swap-settle" style="margin:-4px 0 12px">⇄ Swap</button>
    <div class="field"><label>What's it for? (optional)</label>
      <div id="pickBox">${pickBox(x.fromPersonId!, x.toPersonId!)}</div>
      <div class="hint">Tick whatever this repayment covers and the amount fills itself in. Each line is that person's share, not the whole bill.</div>
    </div>
    ${moneyFields(x.amount, x.currency!, x.fxRate)}
    <div class="hint" id="pickHint" style="display:none;margin:-6px 0 13px"></div>
    <div class="field"><label>How it travelled</label>${payMethodChips(F.method!)}</div>
    <div class="field"><label>When</label><input class="input" id="sDate" type="date" value="${x.date}"></div>
    <div class="field"><label>Note (optional)</label><input class="input" id="sNote" value="${esc(x.note || '')}" placeholder="Cash at the station"></div>
    <div class="row-btns">
      <button class="btn primary" style="flex:1" data-act="save-settle" data-id="${x.id || ''}">${isNew ? 'Log it 🤝' : 'Save changes'}</button>
      ${x.id ? '<button class="btn danger" data-act="del-settle" data-id="' + x.id + '">Delete</button>' : ''}
    </div>
    ${x.id ? '<div class="hint">Deleting puts the amount back on the tally, as if the money had never moved.</div>' : ''}
  `, () => {
    wireMoney();
    /* Registered after wireMoney's own handler, so the rate it sets for the
       new currency is already in place when the ticked total is reconverted. */
    $('#fCur')!.addEventListener('change', () => syncPickedAmount());
    $('#sFrom')!.addEventListener('change', refreshPickBox);
    $('#sTo')!.addEventListener('change', refreshPickBox);
    syncPickedAmount();
  });
}
export function saveSettlement(id?: string): void {
  const l = activeLedger()!;
  const from = ($('#sFrom') as HTMLSelectElement).value, to = ($('#sTo') as HTMLSelectElement).value;
  if (from === to) { toast('Two different people, please'); return; }
  const amount = r2(readAmount());
  if (amount <= 0) { toast('Put an amount in first'); return; }
  const data = {
    ledgerId: l.id, date: ($('#sDate') as HTMLInputElement).value || todayISO(),
    fromPersonId: from, toPersonId: to,
    amount, currency: ($('#fCur') as HTMLSelectElement).value, fxRate: readRate(),
    method: F.method || lastPayMethod(), note: ($('#sNote') as HTMLInputElement).value.trim(),
    itemIds: (F.items || []).slice(),
  };
  S.settings.lastPayMethod = data.method;
  if (id) {
    const s = S.settlements.find((x) => x.id === id);
    if (s) Object.assign(s, data);
  } else {
    S.settlements.push(Object.assign({ id: uid('set_'), createdAt: new Date().toISOString() }, data));
  }
  if (!id && l.kind !== 'trip' && monthOf(data.date) !== UI.month) UI.month = monthOf(data.date);
  closeModal(); commit(); toast(id ? 'Saved' : 'Repayment logged 🤝');
}

/* ---------- ledger form ---------- */
export function ledgerForm(l?: Ledger): void {
  const isNew = !l;
  const x: Partial<Ledger> = l || { emoji: '✈️', name: '', kind: 'trip', currency: baseCur(), startDate: '', endDate: '' };
  F.emoji = x.emoji; F.kind = x.kind;
  openModal(head(isNew ? 'New list' : 'Edit list') + `
    <div class="field"><label>Name</label><input class="input" id="lName" value="${esc(x.name)}" placeholder="Lisbon in May, Wedding, Home" autocomplete="off"></div>
    <div class="field"><label>Icon</label><div class="emopick" id="emoPick">${['✈️', '🏠', '🏝️', '⛷️', '🎒', '🎄', '💍', '🍼', '🚗', '🏨', '🎪', '🎁', '🛠️', '🎂'].map((e) => '<button type="button" data-act="emo" data-v="' + e + '" class="' + (e === x.emoji ? 'on' : '') + '">' + e + '</button>').join('')}</div></div>
    <div class="field"><label>Type</label>
      <div class="seg"><button type="button" data-act="ledger-kind" data-v="household" class="${x.kind === 'household' ? 'on' : ''}">Household (monthly)</button>
      <button type="button" data-act="ledger-kind" data-v="trip" class="${x.kind === 'trip' ? 'on' : ''}">Trip / one-off</button></div>
      <div class="hint">Household lists have recurring bills and a month-by-month view. Trip lists are one flat pot with their own tally.</div>
    </div>
    <div class="two" id="tripDates" style="${x.kind === 'trip' ? '' : 'display:none'}">
      <div class="field"><label>From</label><input class="input" id="lStart" type="date" value="${x.startDate || ''}"></div>
      <div class="field"><label>To</label><input class="input" id="lEnd" type="date" value="${x.endDate || ''}"></div>
    </div>
    <div class="row-btns">
      <button class="btn primary" style="flex:1" data-act="save-ledger" data-id="${x.id || ''}">${isNew ? 'Create list' : 'Save'}</button>
      ${x.id && S.ledgers.length > 1 ? '<button class="btn danger" data-act="del-ledger" data-id="' + x.id + '">Delete</button>' : ''}
    </div>`);
}
export function saveLedger(id?: string): void {
  const data = {
    name: ($('#lName') as HTMLInputElement).value.trim() || 'New list',
    emoji: F.emoji!, kind: F.kind as Ledger['kind'],
    startDate: $('#lStart') ? ($('#lStart') as HTMLInputElement).value : '',
    endDate: $('#lEnd') ? ($('#lEnd') as HTMLInputElement).value : '',
  };
  if (id) {
    const l = ledger(id);
    if (l) Object.assign(l, data);
  } else {
    const l: Ledger = Object.assign(
      { id: uid('led_'), currency: baseCur(), archived: false, createdAt: new Date().toISOString() },
      data,
    );
    S.ledgers.push(l);
    UI.ledgerId = l.id;
  }
  closeModal(); commit();
}

/* ---------- settings ---------- */
export function settingsModal(): void {
  const rates = Array.from(new Set([...S.settings.currencies, ...Object.keys(S.settings.rates)])).filter((c) => c !== baseCur());
  openModal(head('Settings') + `
    <div class="field"><label>Piggy bank name</label><input class="input" id="sName" value="${esc(S.meta.appName)}"></div>
    <div class="divider"></div>
    <div class="card-head"><h2>👫 Us</h2><button class="btn soft sm" data-act="new-person">＋ Add</button></div>
    <div class="list">${S.people.map((p) =>
      '<div class="item" data-act="edit-person" data-id="' + p.id + '">' + avatar(p, 'lg') +
      '<div class="item-main"><div class="name">' + esc(p.name) +
      (session.book && session.book.personId === p.id ? ' <span class="tag t-joint">you</span>' : '') + '</div><div class="meta">' +
      S.accounts.filter((a) => a.ownership[p.id]).map((a) => esc(a.name)).join(' · ') + '</div></div><span class="sub">edit</span></div>').join('')}</div>
    ${onServer() && session.book && !session.book.personId && S.people.length
      ? '<div class="hint">None of these is linked to your account yet — <button class="btn soft sm" data-act="claim-open">say which one is you</button> so the tally knows your side.</div>'
      : ''}
    <div class="divider"></div>
    <div class="card-head"><h2>🏦 Accounts</h2><button class="btn soft sm" data-act="new-account">＋ Add</button></div>
    <div class="list">${S.accounts.map((a) =>
      '<div class="item" data-act="edit-account" data-id="' + a.id + '"><div class="emo">' + accountEmoji(a.id) + '</div>' +
      '<div class="item-main"><div class="name">' + esc(a.name) + '</div><div class="meta">' +
      (a.kind === 'joint' ? 'joint · ' : 'personal · ') + Object.entries(a.ownership).map(([pid, sh]) => (person(pid)?.name || '?') + ' ' + Math.round(sh * 100) + '%').join(' / ') +
      '</div></div><span class="sub">edit</span></div>').join('')}</div>
    <div class="hint">Money paid from an account is credited to its owners. A 50/50 joint account means joint spending needs no settling.</div>
    <div class="field"><label>Colour mood</label><div class="chips" id="themePick">${
      Object.entries(THEMES).map(([k, t]) => '<button type="button" class="chip ' + (k === (S.settings.theme || 'blueberry') ? 'on' : '') + '" data-act="theme" data-v="' + k + '">' +
        '<span class="avatar sm" style="background:' + t.accent + ';border-color:' + t.ink + '"></span>' + t.label + '</button>').join('')
    }</div><div class="hint">Changes right away — no saving needed.</div></div>
    <div class="divider"></div>
    <div class="card-head"><h2>💱 Currencies</h2><button class="btn soft sm" data-act="fetch-rates">Refresh</button></div>
    <div class="field"><label>Main currency</label><select class="input" id="sBase">${curOptions(baseCur())}</select></div>
    ${rates.map((c) => '<div class="rate-row"><span class="code">' + c + '</span>' +
      '<input class="input mono" data-act="rate" data-id="' + c + '" inputmode="decimal" value="' + S.settings.rates[c] + '">' +
      '<span class="sub">= 1 ' + c + '</span></div>').join('')}
    <div class="rate-row"><input class="input" id="sNewCur" placeholder="THB" maxlength="3" style="grid-column:span 2;text-transform:uppercase">
      <button class="btn soft sm" data-act="add-cur">Add</button></div>
    <div class="hint">${S.settings.ratesUpdatedAt ? 'Rates updated ' + dayLabel2(S.settings.ratesUpdatedAt.slice(0, 10)) : 'Rates are editable estimates — set them to whatever your bank gave you.'}</div>
    <div class="divider"></div>
    <div class="card-head"><h2>💾 Your data</h2></div>
    <div class="row-btns"><button class="btn soft" data-act="export">Export JSON</button>
      <button class="btn soft" data-act="import">Import JSON</button>
      <button class="btn soft" data-act="export-csv">Export CSV</button></div>
    <div class="hint">${onServer()
      ? 'This book lives on the server, so it follows you to any device you sign in on. Import loads a Piggy export straight into it; export gives you the full, portable data model back.'
      : 'Everything lives on this device only. Export gives you the full, portable data model — people, accounts, lists, bills, expenses, settlements.'}</div>
    <div style="margin-top:14px"><button class="btn danger wide" data-act="reset">Erase everything</button></div>
    <input type="file" id="importFile" accept="application/json" style="display:none">
    ${onServer() ? '<div class="divider"></div><div class="card-head"><h2>👤 Account</h2></div>' +
      '<div class="hint">Signed in as <b>' + esc(session.user ? session.user.email : '') + '</b>' +
      (session.book ? ', in <b>' + esc(session.book.name) + '</b>' : '') + '.</div>' +
      '<div class="row-btns" style="margin-top:10px">' +
      '<button class="btn soft" data-act="banks">🏦 Piggy banks</button>' +
      '<button class="btn soft" data-act="share">👋 Share this one</button>' +
      '<button class="btn soft" data-act="signout">Sign out</button></div>' : ''}
    <div class="divider"></div>
    <button class="btn primary wide" data-act="save-settings">Save settings</button>`);
}
import { dayLabel as dayLabel2 } from '../lib/utils';
export function saveSettings(): void {
  S.meta.appName = ($('#sName') as HTMLInputElement).value.trim() || 'Piggy';
  const nb = ($('#sBase') as HTMLSelectElement).value;
  if (nb !== S.settings.baseCurrency) {
    const old = S.settings.baseCurrency, f = rateOf(nb);
    const nr: Record<string, number> = {};
    Object.keys(S.settings.rates).forEach((c) => { nr[c] = r2(rateOf(c) / f * 10000) / 10000; });
    nr[nb] = 1;
    nr[old] = r2(1 / f * 10000) / 10000;
    S.settings.rates = nr;
    S.settings.baseCurrency = nb;
  }
  closeModal(); commit(); toast('Saved');
}

/* ---------- person / account forms ---------- */
export function personForm(p?: Person): void {
  const isNew = !p;
  const x: Partial<Person> = p || { name: '', emoji: '🙂', color: COLORS[S.people.length % COLORS.length] };
  F.emoji = x.emoji; F.color = x.color;
  const faces = [
    '🙂', '😎', '🐐', '🐰', '🦊', '🐻', '🐼', '🐨',
    '🦁', '🐯', '🐮', '🐷', '🐶', '🐱', '🐵', '🐸',
    '🐧', '🦉', '🦆', '🐔', '🦄', '🦌', '🦥', '🦔',
    '🦦', '🐘', '🐙', '🦋', '🐝', '🐢', '🐳', '🐬',
    '🦈', '🦖', '🦩', '🦜', '🌻', '🌙', '⭐', '🍀',
    '🍓', '🫐',
  ];
  openModal(head(isNew ? 'Add someone' : 'Edit ' + esc(x.name || '')) + `
    <div class="field"><label>Name</label><input class="input" id="pName" value="${esc(x.name)}" autocomplete="off"></div>
    <div class="field"><label>Face</label><div class="emopick" id="emoPick">${faces.map((e) => '<button type="button" data-act="emo" data-v="' + e + '" class="' + (e === x.emoji ? 'on' : '') + '">' + e + '</button>').join('')}</div></div>
    <div class="field"><label>Colour</label><div class="chips" id="colorPick">${COLORS.map((c) => '<button type="button" data-act="color" data-v="' + c + '" class="chip ' + (c === x.color ? 'on' : '') + '"><span class="avatar sm" style="background:' + c + '"></span></button>').join('')}</div></div>
    <div class="row-btns"><button class="btn primary" style="flex:1" data-act="save-person" data-id="${x.id || ''}">Save</button>
    ${x.id && S.people.length > 1 ? '<button class="btn danger" data-act="del-person" data-id="' + x.id + '">Remove</button>' : ''}</div>`);
}
export function savePerson(id?: string): void {
  const name = ($('#pName') as HTMLInputElement).value.trim() || 'Someone';
  if (id) {
    const p = person(id);
    if (p) Object.assign(p, { name, emoji: F.emoji, color: F.color });
  } else {
    const p: Person = { id: uid('per_'), name, emoji: F.emoji!, color: F.color! };
    S.people.push(p);
    S.accounts.push({ id: uid('acc_'), name: name + "'s money", kind: 'personal', ownership: { [p.id]: 1 } });
    S.accounts.filter((a) => a.kind === 'joint').forEach((a) => {
      const ids = Object.keys(a.ownership).concat(p.id);
      const sh = r2(1 / ids.length);
      a.ownership = {};
      ids.forEach((i, k) => { a.ownership[i] = k === ids.length - 1 ? r2(1 - sh * (ids.length - 1)) : sh; });
    });
  }
  closeModal(); commit(); settingsModal();
}
export function accountForm(a?: Account): void {
  const isNew = !a;
  const x: Partial<Account> = a || { name: 'Joint account', kind: 'joint', ownership: evenOwnership() };
  F.kind = x.kind;
  F.own = Object.assign({}, x.ownership);
  openModal(head(isNew ? 'Add account' : 'Edit account') + `
    <div class="field"><label>Name</label><input class="input" id="aName" value="${esc(x.name)}" placeholder="Joint account, Léa's Revolut…"></div>
    <div class="field"><label>Type</label><div class="seg">
      <button type="button" data-act="acc-kind" data-v="personal" class="${x.kind === 'personal' ? 'on' : ''}">One person</button>
      <button type="button" data-act="acc-kind" data-v="joint" class="${x.kind === 'joint' ? 'on' : ''}">Shared</button></div></div>
    <div class="field"><label>Owned by (%)</label><div id="ownBox">${ownBox()}</div>
      <div class="hint">Whoever owns the account gets credited when it pays for something.</div></div>
    <div class="row-btns"><button class="btn primary" style="flex:1" data-act="save-account" data-id="${x.id || ''}">Save</button>
    ${x.id && S.accounts.length > 1 ? '<button class="btn danger" data-act="del-account" data-id="' + x.id + '">Delete</button>' : ''}</div>`);
}
export function evenOwnership(): Record<string, number> {
  const o: Record<string, number> = {};
  const n = S.people.length || 1;
  S.people.forEach((p, i) => { o[p.id] = i === n - 1 ? r2(1 - r2(1 / n) * (n - 1)) : r2(1 / n); });
  return o;
}
export function ownBox(): string {
  return S.people.map((p) => '<div class="splitrow"><span class="who" style="flex:1">' + avatar(p, 'sm') + esc(p.name) + '</span>' +
    '<input class="input" data-act="own" data-id="' + p.id + '" inputmode="decimal" value="' + Math.round((F.own?.[p.id] || 0) * 100) + '"></div>').join('');
}
export function saveAccount(id?: string): void {
  let tot = 0;
  Object.values(F.own || {}).forEach((v) => { tot += Number(v) || 0; });
  if (tot <= 0) { toast('Give someone a share first'); return; }
  const own: Record<string, number> = {};
  Object.entries(F.own || {}).forEach(([k, v]) => {
    const s = (Number(v) || 0) / tot;
    if (s > 0) own[k] = r2(s * 10000) / 10000;
  });
  const data = { name: ($('#aName') as HTMLInputElement).value.trim() || 'Account', kind: F.kind as Account['kind'], ownership: own };
  if (id) {
    const a = account(id);
    if (a) Object.assign(a, data);
  } else {
    S.accounts.push(Object.assign({ id: uid('acc_') }, data));
  }
  closeModal(); commit(); settingsModal();
}

/* ---------- add chooser + onboarding ---------- */
export function addChooser(): void {
  openModal(head('Add to ' + esc(activeLedger()!.name)) +
    '<div class="list"><div class="item" data-act="new-exp"><div class="emo">🧾</div>' +
    '<div class="item-main"><div class="name">One-off expense</div><div class="meta">groceries, dinner, the cleaner, a lamp</div></div></div>' +
    '<div class="item" data-act="new-rule"><div class="emo">🔁</div>' +
    '<div class="item-main"><div class="name">Recurring bill</div><div class="meta">monthly, quarterly or yearly, on repeat</div></div></div>' +
    '<div class="item" data-act="new-settle"><div class="emo">🤝</div>' +
    '<div class="item-main"><div class="name">Repayment</div><div class="meta">money one of you paid the other back</div></div></div></div>');
}

/** Faces handed out in order as the onboarding list grows. */
export const OB_FACES = ['🐐', '🦊', '🐻', '🐼', '🐨', '🦁', '🐧', '🦉', '🦄', '🐰', '🦋', '🐙'];

export function onboard(): void {
  const typed = Array.from(document.querySelectorAll<HTMLInputElement>('[data-ob]'))
    .map((el) => el.value.trim())
    .filter(Boolean);
  const names = typed.length ? typed : ['Me', 'You'];
  S.settings.baseCurrency = ($('#obCur') as HTMLSelectElement).value;
  S.settings.rates[S.settings.baseCurrency] = 1;
  names.forEach((name, i) => {
    const p: Person = { id: uid('per_'), name, emoji: OB_FACES[i % OB_FACES.length], color: COLORS[i % COLORS.length] };
    S.people.push(p);
    S.accounts.push({ id: uid('acc_'), name: name + "'s money", kind: 'personal', ownership: { [p.id]: 1 } });
  });
  S.accounts.push({ id: uid('acc_'), name: 'Joint account', kind: 'joint', ownership: evenOwnership() });
  const home: Ledger = {
    id: uid('led_'), name: 'Home', emoji: '🏠', kind: 'household',
    currency: S.settings.baseCurrency, archived: false, createdAt: new Date().toISOString(),
  };
  S.ledgers.push(home);
  UI.ledgerId = home.id;
  commit(); toast('Welcome in 🐷');
}
