/**
 * Piggy banks you share: picking one, making one, inviting people into it,
 * and saying which person in the tally you are.
 *
 * A book is the unit of sharing — its own people, lists and currencies —
 * so belonging to several is how you keep the flat separate from a trip with
 * friends. None of this exists on the Pages build; the whole module is only
 * reached once a backend has answered and somebody is signed in.
 */
import { S, UI, setState } from './context';
import { gateError, leaveGate, paintGate, splash } from './gate';
import { hydrate } from './hydrate';
import { closeModal, head, openModal, toast } from './modals';
import { render } from './render';
import { isOwner, lastBook, rememberBook, session } from './session';
import {
  ApiError, acceptInvite, claimPerson, createBook, createInvite, inviteUrl, listBooks,
  listInvites, listMembers, previewInvite, removeMember, revokeInvite,
} from '../storage/api';
import type { BookSummary, Invite, InvitePreview, Member } from '../storage/api';
import { store, useServerBook } from '../storage/store';
import { blankState } from '../model/state';
import { $, esc } from '../lib/utils';

/** A `?join=CODE` link, parked until we know who is signed in. */
let pendingJoin: string | null = null;

export function setPendingJoin(code: string | null): void { pendingJoin = code; }

/** Drop ?join= from the address bar so a reload doesn't re-run the join. */
function clearJoinParam(): void {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('join')) return;
    url.searchParams.delete('join');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch { /* the param is harmless if it lingers */ }
}

/* ---------- entering ---------- */

/**
 * Pick a book and open it: the invite just followed, else the one last open,
 * else the first, else a fresh one. Called straight after sign-in.
 */
