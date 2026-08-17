/**
 * The sign-in gate for the self-hosted build.
 *
 * Nothing in here runs on GitHub Pages: main.ts only reaches this module
 * after /api/health has answered. Once somebody is in, books.ts takes over
 * and decides which piggy bank to open.
 */
import { setState } from './context';
import { enterBooks, pendingJoin, setPendingJoin } from './books';
import { markBusy, paintGate } from './gate';
import { toast } from './modals';
import { session } from './session';
import { ApiError, claimInvite, requestCode, signOut, signUp, signupIsOpen, verifyCode } from '../storage/api';
import { blankState } from '../model/state';
import { $, esc } from '../lib/utils';

type Step = 'email' | 'code' | 'join' | 'signup';
/** Which of the three front doors this visitor came through. */
type Door = 'signin' | 'join' | 'signup';

/**
 * Three doors, one email round trip. `join` means arriving on somebody's
 * invite — the account is made if it isn't there yet and the bank the code
 * names is opened at the end. `signup` means starting from nothing, which
 * ends in a piggy bank of your own. Neither changes what the 6-digit code
 * does; they only change what happens on the far side of it, and whether we
 * can promise a mail is actually coming.
 */
const A: {
  step: Step; door: Door; email: string; name: string; joinCode: string;
  verificationId: string; error: string; busy: boolean;
} = { step: 'email', door: 'signin', email: '', name: '', joinCode: '', verificationId: '', error: '', busy: false };

const errorLine = (): string =>
  A.error ? '<div class="auth-error">' + esc(A.error) + '</div>' : '';

