/** All read-only rendering: the ledger bar, the two ledger views, the cards. */
import type { Expense, Ledger, LedgerItem, MonthKey, Person, Settlement } from '../model/types';
import { S, UI, account, activeLedger, baseCur, person, rule, save, accountEmoji, accountLabel, toBase } from './context';
import { COLORS } from './theme';
import { onServer } from './session';
import { FREQ_TAG, PAY_LABEL } from '../lib/constants';
import { $, cents, dayLabel, esc, fromCents, money, monthLabel, monthOf, thisMonth } from '../lib/utils';
import { computeBalances, categoryTotals, paidByTotals, settlementsFor, simplifyDebts } from '../domain/balances';
import { occurrencesFor, plannedInScope, plannedShares, upcomingRules } from '../domain/selectors';

export function commit(): void { save(); render(); }

export function avatar(p: Person | undefined, cls?: string): string {
  if (!p) return '';
  return '<span class="avatar ' + (cls || '') + '" style="background:' + p.color + '22;border-color:' + p.color + '">' + esc(p.emoji || p.name[0]) + '</span>';
}
export function whoChip(p: Person | undefined, cls?: string): string {
  return p ? '<span class="who">' + avatar(p, cls) + esc(p.name) + '</span>' : '';
}

/**
 * The brand is the book's name, and on a shared deployment it is also how you
 * get between books — there is nowhere else that is always on screen.
 */
function renderBrand(): void {
  const brand = $('#brandName');
  if (brand) brand.textContent = S.meta.appName || 'Piggy';
  const box = $('.brand');
  if (!box || !onServer()) return;
  box.dataset.act = 'banks';
  box.classList.add('tappable');
  if (!box.querySelector('.caret')) box.insertAdjacentHTML('beforeend', '<span class="caret">▾</span>');
}

export function render(): void {
  renderBrand();
  if (!S.people.length) { renderOnboarding(); return; }
  const l = activeLedger();
  if (!l) { renderNoLedger(); return; }
  UI.ledgerId = l.id;
  renderLedgerBar();
  const main = $('#main'); if (main) main.innerHTML = l.kind === 'trip' ? tripView(l) : householdView(l);
  const fab = $('#fab'); if (fab) fab.style.display = 'flex';
}

function renderLedgerBar(): void {
  const bar = S.ledgers.filter((l) => !l.archived).map((l) =>
    '<button class="pill ' + (l.id === UI.ledgerId ? 'on' : '') + '" data-act="ledger" data-id="' + l.id + '">' + esc(l.emoji) + ' ' + esc(l.name) + '</button>'
  ).join('');
  const el = $('#ledgerBar');
  if (el) el.innerHTML = bar + '<button class="pill ghost" data-act="new-ledger">＋ New list</button>';
}

/** How many name boxes the onboarding form is showing. Grows on demand. */
let obSlots = 2;
export function addOnboardSlot(): void { obSlots += 1; renderOnboarding(); }

export function renderOnboarding(): void {
  const lb = $('#ledgerBar'); if (lb) lb.innerHTML = '';
  const fab = $('#fab'); if (fab) fab.style.display = 'none';
  const main = $('#main'); if (!main) return;
  const kept = Array.from(document.querySelectorAll<HTMLInputElement>('[data-ob]')).map((el) => el.value);
  const hints = ['e.g. Léa', 'e.g. Marc', 'e.g. Sam', 'e.g. Robin'];
  const boxes = Array.from({ length: obSlots }, (_, i) =>
    '<div class="field"><label>' + (i === 0 ? 'Your name' : 'Person ' + (i + 1)) + '</label>' +
    '<input class="input" data-ob="' + i + '" value="' + esc(kept[i] || '') + '" placeholder="' +
    esc(hints[i] || 'Another name') + '" autocomplete="off"></div>').join('');

  main.innerHTML = `
  <div class="card" style="margin-top:20px">
    <h2 style="font-size:22px">Hello you lot 👋</h2>
    <p class="sub" style="margin:8px 0 18px;line-height:1.5">Piggy keeps shared spending tidy: recurring bills, everyday extras, and holidays — with a running tally of who owes whom.</p>
    <div class="${obSlots === 2 ? 'two' : ''}">${boxes}</div>
    <button class="btn soft wide" style="margin-bottom:13px" data-act="ob-more">＋ Add another person</button>
    <div class="field"><label>Main currency</label>
      <select class="input" id="obCur">${['CHF', 'EUR', 'USD', 'GBP'].map((c) => '<option ' + (c === 'CHF' ? 'selected' : '') + '>' + c + '</option>').join('')}</select>
    </div>
    <button class="btn primary wide" data-act="ob-go">Start our piggy bank 🐷</button>
    <div class="hint">You can add or remove people later under Settings.</div>
  </div>`;
}

