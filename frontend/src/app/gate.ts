/**
 * The full-screen states that stand in front of the book: signing in,
 * loading, and "the server didn't answer".
 *
 * While the gate is up the app chrome is hidden (body.gate) so a visitor
 * with no book open can't type into a stray one. Kept separate from auth.ts
 * because the book-picking path needs the same screens without importing the
 * sign-in flow.
 */
import { $, esc } from '../lib/utils';

export function paintGate(html: string): void {
  document.body.classList.add('gate');
  const bar = $('#ledgerBar'); if (bar) bar.innerHTML = '';
  const fab = $('#fab'); if (fab) fab.style.display = 'none';
  const main = $('#main');
  if (main) main.innerHTML = html;
}

export function leaveGate(): void {
  document.body.classList.remove('gate');
}

export function splash(message: string): void {
  paintGate('<div class="card center" style="margin-top:20px"><div class="empty">' +
    '<span class="big">🐷</span>' + esc(message) + '</div></div>');
}

/** A dead end worth retrying: the button carries whatever data-act fits. */
export function gateError(title: string, message: string, retryAct: string, retryLabel = 'Try again'): void {
  paintGate('<div class="card" style="margin-top:20px"><h2 style="font-size:22px">' + esc(title) + '</h2>' +
    '<p class="sub" style="margin:8px 0 18px;line-height:1.5">' + esc(message) + '</p>' +
    '<button class="btn primary wide" data-act="' + retryAct + '">' + esc(retryLabel) + '</button></div>');
}

/** Freeze the submit button on a gate screen while a round trip is in flight. */
export function markBusy(label: string): void {
  const btn = $<HTMLButtonElement>('#main .btn.primary');
  if (btn) { btn.disabled = true; btn.textContent = label; }
}
