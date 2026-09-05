/** All read-only rendering: the ledger bar, the two ledger views, the cards. */
import type { Expense, Ledger, LedgerItem, MonthKey, Person, Settlement } from '../model/types';
import type { Scope } from './context';
import { S, UI, account, activeLedger, baseCur, person, rule, save, accountEmoji, accountLabel, solo, toBase } from './context';
import { COLORS } from './theme';
import { onServer, profile } from './session';
import { FREQ_TAG, PAY_LABEL } from '../lib/constants';
import { $, dayLabel, esc, fromCents, money, monthLabel, thisMonth } from '../lib/utils';
import type { SpentView } from '../domain/tally';
import { repaymentsView, spentView, tallyView } from '../domain/tally';
import { upcomingRules } from '../domain/selectors';

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

/**
 * The switcher, and the only place the open list is named. The month view used
 * to head itself with the same emoji and the same word, two lines under the
 * pill that already said it — so the pill took the pencil over with the name:
 * tapping the list you are already in is what renames it.
 */
function renderLedgerBar(): void {
  const bar = S.ledgers.filter((l) => !l.archived).map((l) => {
    const on = l.id === UI.ledgerId;
    return '<button class="pill ' + (on ? 'on' : '') + '" data-act="' + (on ? 'edit-ledger' : 'ledger') + '" data-id="' + l.id + '"' +
      (on ? ' title="Rename this list"' : '') + '>' + esc(l.emoji) + ' ' + esc(l.name) +
      (on ? '<span class="pen">✏️</span>' : '') + '</button>';
  }).join('');
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
  /* Your account already knows who you are, so the first box opens holding it
     — name and face both. Nothing on the Pages build, where there is no
     account to know it, and typing over it is always allowed. */
  const me = profile();
  const first = (): string => (kept.length ? kept[0] || '' : me ? me.name : '');
  const boxes = Array.from({ length: obSlots }, (_, i) =>
    '<div class="field">' + (i === 0 && me
      ? '<label style="display:flex;align-items:center;gap:6px">' +
        '<span class="avatar sm" style="background:var(--tint)">' + esc(me.emoji) + '</span>Your name</label>'
      : '<label>' + (i === 0 ? 'Your name' : 'Person ' + (i + 1)) + '</label>') +
    '<input class="input" data-ob="' + i + '" value="' + esc(i === 0 ? first() : kept[i] || '') + '" placeholder="' +
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
    <div class="hint">Everyone gets their own money to pay from. Share an account too? Add it under Settings, along with anyone we've missed.${
      me ? ' Your name and face come from your profile — change them under Settings › Your account.' : ''
    }</div>
  </div>`;
}

function renderNoLedger(): void {
  const main = $('#main');
  if (main) main.innerHTML = '<div class="card center"><div class="empty"><span class="big">📒</span>No lists yet.</div><button class="btn primary" data-act="new-ledger">Create one</button></div>';
}

/* ---------- receipt ---------- */
/**
 * The tally for one scope, and only that scope: what it cost, what came back,
 * and what it leaves between you.
 *
 * The card used to carry two figures at once — the month's own subtotal and
 * the running total under it — and they can point opposite ways, because a
 * month is a slice and the debt is not. September left Adrien 9.95 short
 * directly above an ALL SQUARE stamp. Both true, and together unreadable: the
 * question "so do I owe anything?" got two answers in one card, and every
 * month since has been an argument about which one counted.
 *
 * So the scopes are two tabs now, and this card belongs to whichever one is
 * open. Monthly hands it a month and it prints that month alone; Total hands
 * it `null` and it prints the running total, which is the only scope you can
 * settle — hence Settle up on Total and nowhere else. The month gets a link
 * across instead of a second figure.
 */
export function receiptCard(l: Ledger, mk: MonthKey | null): string {
  const v = tallyView(S, l.id, mk);
  const debts = v.debts;
  const whole = !mk;
  /* No per-person +/- line here. It read as a second, contradictory answer to
     the one question the tally exists for — "Léa -1153.78 / Marc +1153.78"
     above "Léa owes Marc 1153.78" is the same fact three times, in a sign
     convention you have to stop and decode. The debt line below says it. */
  const soft = (k: string, v2: number): string =>
    '<div class="rrow" style="color:var(--ink-soft)"><span>' + k + '</span><span class="dots"></span><span>' +
    fromCents(v2).toFixed(2) + '</span></div>';

  const paidRows = v.moved ? S.people.map((p) => soft('paid by ' + esc(p.name), v.paid[p.id] || 0)).join('') : '';
  const backRows = v.anyBack ? '<div class="tear"></div>' + S.people.map((p) =>
    soft('paid back by ' + esc(p.name), v.back[p.id] || 0)).join('') : '';

  /* The figure, named by the weeks it describes. A month's is a subtotal and
     says so — "September 2026" under it, never "everything so far" — because
     the one thing this card must never do again is let a slice be mistaken
     for the debt. */
  const body = debts.length ? debts.map((d) => {
    const a = person(d.from), b = person(d.to);
    return '<div class="debt">' + avatar(a, 'lg') + '<div><div style="font-weight:800">' + esc(a?.name) + ' owes ' + esc(b?.name) + '</div>' +
      '<div class="sub">' + esc(whole ? 'everything so far' : monthLabel(mk as MonthKey)) + '</div></div>' +
      '<span class="amt">' + money(fromCents(d.cents), baseCur()) + '</span></div>';
  }).join('') : '<div class="stamp">' + (whole ? 'ALL SQUARE ✨' : 'SQUARE THIS MONTH ✨') + '</div>';

  /* Monthly never settles: a repayment pays off a ledger, not a slice of one,
     and the button that does it is one tap away on the tab that owns the
     figure. The link is navigation, not a second answer — it carries no
     number, which is the whole point of having split them. */
  const foot = whole
    ? (debts.length ? '<button class="btn mint wide" style="margin-top:8px" data-act="settle">Settle up 🤝</button>' : '')
    : '<button class="today-link" style="margin:8px 0 0;width:100%" data-act="scope" data-v="all">where you stand overall ›</button>';

  return '<div class="receipt" style="padding-top:22px">' +
    '<div class="receipt-title">the tally · ' + esc(baseCur()) + '</div>' +
    (l.kind === 'trip' ? '' : '<div class="sub center" style="margin:-8px 0 12px">' +
      (whole ? 'Every month together, whenever the money moved' : 'This month on its own') + '</div>') +
    paidRows + backRows + (paidRows || backRows ? '<div class="tear"></div>' : '') + body +
    '<button class="today-link" style="margin:14px 0 0;width:100%" data-act="tally" data-v="' + (whole ? 'all' : 'month') + '">see who paid what ›</button>' +
    foot +
    '</div>';
}

/** What a scope's spend is made of — the same three boxes on either tab. */
function splitRow(v: SpentView): string {
  const cells: [string, number, string][] = [
    ['recurring', v.totals.recurring, ''], ['extras', v.totals.oneOff, ''],
  ];
  if (v.totals.planned) cells.push(['planned', v.totals.planned, ' plan']);
  return '<div class="split">' + cells.map(([k, c, cls]) =>
    '<div class="sp' + cls + '"><div class="k">' + k + '</div><div class="v">' + fromCents(c).toFixed(2) + '</div></div>').join('') + '</div>';
}

/* ---------- the month ---------- */
/**
 * One card for the month: what it cost, and what that is made of.
 *
 * It stands where a strip of four bordered boxes used to sit above the
 * receipt — the strip said the month's total, and then the receipt said the
 * same number again two rows down, under a heading that repeated the month
 * already printed in the nav. The figure is the month the nav is on; the
 * split under it is the same recurring / extras / planned numbers the strip
 * carried, without a box drawn round each one.
 *
 * It used to grow an all-time tail on a solo book, which had no tally card to
 * hold the whole-ledger view. The Total tab holds it now, for solo and shared
 * alike — so this card is the month and only the month, which is the same
 * rule the tally beside it follows.
 */
function monthCard(l: Ledger, mk: MonthKey, v: SpentView): string {
  const soloBook = solo();
  const paid = v.totals.spent;
  const sum = v.summary;
  /* The signature receipt belongs to whichever card is the book's headline:
     the tally on a shared book, this one when there is no tally to have. */
  const shell = (body: string): string =>
    '<div class="' + (soloBook ? 'receipt' : 'card') + ' monthcard">' + body + '</div>';
  /* Not the month's name: the nav directly above it is already the month, and
     saying it again here is what this card was rebuilt to stop doing. */
  const title = '<div class="receipt-title">spent · ' + esc(baseCur()) + '</div>';

  if (soloBook && !sum.count && !sum.planned) {
    return shell(title + '<div class="empty"><span class="big">🐷</span>Nothing spent yet.<br>Tap ＋ Add and this is where it adds up.</div>');
  }

  const split = splitRow(v);

  /* Whether this month is a dear one. It is the one all-time fact that says
     something about *this* month rather than about the book, so it stays —
     as a sentence, with no second figure to weigh against the one above. */
  const d = sum.month - sum.perMonth;
  const tail = sum.span < 2 || sum.total === paid ? ''
    : '<div class="hint center" style="margin-top:12px">' + esc(Math.abs(d) < 100
      ? 'Bang on a usual month.'
      : money(fromCents(Math.abs(d)), baseCur()) + (d > 0 ? ' more' : ' less') + ' than a usual month.') + '</div>';
  return shell(title + '<div class="figure">' + fromCents(paid).toFixed(2) + '</div>' + split + tail);
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
 * The repayment log. A month shows the repayments filed under it — whatever
 * was ticked against one of that month's items, plus anything logged that
 * month with nothing ticked. A trip has no months, so it shows the lot,
 * grouped by the month the money moved.
 */
function repaymentsCard(l: Ledger, mk: MonthKey | null): string {
  const v = repaymentsView(S, l.id, mk);
  const list = v.list;
  const summary = v.perPair.map((d) =>
    '<div class="rrow"><span>' + esc(person(d.from)?.name || '?') + ' → ' + esc(person(d.to)?.name || '?') +
    '</span><span class="dots"></span><span class="val">' + fromCents(d.cents).toFixed(2) + '</span></div>').join('');
  /* One month is one list; a trip spans months, so it keeps its headings. */
  const rows = v.groups.map((g) =>
    (v.groups.length > 1 ? '<div class="daygroup">' + monthLabel(g.month) + '</div>' : '') +
    '<div class="list">' + g.list.map(repaymentRow).join('') + '</div>').join('');
  return '<div class="card"><div class="card-head"><h2>🤝 Repayments</h2>' +
    '<span class="sub">' + (list.length ? list.length + ' · ' + money(fromCents(v.moved), baseCur()) + ' moved' : 'none yet') + '</span></div>' +
    (list.length
      ? rows + (v.perPair.length > 1 ? '<div class="divider"></div>' + summary : '')
      : '<div class="empty"><span class="big">💸</span>' +
        (mk ? 'Nothing repaid for ' + esc(monthLabel(mk)) + '.<br>A repayment shows here once it is ticked against one of this month\'s items.'
          : 'No money has moved yet.<br>The tally above says who should pay whom.') + '</div>') +
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
  const evenly = parts.length === S.people.length && (split.mode || 'equal') === 'equal';
  /* Nothing is said about an even split across everyone: it is what almost
     every row is, and saying it wrapped the meta line onto a line of its own
     on a phone — four lines of chrome under a two-word name. The unusual
     splits are the ones worth the space. */
  const splitTxt = evenly ? ''
    : split.mode === 'exact' ? 'custom amounts' : split.mode === 'shares' ? 'by shares'
    : 'for ' + parts.map((id) => person(id)?.name).filter(Boolean).join(' & ');
  return '<div class="item ' + (skipped ? 'skip' : '') + '" data-act="open" data-kind="' + it.kind + '" data-id="' + it.id + '">' +
    '<div class="emo">' + esc(it.emoji || '📦') + '</div>' +
    '<div class="item-main"><div class="name">' + esc(it.name) + '</div>' +
    '<div class="meta">' + (acc ? '<span>' + accountEmoji(it.accountId) + ' ' + esc(accountLabel(it.accountId)) + '</span>' : '') +
    (splitTxt ? (acc ? '<span>·</span>' : '') + '<span>' + esc(splitTxt) + '</span>' : '') + tags.join('') + '</div></div>' +
    '<div class="amount">' + (skipped ? '—' : money(base, baseCur())) +
    (foreign ? '<small>' + money(it.amount, it.currency) + '</small>' : '') + '</div>' +
    (opts && opts.markPaid ? '<button class="btn mint sm" data-act="mark-paid" data-id="' + it.id + '">Paid</button>' : '') +
    '</div>';
}

/* ---------- planned (not paid yet) ---------- */
function plannedCard(v: SpentView): string {
  const list = v.planned;
  if (!list.length) return '';
  const total = v.totals.planned;
  const shares = v.plannedShares;
  /* Whose share it'll be, and the tally it isn't on yet, both need somebody
     to owe: with one person on the book the total above already says it. */
  const split = solo() ? '' : '<div class="divider"></div>' +
    '<div class="receipt-title">whose share, once paid</div>' +
    S.people.map((p) => '<div class="rrow"><span>' + esc(p.emoji) + ' ' + esc(p.name) + '</span><span class="dots"></span>' +
      '<span class="val">' + fromCents(shares[p.id] || 0).toFixed(2) + '</span></div>').join('');
  return '<div class="card"><div class="card-head"><h2>🗓️ Still to pay</h2>' +
    '<span class="sub">' + money(fromCents(total), baseCur()) + '</span></div>' +
    '<div class="list">' + list.map((e) => itemRow(e, { markPaid: true })).join('') + '</div>' + split +
    '<div class="hint">' + (solo()
      ? 'Nothing here counts as spent yet — the money hasn\'t gone.'
      : 'Nothing here counts towards the tally yet — nobody is out of pocket until it\'s paid.') +
    ' Tap <b>Paid</b> once the money actually goes.</div>' +
    '</div>';
}

/* ---------- household ---------- */
/**
 * A household ledger has two tabs, and the split is the whole point: each one
 * answers one question and never the other's.
 *
 * Monthly is these weeks and nothing else — what they cost, what was ticked
 * against them, what they left between you. Total is every month at once —
 * what the book has cost since it started, the debt that actually stands, and
 * the button that settles it. They used to be one page, and the tally card on
 * it printed a month's subtotal directly above a running total that could
 * contradict it. Two right answers to one question is a wrong page.
 */
function householdView(l: Ledger): string {
  const tab = (v: Scope, label: string): string =>
    '<button class="chip ' + (UI.scope === v ? 'on' : '') + '" data-act="scope" data-v="' + v + '">' +
    '<span class="tick">' + (UI.scope === v ? '✓' : '') + '</span>' + label + '</button>';
  const tabs = '<div class="chips scopetabs">' + tab('month', '📅 Monthly') + tab('all', '🧮 Total') + '</div>';
  return tabs + (UI.scope === 'all' ? totalView(l) : monthView(l, UI.month));
}

/** Every month together: what the book has cost, and where it leaves you. */
function totalView(l: Ledger): string {
  const v = spentView(S, l.id, null);
  let out = totalCard(v);
  if (!solo()) out += receiptCard(l, null);
  out += plannedCard(v);
  /* The whole log, grouped by the month each repayment was filed under —
     `repaymentsView` already heads the groups when there is more than one. */
  if (!solo()) out += repaymentsCard(l, null);
  out += catCard(v);
  return out;
}

/**
 * What the book has cost since it started, in the shape the month card uses —
 * the same figure, the same recurring/extras split, so moving between the tabs
 * moves one number rather than re-teaching a layout.
 */
function totalCard(v: SpentView): string {
  const sum = v.summary;
  const title = '<div class="receipt-title">spent in all · ' + esc(baseCur()) + '</div>';
  const shell = (body: string): string =>
    '<div class="' + (solo() ? 'receipt' : 'card') + ' monthcard">' + body + '</div>';
  if (!sum.count && !sum.planned) {
    return shell(title + '<div class="empty"><span class="big">🐷</span>Nothing spent yet.<br>Tap ＋ Add and this is where it adds up.</div>');
  }
  const row = (k: string, val: string): string =>
    '<div class="rrow"><span>' + k + '</span><span class="dots"></span><span class="val">' + val + '</span></div>';
  /* A usual month is what the total can say and a month never could — and it
     only means anything once there are two of them to average. */
  const tail = '<div class="tear"></div>' +
    (sum.span > 1 ? row('a usual month', fromCents(sum.perMonth).toFixed(2)) : '') +
    row(sum.count + ' entr' + (sum.count === 1 ? 'y' : 'ies') +
      (sum.since ? ' since ' + monthLabel(sum.since) : ''), fromCents(sum.total).toFixed(2));
  return shell(title + '<div class="figure">' + fromCents(v.totals.spent).toFixed(2) + '</div>' + splitRow(v) + tail);
}

/** One month: what it cost, what was ticked against it, what it left. */
function monthView(l: Ledger, mk: MonthKey): string {
  const v = spentView(S, l.id, mk);
  const recs = v.recurring;
  const ad = v.oneOff;
  const soon = upcomingRules(S, l.id, mk, 12);

  /* Which month, and nothing else. The list had a heading row here — its
     emoji and its name, directly under the pill in the bar that already said
     both — and the rename pencil beside it; the pill carries that now. */
  let out = `
  <div class="monthnav">
    <button class="icon-btn" data-act="month" data-v="-1" aria-label="Previous month">‹</button>
    <h2>${monthLabel(mk)}</h2>
    <button class="icon-btn" data-act="month" data-v="1" aria-label="Next month">›</button>
  </div>`;
  if (mk !== thisMonth()) out += '<button class="today-link" data-act="month" data-v="0">jump back to today</button>';

  out += monthCard(l, mk, v);
  if (!solo()) out += receiptCard(l, mk);

  out += '<div class="card"><div class="card-head"><h2>🔁 Recurring</h2>' +
    '<button class="btn soft sm" data-act="rules">Manage</button></div>' +
    (recs.length ? '<div class="list">' + recs.map((o) => itemRow(o)).join('') + '</div>'
      : '<div class="empty"><span class="big">🗓️</span>No recurring bills land in this month.<br><button class="btn soft sm" style="margin-top:10px" data-act="new-rule">Add a recurring bill</button></div>') +
    '</div>';

  out += '<div class="card"><div class="card-head"><h2>🧾 Extras this month</h2>' +
    '<span class="sub">' + ad.length + ' item' + (ad.length === 1 ? '' : 's') + '</span></div>' +
    (ad.length ? '<div class="list">' + ad.map((e) => itemRow(e)).join('') + '</div>'
      : '<div class="empty"><span class="big">🌸</span>Nothing extra yet — a clean month!</div>') +
    '</div>';

  out += plannedCard(v);
  if (!solo()) out += repaymentsCard(l, mk);
  out += catCard(v);

  if (soon.length) {
    out += '<div class="card flat"><div class="card-head"><h2>👀 Coming up</h2></div><div class="list">' +
      soon.map((o) => '<div class="item" data-act="open" data-kind="recurring" data-id="' + o.id + '"><div class="emo">' + esc(o.emoji) + '</div>' +
        '<div class="item-main"><div class="name">' + esc(o.name) + '</div><div class="meta">' + monthLabel(o.period) + ' · ' + FREQ_TAG[o.frequency] + '</div></div>' +
        '<div class="amount">' + money(toBase(o.amount, o.currency, null), baseCur()) + '</div></div>').join('') +
      '</div></div>';
  }
  return out;
}

function catCard(v: SpentView): string {
  const cats = v.categories;
  if (!cats.length) return '';
  /* The pie is the spend it charts, not a sum of its own: the same figure the
     card above prints, so a slice can never add up to a different month. */
  const total = v.totals.spent || 1;
  const bar = cats.slice(0, 8).map((c, i) => '<span style="width:' + (c.cents / total * 100) + '%;background:' + COLORS[i % COLORS.length] + '"></span>').join('');
  const leg = cats.slice(0, 8).map((c, i) => '<span><i style="background:' + COLORS[i % COLORS.length] + '"></i>' + c.emoji + ' ' + fromCents(c.cents).toFixed(0) + '</span>').join('');
  return '<div class="card flat"><div class="card-head"><h2>🍰 Where it went</h2><span class="sub">' + money(fromCents(total), baseCur()) + '</span></div>' +
    '<div class="bar">' + bar + '</div><div class="legend">' + leg + '</div></div>';
}

/* ---------- trip ---------- */
function tripView(l: Ledger): string {
  const v = spentView(S, l.id, null);
  const items = v.oneOff;
  const total = v.totals.spent;
  const planned = v.planned;
  const planTotal = v.totals.planned;
  const days: Record<string, (Expense & { kind: 'adhoc' })[]> = {};
  items.forEach((e) => { (days[e.date] = days[e.date] || []).push(e); });
  const range = [l.startDate, l.endDate].filter(Boolean).map((d) => dayLabel(d as string)).join(' → ');

  /* Named once, in the bar — this card says what the trip has cost and when
     it runs, which is what you came to it for. Renaming is the pill's job. */
  let out = '<div class="card" style="margin-top:16px"><div class="card-head">' +
    '<h2 style="font-size:19px">' + esc(range || 'The trip so far') + '</h2></div>' +
    '<div class="sub">' + items.length + ' expense' + (items.length === 1 ? '' : 's') +
    (planned.length ? ' · ' + planned.length + ' still to pay' : '') + '</div>' +
    '<div class="mono" style="font-size:30px;font-weight:700;margin-top:10px">' + money(fromCents(total), baseCur()) + '</div>' +
    (planTotal ? '<div class="sub" style="margin-top:4px">＋ ' + money(fromCents(planTotal), baseCur()) +
      ' planned · <b>' + money(fromCents(total + planTotal), baseCur()) + '</b> all in</div>' : '') +
    '</div>';

  /* The card above already says what the trip cost and how much is still
     to pay, so a solo trip needs no summary of its own — only no tally. */
  if (!solo()) out += receiptCard(l, null);

  if (!items.length) {
    out += '<div class="card"><div class="empty"><span class="big">🧳</span>' +
      (planned.length ? 'Nothing paid yet — just the plan below.' : 'No expenses yet. Tap ＋ Add after the first coffee.') + '</div></div>';
  } else {
    out += '<div class="card"><div class="card-head"><h2>🧾 Expenses</h2></div>' +
      Object.keys(days).sort().reverse().map((d) =>
        '<div class="daygroup">' + dayLabel(d) + '</div><div class="list">' + days[d].map((e) => itemRow(e)).join('') + '</div>'
      ).join('') + '</div>';
  }
  out += plannedCard(v);
  if (!solo()) out += repaymentsCard(l, null);
  if (items.length) out += catCard(v);
  return out;
}