function renderNoLedger(): void {
  const main = $('#main');
  if (main) main.innerHTML = '<div class="card center"><div class="empty"><span class="big">📒</span>No lists yet.</div><button class="btn primary" data-act="new-ledger">Create one</button></div>';
}

/* ---------- receipt ---------- */
/**
 * The tally. It spans the whole ledger and ignores the month nav on purpose:
 * a repayment made in July for August's bills still has to count, so there is
 * one running balance rather than one per month.
 */
export function receiptCard(l: Ledger): string {
  const bal = computeBalances(S, l.id);
  const paid = paidByTotals(S, l.id);
  const debts = simplifyDebts(bal);
  const rows = S.people.map((p) => {
    const b = bal[p.id] || 0;
    return '<div class="rrow"><span>' + esc(p.emoji) + ' ' + esc(p.name) + '</span><span class="dots"></span>' +
      '<span class="val ' + (b > 1 ? 'pos' : b < -1 ? 'neg' : '') + '">' + (b > 1 ? '+' : '') + fromCents(b).toFixed(2) + '</span></div>';
  }).join('');
  const paidRows = S.people.map((p) => '<div class="rrow" style="color:var(--ink-soft)"><span>paid by ' + esc(p.name) + '</span><span class="dots"></span><span>' + fromCents(paid[p.id] || 0).toFixed(2) + '</span></div>').join('');
  const settled = settlementsFor(S, l.id);
  const back: Record<string, number> = {};
  S.people.forEach((p) => { back[p.id] = 0; });
  settled.forEach((s) => {
    const c = cents(toBase(s.amount, s.currency, s.fxRate));
    if (back[s.fromPersonId] != null) back[s.fromPersonId] += c;
  });
  const backRows = settled.length ? '<div class="tear"></div>' + S.people.map((p) =>
    '<div class="rrow" style="color:var(--ink-soft)"><span>paid back by ' + esc(p.name) + '</span><span class="dots"></span><span>' +
    fromCents(back[p.id] || 0).toFixed(2) + '</span></div>').join('') : '';
  const body = debts.length ? debts.map((d) => {
    const a = person(d.from), b = person(d.to);
    return '<div class="debt">' + avatar(a, 'lg') + '<div><div style="font-weight:800">' + esc(a?.name) + ' owes ' + esc(b?.name) + '</div><div class="sub">everything so far</div></div>' +
      '<span class="amt">' + money(fromCents(d.cents), baseCur()) + '</span></div>';
  }).join('') : '<div class="stamp">ALL SQUARE ✨</div>';

  return '<div class="receipt" style="padding-top:22px">' +
    '<div class="receipt-title">the tally · ' + esc(baseCur()) + '</div>' +
    (l.kind === 'trip' ? '' : '<div class="sub center" style="margin:-8px 0 12px">Every month together, whenever the money moved</div>') +
    rows + '<div class="tear"></div>' + paidRows + backRows + '<div class="tear"></div>' + body +
    (debts.length ? '<button class="btn mint wide" style="margin-top:14px" data-act="settle">Settle up 🤝</button>' : '') +
    '</div>';
}

/* ---------- repayments ---------- */
/** An item a repayment was logged against — an expense, or a month of a bill. */
function itemLabel(id: string): string {
  if (id.includes('|')) {
    const r = rule(id.split('|')[0]);
    return r ? r.emoji + ' ' + r.name : '';
  }
  const e = S.expenses.find((x) => x.id === id);
  return e ? e.emoji + ' ' + e.name : '';
}
function coversLabel(ids: string[]): string {
  const named = ids.map(itemLabel).filter(Boolean);
  if (!named.length) return '';
  return 'for ' + named[0] + (named.length > 1 ? ' +' + (named.length - 1) + ' more' : '');
}