export async function enterBooks(): Promise<void> {
  splash('Fetching your piggy banks…');
  try {
    if (pendingJoin) {
      const code = pendingJoin;
      pendingJoin = null;
      clearJoinParam();
      if (await showJoinGate(code)) return;
    }
    const books = await listBooks();
    const wanted = lastBook();
    const book = books.find((b) => b.id === wanted) || books[0] || (await createBook('Piggy'));
    await openBook(book);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { signedOut(); return; }
    gateError("Can't reach the server 📡", message(err), 'books-retry');
  }
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : 'Something went wrong.';

function signedOut(): void {
  window.dispatchEvent(new CustomEvent('piggy:signedout'));
}

/** Load a book's contents and hand the app over to it. */
export async function openBook(book: BookSummary): Promise<void> {
  splash('Opening ' + book.name + '…');
  session.book = book;
  rememberBook(book.id);
  useServerBook(book.id);
  try {
    const state = await store.load();
    leaveGate();
    hydrate(state);
    await maybeAskWhoYouAre();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { signedOut(); return; }
    gateError("Can't open that piggy bank 📡", message(err), 'books-retry');
  }
}

export function retryBooks(): void { void enterBooks(); }

/* ---------- joining by invite ---------- */

/** Full-screen because it runs before any book is open. */
async function showJoinGate(code: string): Promise<boolean> {
  let preview: InvitePreview;
  try {
    preview = await previewInvite(code);
  } catch (err) {
    gateError('That invite didn\'t work 🙈', message(err), 'books-retry', 'Carry on to my piggy banks');
    return true;
  }
  const people = preview.members === 1 ? '1 person' : preview.members + ' people';
  paintGate(`
    <div class="card" style="margin-top:20px">
      <h2 style="font-size:22px">Join ${esc(preview.bookName)}? 🐷</h2>
      <p class="sub" style="margin:8px 0 18px;line-height:1.5">${
        preview.alreadyMember
          ? "You're already in this one — this will just open it."
          : 'You\'ve been invited to share this piggy bank. It has ' + people + ' in it so far.'
      }</p>
      <button class="btn primary wide" data-act="join-accept" data-id="${esc(code)}">${
        preview.alreadyMember ? 'Open it' : 'Join ' + esc(preview.bookName)
      }</button>
      <div class="row-btns" style="margin-top:12px">
        <button class="btn soft wide" data-act="books-retry">No thanks</button>
      </div>
    </div>`);
  return true;
}

export async function acceptJoin(code: string): Promise<void> {
  splash('Joining…');
  try {
    const book = await acceptInvite(code);
    await openBook(book);
    toast('You\'re in 🎉');
  } catch (err) {
    gateError('That invite didn\'t work 🙈', message(err), 'books-retry', 'Carry on to my piggy banks');
  }
}

/* ---------- the switcher ---------- */

export async function banksModal(): Promise<void> {
  openModal(head('Your piggy banks') + '<div class="empty">Loading…</div>');
  let books: BookSummary[];
  try {
    books = await listBooks();
  } catch (err) {
    closeModal(); toast(message(err)); return;
  }
  const rows = books.map((b) => {
    const here = b.id === session.book?.id;
    return '<div class="item" data-act="book-open" data-id="' + b.id + '">' +
      '<div class="emo">' + (here ? '🐷' : '🏦') + '</div>' +
      '<div class="item-main"><div class="name">' + esc(b.name) + '</div>' +
      '<div class="meta"><span>' + b.members + (b.members === 1 ? ' person' : ' people') + '</span>' +
      (b.role === 'owner' ? '<span>·</span><span>you own it</span>' : '') + '</div></div>' +
      '<span class="sub">' + (here ? 'open' : 'switch') + '</span></div>';
  }).join('');

  openModal(head('Your piggy banks') + `
    <div class="list">${rows}</div>
    <div class="divider"></div>
    <div class="field"><label>Start another one</label>
      <input class="input" id="bankName" placeholder="e.g. Lisbon crew" autocomplete="off"></div>
    <button class="btn soft wide" data-act="book-new">＋ New piggy bank</button>
    <div class="hint">Each piggy bank keeps its own people, lists and currencies. Share one with your flat and another with the friends you travel with.</div>
    <div class="divider"></div>
    <button class="btn primary wide" data-act="share">👋 Invite someone to ${esc(session.book?.name || 'this one')}</button>`);
}

export async function switchTo(bookId: string): Promise<void> {
  if (bookId === session.book?.id) { closeModal(); return; }
  closeModal();
  const books = await listBooks().catch(() => [] as BookSummary[]);
  const book = books.find((b) => b.id === bookId);
  if (book) await openBook(book);
}

export async function newBank(): Promise<void> {
  const el = $('#bankName') as HTMLInputElement | null;
  const name = (el ? el.value : '').trim() || 'Piggy';
  closeModal();
  try {
    const book = await createBook(name);
    setState(blankState());
    UI.ledgerId = null;
    await openBook(book);
    toast(name + ' is ready 🐷');
  } catch (err) {
    toast(message(err));
  }
}

/* ---------- sharing the open book ---------- */

function memberRow(m: Member, people: { id: string; name: string; emoji: string }[]): string {
  const person = people.find((p) => p.id === m.personId);
  const who = person ? esc(person.emoji) + ' ' + esc(person.name) : 'not linked to anyone yet';
  return '<div class="item">' +
    '<div class="emo">' + (person ? esc(person.emoji) : '👤') + '</div>' +
    '<div class="item-main"><div class="name">' + esc(m.name || m.email) + (m.isMe ? ' <span class="sub">(you)</span>' : '') + '</div>' +
    '<div class="meta"><span>' + esc(m.email) + '</span><span>·</span><span>' + who + '</span>' +
    (m.role === 'owner' ? '<span class="tag t-joint">owner</span>' : '') + '</div></div>' +
    (m.isMe
      ? '<button class="btn soft sm" data-act="claim-open">That\'s me…</button>'
      : isOwner() ? '<button class="btn soft sm" data-act="member-remove" data-id="' + m.userId + '">Remove</button>' : '') +
    '</div>';
}

function inviteRow(i: Invite): string {
  return '<div class="item"><div class="emo">🔗</div>' +
    '<div class="item-main"><div class="name mono">' + esc(i.code) + '</div>' +
    '<div class="meta"><span>expires ' + esc(i.expiresAt.slice(0, 10)) + '</span></div></div>' +
    '<button class="btn soft sm" data-act="invite-copy" data-id="' + esc(i.code) + '">Copy link</button>' +
    '<button class="btn soft sm" data-act="invite-revoke" data-id="' + i.id + '">✕</button></div>';
}

export async function shareModal(): Promise<void> {
  const book = session.book;
  if (!book) { toast('No piggy bank open'); return; }
  openModal(head('Share ' + esc(book.name)) + '<div class="empty">Loading…</div>');

  let members: Member[] = [];
  let invites: Invite[] = [];
  try {
    members = await listMembers(book.id);
    if (book.role === 'owner') invites = await listInvites(book.id);
  } catch (err) {
    closeModal(); toast(message(err)); return;
  }

  openModal(head('Share ' + esc(book.name)) + `
    <div class="card-head"><h2>👥 Who's in</h2><span class="sub">${members.length}</span></div>
    <div class="list">${members.map((m) => memberRow(m, S.people)).join('')}</div>
    ${book.role === 'owner' ? `
      <div class="divider"></div>
      <div class="card-head"><h2>🔗 Invite links</h2></div>
      ${invites.length ? '<div class="list">' + invites.map(inviteRow).join('') + '</div>'
        : '<div class="empty"><span class="big">✉️</span>No live invites.</div>'}
      <button class="btn primary wide" style="margin-top:10px" data-act="invite-new">Make an invite link</button>
      <div class="hint">Anyone holding the link can join this piggy bank, so send it to people you'd hand your bank statement to. Links last 14 days and you can revoke one at any time.</div>
    ` : '<div class="hint">Only an owner can invite people to this piggy bank.</div>'}
    <div class="divider"></div>
    <button class="btn danger wide" data-act="book-leave">Leave this piggy bank</button>`);
}

export async function makeInvite(): Promise<void> {
  const book = session.book;
  if (!book) return;
  try {
    const invite = await createInvite(book.id);
    await copyInvite(invite.code);
    await shareModal();
  } catch (err) {
    toast(message(err));
  }
}

export async function copyInvite(code: string): Promise<void> {
  const url = inviteUrl(code);
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied — send it over 🔗');
  } catch {
    // Clipboard is blocked outside a secure context; show it so it can be
    // read out or copied by hand.
    openModal(head('Your invite link') +
      '<div class="field"><label>Send this</label><input class="input mono" id="inviteUrl" readonly value="' + esc(url) + '"></div>' +
      '<div class="field"><label>Or read out the code</label><div class="mono" style="font-size:26px;letter-spacing:4px;text-align:center">' + esc(code) + '</div></div>' +
      '<button class="btn primary wide" data-act="share">Back</button>');
    const el = $('#inviteUrl') as HTMLInputElement | null;
    if (el) el.select();
  }
}

