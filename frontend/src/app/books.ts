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
import { gateError, leaveGate, markBusy, paintGate, splash } from './gate';
import { hydrate } from './hydrate';
import { closeModal, head, openModal, toast } from './modals';
import { render } from './render';
import { lastBook, rememberBook, session } from './session';
import {
  ApiError, acceptInvite, claimPerson, createBook, createInvite, deleteBook, getInvite, inviteUrl,
  listBooks, listMembers, previewInvite, removeMember, revokeInvite,
} from '../storage/api';
import type { BookSummary, Invite, InvitePreview, Member } from '../storage/api';
import type { Person } from '../model/types';
import { store, useServerBook } from '../storage/store';
import { blankState } from '../model/state';
import { $, esc } from '../lib/utils';

/** A `?join=CODE` link, parked until we know who is signed in. */
let parkedJoin: string | null = null;

export function setPendingJoin(code: string | null): void { parkedJoin = code; }

/** What the sign-in gate reads to know it is showing somebody the door in. */
export function pendingJoin(): string | null { return parkedJoin; }

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
 * else the only one. With none at all we ask rather than make one. Called
 * straight after sign-in.
 */
export async function enterBooks(): Promise<void> {
  splash('Fetching your piggy banks…');
  try {
    if (parkedJoin) {
      const code = parkedJoin;
      parkedJoin = null;
      clearJoinParam();
      if (await showJoinGate(code)) return;
    }
    const books = await listBooks();
    const wanted = lastBook();
    const remembered = books.find((b) => b.id === wanted);
    if (remembered) { await openBook(remembered); return; }
    if (!books.length) { firstBankGate(); return; }
    // Nothing remembered and more than one to choose from: ask. Guessing here
    // is the worst kind of wrong — every book is called Piggy until it is
    // renamed, so landing in the private one looks exactly like landing in the
    // shared one, and everything typed into it is invisible to the people you
    // share with.
    if (books.length > 1) { showBankGate(books); return; }
    await openBook(books[0]);
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

/**
 * Full-screen because no book is open yet — the same shape as the join gate.
 * `book-open` is the switcher's own action, so picking one here goes down
 * exactly the path that remembers it.
 */
function showBankGate(books: BookSummary[]): void {
  const rows = books.map((b) => {
    const who = b.members === 1 ? 'just you' : b.members + ' people';
    return '<button type="button" class="item" style="width:100%;text-align:left" ' +
      'data-act="book-open" data-id="' + b.id + '">' +
      '<div class="emo">' + (b.members > 1 ? '👥' : '🏦') + '</div>' +
      '<div class="item-main"><div class="name">' + esc(b.name) + '</div>' +
      '<div class="meta"><span>' + who + '</span>' +
      (b.role === 'owner' ? '<span>·</span><span>you own it</span>' : '') + '</div></div>' +
      '<span class="sub">open</span></button>';
  }).join('');

  paintGate(`
    <div class="card" style="margin-top:20px">
      <h2 style="font-size:22px">Which piggy bank? 🐷</h2>
      <p class="sub" style="margin:8px 0 18px;line-height:1.5">You're in more than one. Pick the one you want — this device will remember it.</p>
      <div class="list">${rows}</div>
    </div>`);
}

/**
 * Signed in and in no piggy bank at all — a brand-new account, or the last
 * one just left or deleted. Nothing is made on anybody's behalf here: a book
 * that appears by itself is how expenses end up somewhere the people you
 * share with can't see them, and it is named by whoever wanted it.
 */
function firstBankGate(error?: string): void {
  paintGate(`
    <div class="card" style="margin-top:20px">
      <h2 style="font-size:22px">Start a piggy bank 🐷</h2>
      <p class="sub" style="margin:8px 0 18px;line-height:1.5">You're in, but not in a piggy bank yet. Name one and it's yours — the flat, a trip, whatever you're splitting.</p>
      <div class="field"><label>Piggy bank name</label>
        <input class="input" id="bankName" placeholder="e.g. Home" autocomplete="off"></div>
      <button class="btn primary wide" data-act="book-new">Create it</button>
      ${error ? '<div class="auth-error">' + esc(error) + '</div>' : ''}
      <div class="hint">Been invited to somebody else's? Open their link and you'll land straight in it — there's no need to make one first.</div>
    </div>`);
  const el = $('#bankName') as HTMLInputElement | null;
  if (el) el.focus();
}

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

/* ---------- the switcher: one place to manage every bank ---------- */

/**
 * What the switcher last listed. Every per-bank action carries an id, and
 * this is how it finds the bank behind it — the one being invited to, left
 * or deleted is often not the one that happens to be open.
 */
let listed: BookSummary[] = [];

function bookById(id: string | undefined): BookSummary | null {
  if (!id) return session.book;
  return listed.find((b) => b.id === id) || (session.book?.id === id ? session.book : null);
}

/**
 * One bank as a single object: the row you tap to open it, and a strip of its
 * own actions sharing its border. They were loose buttons in a gap under the
 * row before — which read as belonging to nothing in particular, and cost a
 * card's height each on a phone.
 */
function bankCard(b: BookSummary): string {
  const here = b.id === session.book?.id;
  // A book keeps at least one owner, so its only owner has no one to leave it
  // to; deleting is their way out and offering "leave" would only be refused.
  const soleOwner = b.role === 'owner' && b.owners === 1;
  const actions = [
    b.role === 'owner'
      ? '<button data-act="book-share" data-id="' + b.id + '">👋 Invite</button>'
      : '',
    soleOwner ? '' : '<button data-act="book-leave" data-id="' + b.id + '">🚪 Leave</button>',
    b.role === 'owner'
      ? '<button class="warn" data-act="book-delete" data-id="' + b.id + '">🗑️ Delete</button>'
      : '',
  ].join('');

  return '<div class="itemcard' + (here ? ' on' : '') + '">' +
    '<div class="item" data-act="book-open" data-id="' + b.id + '">' +
    '<div class="emo">' + (here ? '🐷' : b.members > 1 ? '👥' : '🏦') + '</div>' +
    '<div class="item-main"><div class="name">' + esc(b.name) + '</div>' +
    '<div class="meta"><span>' + b.members + (b.members === 1 ? ' person' : ' people') + '</span>' +
    (b.role === 'owner' ? '<span>·</span><span>you own it</span>' : '') + '</div></div>' +
    '<span class="sub">' + (here ? 'open' : 'switch') + '</span></div>' +
    (actions ? '<div class="itembar">' + actions + '</div>' : '') +
    '</div>';
}

/**
 * Every piggy bank you are in, and everything you can do to one: open it,
 * invite somebody, walk out, delete it, start another. All of it here rather
 * than scattered, because the bank you want rid of is not one you want to
 * open first — and a way out buried in the sharing sheet is no way out.
 */
export async function banksModal(): Promise<void> {
  openModal(head('Your piggy banks') + '<div class="empty">Loading…</div>');
  try {
    listed = await listBooks();
  } catch (err) {
    closeModal(); toast(message(err)); return;
  }

  openModal(head('Your piggy banks') + `
    <div class="list">${listed.map(bankCard).join('')}</div>
    <div class="divider"></div>
    <div class="field"><label>Start another one</label>
      <div class="addrow">
        <input class="input" id="bankName" placeholder="e.g. Lisbon crew" autocomplete="off">
        <button class="btn soft" data-act="book-new">＋ New</button>
      </div></div>
    <div class="hint">Each one keeps its own people, lists, currencies and look — the flat in one, the friends you travel with in another.</div>`);
}

export async function switchTo(bookId: string): Promise<void> {
  if (bookId === session.book?.id) { closeModal(); return; }
  closeModal();
  const books = await listBooks().catch(() => [] as BookSummary[]);
  const book = books.find((b) => b.id === bookId);
  if (book) { await openBook(book); return; }
  toast("Couldn't open that piggy bank — try again");
}

/** True while a book is being made, so a double tap can't make two. */
let making = false;

/**
 * Make a book from whatever `#bankName` holds. Both doors lead here — the
 * switcher's "start another one" and the gate shown to somebody who is in
 * none — so which of the two is on screen decides where an error goes.
 */
export async function newBank(): Promise<void> {
  if (making) return;
  const el = $('#bankName') as HTMLInputElement | null;
  const name = (el ? el.value : '').trim() || 'Piggy';
  const onGate = document.body.classList.contains('gate');
  making = true;
  if (onGate) markBusy('Creating…'); else closeModal();
  try {
    const book = await createBook(name);
    setState(blankState());
    UI.ledgerId = null;
    await openBook(book);
    toast(name + ' is ready 🐷');
  } catch (err) {
    if (onGate) firstBankGate(message(err)); else toast(message(err));
  } finally {
    making = false;
  }
}

/* ---------- who's in a bank, and the link into it ---------- */

/**
 * The bank the share sheet is showing. Not always the one that's open — the
 * switcher invites into any of them — so every button on that sheet acts on
 * this rather than on whatever happens to be on screen behind it.
 */
let sharing: BookSummary | null = null;

/**
 * `people` is empty for a bank that isn't open: its tally hasn't been loaded,
 * so who a member is inside it is unknowable from here. Claiming a person is
 * for the open book only, for the same reason.
 */
function memberRow(m: Member, people: Person[], here: boolean, canRemove: boolean): string {
  const person = people.find((p) => p.id === m.personId);
  const who = person ? esc(person.emoji) + ' ' + esc(person.name)
    : here ? 'not linked to anyone yet' : '';
  return '<div class="item">' +
    '<div class="emo">' + (person ? esc(person.emoji) : '👤') + '</div>' +
    '<div class="item-main"><div class="name">' + esc(m.name || m.email) + (m.isMe ? ' <span class="sub">(you)</span>' : '') + '</div>' +
    '<div class="meta"><span>' + esc(m.email) + '</span>' + (who ? '<span>·</span><span>' + who + '</span>' : '') +
    (m.role === 'owner' ? '<span class="tag t-joint">owner</span>' : '') + '</div></div>' +
    (m.isMe
      ? (here ? '<button class="btn soft sm" data-act="claim-open">That\'s me…</button>' : '')
      : canRemove ? '<button class="btn soft sm" data-act="member-remove" data-id="' + m.userId + '">Remove</button>' : '') +
    '</div>';
}

/**
 * The one link for the book on screen — named, so it can't be mistaken for
 * another bank's. What you see here is the whole of what is live: a second
 * code nobody can see is a grant nobody can take back.
 */
function inviteBlock(book: BookSummary, invite: Invite | null): string {
  if (!invite) {
    return '<div class="empty"><span class="big">✉️</span>No link yet for ' + esc(book.name) + '.</div>' +
      '<button class="btn primary wide" style="margin-top:10px" data-act="invite-new">Make an invite link</button>' +
      '<div class="hint">One link per piggy bank. It opens ' + esc(book.name) + ' and nothing else you keep here.</div>';
  }
  // The link and its Copy on one line, the code and its Revoke on the next:
  // four stacked blocks and a wide button used to push the hint off a phone.
  return '<div class="field"><label>Send this link</label>' +
    '<div class="addrow"><input class="input mono" id="inviteUrl" readonly value="' + esc(inviteUrl(invite.code)) + '">' +
    '<button class="btn primary" data-act="invite-copy" data-id="' + esc(invite.code) + '">Copy</button></div></div>' +
    '<div class="field"><label>Or read out the code</label>' +
    '<div class="addrow">' +
    '<div class="input mono" style="font-size:22px;letter-spacing:4px;text-align:center">' + esc(invite.code) + '</div>' +
    '<button class="btn soft" data-act="invite-revoke">Revoke</button></div></div>' +
    '<div class="hint">Anyone holding this link can join ' + esc(book.name) + ' — and only ' + esc(book.name) + '. It expires ' + esc(invite.expiresAt.slice(0, 10)) + ', and revoking shuts the door on anyone who hasn\'t used it yet.</div>';
}

/**
 * Who is in a bank and how to let somebody else in. Only that: opening it,
 * leaving it and deleting it all live one screen up, in the switcher, so
 * there is one place that manages banks rather than three.
 */
export async function shareModal(bookId?: string): Promise<void> {
  const book = bookById(bookId);
  if (!book) { toast('No piggy bank open'); return; }
  sharing = book;
  const here = book.id === session.book?.id;
  openModal(head('Share ' + esc(book.name)) + '<div class="empty">Loading…</div>');

  let members: Member[] = [];
  let invite: Invite | null = null;
  try {
    members = await listMembers(book.id);
    if (book.role === 'owner') invite = await getInvite(book.id);
  } catch (err) {
    closeModal(); toast(message(err)); return;
  }

  // The switcher's counts came from whenever it last listed; these are now.
  book.members = members.length;
  book.owners = members.filter((m) => m.role === 'owner').length;

  openModal(head('Share ' + esc(book.name)) + `
    <div class="card-head"><h2>👥 Who's in</h2><span class="sub">${members.length}</span></div>
    <div class="list">${members.map((m) => memberRow(m, here ? S.people : [], here, book.role === 'owner')).join('')}</div>
    ${book.role === 'owner' ? `
      <div class="divider"></div>
      <div class="card-head"><h2>🔗 Invite link for ${esc(book.name)}</h2></div>
      ${inviteBlock(book, invite)}
    ` : '<div class="hint">Only an owner can invite people to this piggy bank.</div>'}
    <div class="divider"></div>
    <button class="btn soft wide" data-act="banks">← Your piggy banks</button>`);
}

/**
 * Deleting takes the book away from everyone in it, so the name is typed
 * rather than a yes tapped — a confirm dialog is one careless tap, and there
 * is nothing on the far side of this to restore from.
 */
export function confirmDeleteBank(bookId?: string): void {
  const book = bookById(bookId);
  if (!book) { toast('No piggy bank open'); return; }
  const shared = book.members > 1;
  openModal(head('Delete ' + esc(book.name) + '?') + `
    <p class="sub" style="margin:0 0 14px;line-height:1.5">This erases the whole piggy bank — its people, accounts, lists, recurring bills, expenses and repayments${
      shared ? ', for everyone in it' : ''
    }. There is no undo.</p>
    ${shared ? '<div class="hint" style="margin-bottom:14px">' + book.members + ' people are in this one. Leaving instead keeps it standing for them.</div>' : ''}
    <div class="field"><label>Type the name to confirm</label>
      <input class="input" id="killName" placeholder="${esc(book.name)}"
             autocomplete="off" autocapitalize="off" spellcheck="false"></div>
    <button class="btn danger wide" data-act="book-delete-go" data-id="${book.id}">Delete it for good</button>
    <div class="row-btns" style="margin-top:12px">
      <button class="btn soft wide" data-act="banks">Keep it</button>
    </div>`);
  const el = $('#killName') as HTMLInputElement | null;
  if (el) el.focus();
}

export async function deleteBank(bookId?: string): Promise<void> {
  const book = bookById(bookId);
  if (!book) return;
  const el = $('#killName') as HTMLInputElement | null;
  const typed = (el ? el.value : '').trim();
  if (typed.toLowerCase() !== book.name.trim().toLowerCase()) {
    toast('Type the name exactly to confirm');
    return;
  }
  try {
    await deleteBook(book.id);
  } catch (err) {
    toast(message(err)); return;
  }
  listed = listed.filter((b) => b.id !== book.id);
  toast(book.name + ' is gone');
  // Deleting one you weren't in leaves you where you were — back to the list.
  if (book.id !== session.book?.id) { await banksModal(); return; }
  closeModal();
  leftForGood();
  await enterBooks();
}

/** Forget the book that was open: it is gone, or we are no longer in it. */
function leftForGood(): void {
  rememberBook(null);
  session.book = null;
  setState(blankState());
  UI.ledgerId = null;
}

export async function makeInvite(): Promise<void> {
  const book = sharing;
  if (!book) return;
  try {
    const invite = await createInvite(book.id);
    await shareModal(book.id);
    await copyInvite(invite.code);
  } catch (err) {
    toast(message(err));
  }
}

export async function copyInvite(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteUrl(code));
    toast('Link copied — send it over 🔗');
  } catch {
    // Clipboard is blocked outside a secure context. The share screen already
    // shows the link in full, so selecting it is all that's left to do.
    const el = $('#inviteUrl') as HTMLInputElement | null;
    if (el) el.select();
    toast('Copy it by hand — this browser wouldn\'t let us');
  }
}