function repaymentRow(s: Settlement): string {
  const a = person(s.fromPersonId), b = person(s.toPersonId);
  const base = toBase(s.amount, s.currency, s.fxRate);
  const foreign = s.currency !== baseCur();
  const covers = coversLabel(s.itemIds || []);
  return '<div class="item" data-act="open-settle" data-id="' + s.id + '">' +
    '<div class="stack pair">' + (avatar(a) || '<span class="avatar">?</span>') + (avatar(b) || '<span class="avatar">?</span>') + '</div>' +
    '<div class="item-main"><div class="name">' + esc(a?.name || 'someone') + ' → ' + esc(b?.name || 'someone') + '</div>' +
    '<div class="meta"><span>' + dayLabel(s.date) + '</span>' +
    (s.method ? '<span>·</span><span>' + esc(PAY_LABEL(s.method)) + '</span>' : '') +
    (covers ? '<span>·</span><span>' + esc(covers) + '</span>' : '') +
    (s.note ? '<span>·</span><span>' + esc(s.note) + '</span>' : '') + '</div></div>' +
    '<div class="amount">' + money(base, baseCur()) +
    (foreign ? '<small>' + money(s.amount, s.currency) + '</small>' : '') + '</div></div>';
}

/**
 * The one repayment log for the ledger. Grouped by the month the money moved
 * — which is when it happened, not which month's expenses it was for.
 */
function repaymentsCard(l: Ledger): string {
  const list = settlementsFor(S, l.id);
  const moved = list.reduce((sum, s) => sum + cents(toBase(s.amount, s.currency, s.fxRate)), 0);
  const perPair: Record<string, number> = {};
  list.forEach((s) => {
    const k = s.fromPersonId + '>' + s.toPersonId;
    perPair[k] = (perPair[k] || 0) + cents(toBase(s.amount, s.currency, s.fxRate));
  });
  const summary = Object.entries(perPair).map(([k, c]) => {
    const [f, t] = k.split('>');
    return '<div class="rrow"><span>' + esc(person(f)?.name || '?') + ' → ' + esc(person(t)?.name || '?') +
      '</span><span class="dots"></span><span class="val">' + fromCents(c).toFixed(2) + '</span></div>';
  }).join('');
  const months: MonthKey[] = [];
  list.forEach((s) => { const m = monthOf(s.date); if (!months.includes(m)) months.push(m); });
  const rows = months.map((m) =>
    (months.length > 1 ? '<div class="daygroup">' + monthLabel(m) + '</div>' : '') +
    '<div class="list">' + list.filter((s) => monthOf(s.date) === m).map(repaymentRow).join('') + '</div>').join('');
  return '<div class="card"><div class="card-head"><h2>🤝 Repayments</h2>' +
    '<span class="sub">' + (list.length ? list.length + ' · ' + money(fromCents(moved), baseCur()) + ' moved' : 'none yet') + '</span></div>' +
    (list.length
      ? rows + (Object.keys(perPair).length > 1 ? '<div class="divider"></div>' + summary : '')
      : '<div class="empty"><span class="big">💸</span>No money has moved yet.<br>The tally above says who should pay whom.</div>') +
    '<button class="btn soft wide" style="margin-top:12px" data-act="new-settle">＋ Log a repayment</button></div>';
}

/* ---------- item row ---------- */
export function itemRow(it: LedgerItem, opts?: { markPaid?: boolean }): string {
  const acc = account(it.accountId);
  const base = toBase(it.amount, it.currency, it.fxRate);
  const foreign = it.currency !== baseCur();
  const tags: string[] = [];
  const planned = 'planned' in it && it.planned;
  const skipped = 'skipped' in it && it.skipped;
  if (planned) tags.push('<span class="tag t-plan">planned</span>');
  if (it.kind === 'recurring') tags.push('<span class="tag t-freq">' + FREQ_TAG[it.frequency] + '</span>');
  if (it.method === 'direct-debit') tags.push('<span class="tag t-dd">direct debit</span>');
  if (acc && acc.kind === 'joint') tags.push('<span class="tag t-joint">joint</span>');
  const split = it.split || { mode: 'equal', participants: [], values: {} };
  const parts = split.participants && split.participants.length ? split.participants : S.people.map((p) => p.id);
  const splitTxt = parts.length === S.people.length && (split.mode || 'equal') === 'equal' ? 'split evenly'
    : split.mode === 'exact' ? 'custom amounts' : split.mode === 'shares' ? 'by shares'
    : 'for ' + parts.map((id) => person(id)?.name).filter(Boolean).join(' & ');
  return '<div class="item ' + (skipped ? 'skip' : '') + '" data-act="open" data-kind="' + it.kind + '" data-id="' + it.id + '">' +
    '<div class="emo">' + esc(it.emoji || '📦') + '</div>' +
    '<div class="item-main"><div class="name">' + esc(it.name) + '</div>' +
    '<div class="meta">' + (acc ? '<span>' + accountEmoji(it.accountId) + ' ' + esc(accountLabel(it.accountId)) + '</span>' : '') +
    '<span>·</span><span>' + esc(splitTxt) + '</span>' + tags.join('') + '</div></div>' +
    '<div class="amount">' + (skipped ? '—' : money(base, baseCur())) +
    (foreign ? '<small>' + money(it.amount, it.currency) + '</small>' : '') + '</div>' +
    (opts && opts.markPaid ? '<button class="btn mint sm" data-act="mark-paid" data-id="' + it.id + '">Paid</button>' : '') +
    '</div>';
}