export function signInScreen(error?: string): void {
  A.error = error || '';
  A.busy = false;
  // A ?join= link lands here first: adopt its code so the visitor gets the
  // joining screens rather than a sign-in that would turn them away.
  if (!A.joinCode && pendingJoin()) { A.joinCode = pendingJoin()!; A.door = 'join'; }

  if (A.step === 'signup') {
    paintGate(`
      <div class="card" style="margin-top:20px">
        <h2 style="font-size:22px">Start a piggy bank ✨</h2>
        <p class="sub" style="margin:8px 0 18px;line-height:1.5">No password to pick — tell us where to reach you and we'll send a 6-digit code every time you sign in.</p>
        <div class="field"><label>Your name</label>
          <input class="input" id="authName" autocomplete="name" placeholder="Léa" value="${esc(A.name)}"></div>
        <div class="field"><label>Email</label>
          <input class="input" id="authEmail" type="email" inputmode="email" autocomplete="email"
                 placeholder="you@example.com" value="${esc(A.email)}"></div>
        <button class="btn primary wide" data-act="auth-signup-go">Create my account</button>
        ${errorLine()}
        <div class="row-btns" style="margin-top:12px">
          <button class="btn soft wide" data-act="auth-signin">I already have one</button>
        </div>
      </div>`);
    const el = $('#authName') as HTMLInputElement | null;
    if (el) el.focus();
  } else if (A.step === 'join') {
    paintGate(`
      <div class="card" style="margin-top:20px">
        <h2 style="font-size:22px">Join a piggy bank 🐷</h2>
        <p class="sub" style="margin:8px 0 18px;line-height:1.5">Been sent a code? Type it in and we'll get you into that piggy bank — no account needed beforehand.</p>
        <div class="field"><label>Invite code</label>
          <input class="input mono" id="authJoinCode" autocomplete="off" autocapitalize="characters"
                 spellcheck="false" maxlength="8" placeholder="ABCD2345" value="${esc(A.joinCode)}"
                 style="font-size:22px;letter-spacing:4px;text-align:center;text-transform:uppercase"></div>
        <button class="btn primary wide" data-act="auth-join-go">Continue</button>
        ${errorLine()}
        <div class="row-btns" style="margin-top:12px">
          <button class="btn soft wide" data-act="auth-signin">I'll sign in instead</button>
        </div>
      </div>`);
    const el = $('#authJoinCode') as HTMLInputElement | null;
    if (el) el.focus();
  } else if (A.step === 'email' && A.joinCode) {
    paintGate(`
      <div class="card" style="margin-top:20px">
        <h2 style="font-size:22px">What's your email? 📮</h2>
        <p class="sub" style="margin:8px 0 18px;line-height:1.5">Code <b class="mono">${esc(A.joinCode)}</b> it is. We'll send a 6-digit code to sign you in, then drop you straight into that piggy bank.</p>
        <div class="field"><label>Email</label>
          <input class="input" id="authEmail" type="email" inputmode="email" autocomplete="email"
                 placeholder="you@example.com" value="${esc(A.email)}"></div>
        <button class="btn primary wide" data-act="auth-send">Send me a code</button>
        ${errorLine()}
        <div class="row-btns" style="margin-top:12px">
          <button class="btn soft" data-act="auth-join">Another code</button>
          <button class="btn soft" data-act="auth-signin">Sign in instead</button>
        </div>
      </div>`);
    const el = $('#authEmail') as HTMLInputElement | null;
    if (el && !A.email) el.focus();
  } else if (A.step === 'email') {
    paintGate(`
      <div class="card" style="margin-top:20px">
        <h2 style="font-size:22px">Welcome back 🐷</h2>
        <p class="sub" style="margin:8px 0 18px;line-height:1.5">This piggy bank lives on the server, so it needs to know who you are. Pop in your email and we'll send you a sign-in code.</p>
        <div class="field"><label>Email</label>
          <input class="input" id="authEmail" type="email" inputmode="email" autocomplete="email"
                 placeholder="you@example.com" value="${esc(A.email)}"></div>
        <button class="btn primary wide" data-act="auth-send">Send me a code</button>
        ${errorLine()}
        <div class="divider"></div>
        <button class="btn soft wide" data-act="auth-join">🔗 I've got an invite code</button>
        ${signupIsOpen()
          ? '<button class="btn soft wide" style="margin-top:8px" data-act="auth-signup">✨ Create an account</button>'
          : ''}
        <div class="hint">${signupIsOpen()
          ? 'Somebody shared a piggy bank with you? Their code gets you in. Nobody has? Start one of your own.'
          : 'Somebody shared a piggy bank with you? Their code gets you in, even if you\'ve never been here before.'}</div>
      </div>`);
    const el = $('#authEmail') as HTMLInputElement | null;
    if (el && !A.email) el.focus();
  } else {
    paintGate(`
      <div class="card" style="margin-top:20px">
        <h2 style="font-size:22px">Check your email 📬</h2>
        <p class="sub" style="margin:8px 0 18px;line-height:1.5">${
          A.door === 'signin'
            ? 'If <b>' + esc(A.email) + '</b> has an account, a 6-digit code is on its way. It\'s good for 15 minutes.'
            : 'A 6-digit code is on its way to <b>' + esc(A.email) + '</b>. It\'s good for 15 minutes.'
        }</p>
        <div class="field"><label>Sign-in code</label>
          <input class="input mono" id="authCode" inputmode="numeric" autocomplete="one-time-code"
                 maxlength="6" placeholder="123456" style="font-size:22px;letter-spacing:6px;text-align:center"></div>
        <button class="btn primary wide" data-act="auth-verify">Sign in</button>
        ${errorLine()}
        <div class="row-btns" style="margin-top:12px">
          <button class="btn soft" data-act="auth-back">Another email</button>
          <button class="btn soft" data-act="auth-resend">Send a new code</button>
        </div>
      </div>`);
    const el = $('#authCode') as HTMLInputElement | null;
    if (el) el.focus();
  }
}

/* ---------- actions ---------- */

export async function sendCode(): Promise<void> {
  if (A.busy) return;
  const el = $('#authEmail') as HTMLInputElement | null;
  const email = (el ? el.value : A.email).trim();
  if (!email || !email.includes('@')) { A.email = email; signInScreen('That does not look like an email address.'); return; }
  A.busy = true;
  A.email = email;
  markBusy('Sending…');
  try {
    // Joining says the code out loud, so the server can vouch for a brand-new
    // address; signing in never does, so an unknown one stays unanswerable.
    const { verificationId } = A.door === 'join' ? await claimInvite(A.joinCode, email) : await requestCode(email);
    A.verificationId = verificationId;
    A.step = 'code';
    signInScreen();
  } catch (err) {
    signInScreen(err instanceof ApiError ? err.message : "Couldn't reach the server — try again in a moment.");
  }
}