export async function killInvite(inviteId: string): Promise<void> {
  const book = session.book;
  if (!book) return;
  try {
    await revokeInvite(book.id, inviteId);
    await shareModal();
    toast('Invite revoked');
  } catch (err) {
    toast(message(err));
  }
}

export async function kickMember(userId: string): Promise<void> {
  const book = session.book;
  if (!book) return;
  if (!confirm('Remove them from this piggy bank? Their entries stay.')) return;
  try {
    await removeMember(book.id, userId);
    await shareModal();
  } catch (err) {
    toast(message(err));
  }
}

export async function leaveBank(): Promise<void> {
  const book = session.book;
  const me = session.user;
  if (!book || !me) return;
  if (!confirm('Leave ' + book.name + '? You will need a new invite to get back in.')) return;
  try {
    await removeMember(book.id, me.id);
    closeModal();
    rememberBook(null);
    session.book = null;
    setState(blankState());
    UI.ledgerId = null;
    await enterBooks();
  } catch (err) {
    toast(message(err));
  }
}

/* ---------- which person am I ---------- */

/** Ask once, when a member isn't linked to anyone in the tally yet. */
export async function maybeAskWhoYouAre(): Promise<void> {
  const book = session.book;
  if (!book || book.personId || !S.people.length) return;
  await claimModal();
}

export async function claimModal(): Promise<void> {
  const book = session.book;
  if (!book) return;
  let taken: Member[] = [];
  try { taken = await listMembers(book.id); } catch { /* offer everyone rather than nothing */ }
  const claimedBySomeoneElse = new Set(taken.filter((m) => !m.isMe && m.personId).map((m) => m.personId));

  const rows = S.people.map((p) => {
    const busy = claimedBySomeoneElse.has(p.id);
    return '<button type="button" class="chip ' + (p.id === book.personId ? 'on' : '') + '" ' +
      (busy ? 'disabled ' : '') + 'data-act="claim-person" data-id="' + p.id + '" style="width:100%;justify-content:flex-start">' +
      '<span class="avatar sm" style="background:' + p.color + '22;border-color:' + p.color + '">' + esc(p.emoji) + '</span>' +
      esc(p.name) + (busy ? ' <span class="sub">— taken</span>' : '') + '</button>';
  }).join('');

  openModal(head('Which one are you?') + `
    <p class="sub" style="margin:0 0 14px;line-height:1.5">Linking your account to a person keeps the tally honest — it's how Piggy knows which side of "owes" you're on.</p>
    <div class="chips" style="flex-direction:column;gap:8px">${rows}</div>
    <div class="hint">Nobody fits? Close this, add yourself under Settings › Us, then come back.</div>
    <div class="divider"></div>
    <button class="btn soft wide" data-act="close">I'll do it later</button>`);
}

export async function claim(personId: string): Promise<void> {
  const book = session.book;
  if (!book) return;
  try {
    const me = await claimPerson(book.id, personId);
    book.personId = me.personId;
    closeModal();
    render();
    toast('That\'s you 👋');
  } catch (err) {
    toast(message(err));
  }
}