/* ---------- planned (not paid yet) ---------- */
function plannedCard(l: Ledger, monthKey: MonthKey | null): string {
  const list = plannedInScope(S, l.id, monthKey);
  if (!list.length) return '';
  const total = list.reduce((s, e) => s + cents(toBase(e.amount, e.currency, e.fxRate)), 0);
  const shares = plannedShares(S, list);
  return '<div class="card"><div class="card-head"><h2>🗓️ Still to pay</h2>' +
    '<span class="sub">' + money(fromCents(total), baseCur()) + '</span></div>' +
    '<div class="list">' + list.map((e) => itemRow(e, { markPaid: true })).join('') + '</div>' +
    '<div class="divider"></div>' +
    '<div class="receipt-title">whose share, once paid</div>' +
    S.people.map((p) => '<div class="rrow"><span>' + esc(p.emoji) + ' ' + esc(p.name) + '</span><span class="dots"></span>' +
      '<span class="val">' + fromCents(shares[p.id] || 0).toFixed(2) + '</span></div>').join('') +
    '<div class="hint">Nothing here counts towards the tally yet — nobody is out of pocket until it\'s paid. Tap <b>Paid</b> once the money actually goes.</div>' +
    '</div>';
}

/* ---------- household ---------- */
function householdView(l: Ledger): string {
  const mk = UI.month;
  const recs = occurrencesFor(S, l.id, mk);
  const ad = S.expenses.filter((e) => e.ledgerId === l.id && monthOf(e.date) === mk && !e.planned)
    .sort((a, b) => (a.date === b.date ? (b.createdAt || '').localeCompare(a.createdAt || '') : a.date < b.date ? 1 : -1));
  const recTotal = recs.filter((o) => !o.skipped).reduce((s, o) => s + cents(toBase(o.amount, o.currency, o.fxRate)), 0);
  const adTotal = ad.reduce((s, e) => s + cents(toBase(e.amount, e.currency, e.fxRate)), 0);
  const planTotal = plannedInScope(S, l.id, mk).reduce((s, e) => s + cents(toBase(e.amount, e.currency, e.fxRate)), 0);
  const soon = upcomingRules(S, l.id, mk, 12);

  let out = `
  <div class="monthnav">
    <button class="icon-btn" data-act="month" data-v="-1">‹</button>
    <h2>${monthLabel(mk)}</h2>
    <button class="icon-btn" data-act="month" data-v="1">›</button>
  </div>`;
  if (mk !== thisMonth()) out += '<button class="today-link" data-act="month" data-v="0">jump back to today</button>';

  out += `<div class="totals${planTotal ? ' four' : ''}">
    <div class="tot"><div class="k">Recurring</div><div class="v">${fromCents(recTotal).toFixed(0)}</div></div>
    <div class="tot"><div class="k">Extras</div><div class="v">${fromCents(adTotal).toFixed(0)}</div></div>
    ${planTotal ? '<div class="tot" style="border-color:var(--mint)"><div class="k">Planned</div><div class="v" style="color:var(--mint)">' + fromCents(planTotal).toFixed(0) + '</div></div>' : ''}
    <div class="tot" style="border-color:var(--ink)"><div class="k">${planTotal ? 'Paid' : 'Total'} ${esc(baseCur())}</div><div class="v">${fromCents(recTotal + adTotal).toFixed(0)}</div></div>
  </div>`;

  out += receiptCard(l);

  out += '<div class="card"><div class="card-head"><h2>🔁 Recurring</h2>' +
    '<button class="btn soft sm" data-act="rules">Manage</button></div>' +
    (recs.length ? '<div class="list">' + recs.map((o) => itemRow(o)).join('') + '</div>'
      : '<div class="empty"><span class="big">🗓️</span>No recurring bills land in this month.<br><button class="btn soft sm" style="margin-top:10px" data-act="new-rule">Add a recurring bill</button></div>') +
    '</div>';

  out += '<div class="card"><div class="card-head"><h2>🧾 Extras this month</h2>' +
    '<span class="sub">' + ad.length + ' item' + (ad.length === 1 ? '' : 's') + '</span></div>' +
    (ad.length ? '<div class="list">' + ad.map((e) => itemRow({ ...e, kind: 'adhoc' })).join('') + '</div>'
      : '<div class="empty"><span class="big">🌸</span>Nothing extra yet — a clean month!</div>') +
    '</div>';

  out += plannedCard(l, mk);
  out += repaymentsCard(l);
  out += catCard(l.id, mk);

  if (soon.length) {
    out += '<div class="card flat"><div class="card-head"><h2>👀 Coming up</h2></div><div class="list">' +
      soon.map((o) => '<div class="item" data-act="open" data-kind="recurring" data-id="' + o.id + '"><div class="emo">' + esc(o.emoji) + '</div>' +
        '<div class="item-main"><div class="name">' + esc(o.name) + '</div><div class="meta">' + monthLabel(o.period) + ' · ' + FREQ_TAG[o.frequency] + '</div></div>' +
        '<div class="amount">' + money(toBase(o.amount, o.currency, null), baseCur()) + '</div></div>').join('') +
      '</div></div>';
  }
  return out;
}