export async function submitCode(): Promise<void> {
  if (A.busy) return;
  const el = $('#authCode') as HTMLInputElement | null;
  const code = (el ? el.value : '').trim();
  if (code.length < 6) { signInScreen('Codes are six digits.'); return; }
  A.busy = true;
  markBusy('Signing in…');
  try {
    session.user = await verifyCode(A.verificationId, code);
    if (A.joinCode) { setPendingJoin(A.joinCode); A.joinCode = ''; }
    await enterBooks();
  } catch (err) {
    signInScreen(err instanceof ApiError ? err.message : "Couldn't reach the server — try again in a moment.");
  }
}

export function backToEmail(): void {
  A.step = A.door === 'signup' ? 'signup' : 'email';
  A.verificationId = '';
  signInScreen();
}

/** Starting from nothing: name, email, then a piggy bank of your own. */
export function startSignUp(): void {
  A.joinCode = '';
  setPendingJoin(null);
  A.door = 'signup';
  A.step = 'signup';
  A.verificationId = '';
  signInScreen();
}

export async function submitSignUp(): Promise<void> {
  if (A.busy) return;
  const nameEl = $('#authName') as HTMLInputElement | null;
  const emailEl = $('#authEmail') as HTMLInputElement | null;
  A.name = (nameEl ? nameEl.value : A.name).trim();
  const email = (emailEl ? emailEl.value : A.email).trim();
  A.email = email;
  if (!A.name) { signInScreen('What should we call you?'); return; }
  if (!email || !email.includes('@')) { signInScreen('That does not look like an email address.'); return; }
  A.busy = true;
  markBusy('Creating…');
  try {
    const { verificationId } = await signUp(email, A.name);
    A.verificationId = verificationId;
    A.step = 'code';
    signInScreen();
  } catch (err) {
    signInScreen(err instanceof ApiError ? err.message : "Couldn't reach the server — try again in a moment.");
  }
}

/** "I've got an invite code" — and the way back to it from the email step. */
export function startJoin(): void {
  const el = $('#authJoinCode') as HTMLInputElement | null;
  if (el) A.joinCode = el.value.trim().toUpperCase();
  A.door = 'join';
  A.step = 'join';
  A.verificationId = '';
  signInScreen();
}

/** Back to the plain sign-in door, dropping any code or half-typed account. */
export function backToSignIn(): void {
  A.joinCode = '';
  setPendingJoin(null);
  A.door = 'signin';
  A.step = 'email';
  A.verificationId = '';
  signInScreen();
}

export function submitJoinCode(): void {
  const el = $('#authJoinCode') as HTMLInputElement | null;
  const code = (el ? el.value : A.joinCode).trim().toUpperCase();
  A.joinCode = code;
  // The code is only checked once an email is on it: the server won't say
  // what a code opens until somebody is signed in, so a stranger guessing
  // codes here learns nothing either way.
  if (!code) { signInScreen('Pop in the code from your invite.'); return; }
  A.step = 'email';
  signInScreen();
}

/** Enter on a gate field does whatever that screen's primary button does. */
export function authEnter(fieldId: string): void {
  if (fieldId === 'authCode') { void submitCode(); return; }
  if (fieldId === 'authJoinCode') { submitJoinCode(); return; }
  if (A.step === 'signup') { void submitSignUp(); return; }
  void sendCode();
}

export function doSignOut(): void {
  signOut();
  session.user = null;
  session.book = null;
  // Which piggy bank was open is kept on purpose, under this account's own
  // key: signing out and back in used to drop you into the oldest book you
  // belong to, which for anyone who joined a shared one is the wrong bank.
  A.step = 'email';
  A.door = 'signin';
  A.joinCode = '';
  A.verificationId = '';
  setState(blankState());
  signInScreen();
  toast('Signed out');
}

/** The session died mid-use (refresh token rejected). Back to the gate. */
export function sessionExpired(): void {
  signOut();
  session.user = null;
  session.book = null;
  A.step = 'email';
  A.door = 'signin';
  A.joinCode = '';
  setState(blankState());
  signInScreen('That session has expired — sign in again.');
}