export async function killInvite(): Promise<void> {
  const book = sharing;
  if (!book) return;
  if (!confirm('Revoke the link to ' + book.name + '? Anyone who hasn\'t used it yet will need a new one.')) return;
  try {
    await revokeInvite(book.id);
    await shareModal(book.id);
    toast('Link revoked');
  } catch (err) {
    toast(message(err));
  }
}

export async function kickMember(userId: string): Promise<void> {
  const book = sharing;
  if (!book) return;
  if (!confirm('Remove them from ' + book.name + '? Their entries stay.')) return;
  try {
    await removeMember(book.id, userId);
    await shareModal(book.id);
  } catch (err) {
    toast(message(err));
  }
}

export async function leaveBank(bookId?: string): Promise<void> {
  const book = bookById(bookId);
  const me = session.user;
  if (!book || !me) return;
  if (!confirm('Leave ' + book.name + '? You will need a new invite to get back in.')) return;
  try {
    await removeMember(book.id, me.id);
  } catch (err) {
    toast(message(err)); return;
  }
  listed = listed.filter((b) => b.id !== book.id);
  // Walking out of one you weren't in leaves the open book alone.
  if (book.id !== session.book?.id) { await banksModal(); toast('Left ' + book.name); return; }
  closeModal();
  leftForGood();
  await enterBooks();
}

/* ---------- which person am I ---------- */

/** Ask once, when a member isn't linked to anyone in the tally yet. */
export async function maybeAskWhoYouAre(): Promise<void> {
  const book = session.book;
  if (!book || book.personId || !S.people.length) return;
  await claimModal();
}

/**
 * Link the account to the person it just made for itself, without asking.
 *
 * Only ever called with the person onboarding built from the profile — same
 * name, same face — so there is nothing to ask: the answer was typed into the
 * box labelled "Your name". Anything else falls back to the question.
 *
 * The book is pushed before the claim rather than left to the debounced save:
 * the server refuses to link an account to a person it hasn't seen yet.
 */
export async function adoptPerson(personId: string | null): Promise<void> {
  const book = session.book;
  if (!book || !personId) { await maybeAskWhoYouAre(); return; }
  try {
    await store.save(S);
    const me = await claimPerson(book.id, personId);
    book.personId = me.personId;
    render();
  } catch {
    await maybeAskWhoYouAre();
  }
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