function catCard(ledgerId: string, mk: MonthKey | null): string {
  const cats = categoryTotals(S, ledgerId, mk);
  if (!cats.length) return '';
  const total = cats.reduce((s, c) => s + c[1], 0) || 1;
  const bar = cats.slice(0, 8).map((c, i) => '<span style="width:' + (c[1] / total * 100) + '%;background:' + COLORS[i % COLORS.length] + '"></span>').join('');
  const leg = cats.slice(0, 8).map((c, i) => '<span><i style="background:' + COLORS[i % COLORS.length] + '"></i>' + c[0] + ' ' + fromCents(c[1]).toFixed(0) + '</span>').join('');
  return '<div class="card flat"><div class="card-head"><h2>🍰 Where it went</h2><span class="sub">' + money(fromCents(total), baseCur()) + '</span></div>' +
    '<div class="bar">' + bar + '</div><div class="legend">' + leg + '</div></div>';
}

/* ---------- trip ---------- */
function tripView(l: Ledger): string {
  const items = S.expenses.filter((e) => e.ledgerId === l.id && !e.planned).sort((a, b) => (a.date < b.date ? 1 : -1));
  const total = items.reduce((s, e) => s + cents(toBase(e.amount, e.currency, e.fxRate)), 0);
  const planned = plannedInScope(S, l.id, null);
  const planTotal = planned.reduce((s, e) => s + cents(toBase(e.amount, e.currency, e.fxRate)), 0);
  const days: Record<string, Expense[]> = {};
  items.forEach((e) => { (days[e.date] = days[e.date] || []).push(e); });
  const range = [l.startDate, l.endDate].filter(Boolean).map((d) => dayLabel(d as string)).join(' → ');

  let out = '<div class="card" style="margin-top:16px"><div class="card-head">' +
    '<h2 style="font-size:21px">' + esc(l.emoji) + ' ' + esc(l.name) + '</h2>' +
    '<button class="icon-btn" data-act="edit-ledger" data-id="' + l.id + '">✏️</button></div>' +
    '<div class="sub">' + (range || 'no dates set') + ' · ' + items.length + ' expense' + (items.length === 1 ? '' : 's') +
    (planned.length ? ' · ' + planned.length + ' still to pay' : '') + '</div>' +
    '<div class="mono" style="font-size:30px;font-weight:700;margin-top:10px">' + money(fromCents(total), baseCur()) + '</div>' +
    (planTotal ? '<div class="sub" style="margin-top:4px">＋ ' + money(fromCents(planTotal), baseCur()) +
      ' planned · <b>' + money(fromCents(total + planTotal), baseCur()) + '</b> all in</div>' : '') +
    '</div>';

  out += receiptCard(l);

  if (!items.length) {
    out += '<div class="card"><div class="empty"><span class="big">🧳</span>' +
      (planned.length ? 'Nothing paid yet — just the plan below.' : 'No expenses yet. Tap ＋ Add after the first coffee.') + '</div></div>';
  } else {
    out += '<div class="card"><div class="card-head"><h2>🧾 Expenses</h2></div>' +
      Object.keys(days).sort().reverse().map((d) =>
        '<div class="daygroup">' + dayLabel(d) + '</div><div class="list">' + days[d].map((e) => itemRow({ ...e, kind: 'adhoc' })).join('') + '</div>'
      ).join('') + '</div>';
  }
  out += plannedCard(l, null);
  out += repaymentsCard(l);
  if (items.length) out += catCard(l.id, null);
  return out;
}
