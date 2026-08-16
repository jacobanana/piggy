/**
 * The sign-in gate for the self-hosted build.
 *
 * Nothing in here runs on GitHub Pages: main.ts only reaches this module
 * after /api/health has answered. Once somebody is in, books.ts takes over
 * and decides which piggy bank to open.
 */
import { setState } from './context';
import { enterBooks } from './books';
import { markBusy, paintGate } from './gate';
import { toast } from './modals';
import { rememberBook, session } from './session';
import { ApiError, requestCode, signOut, verifyCode } from '../storage/api';
import { blankState } from '../model/state';
import { $, esc } from '../lib/utils';

type Step = 'email' | 'code';

const A: { step: Step; email: string; verificationId: string; error: string; busy: boolean } =
  { step: 'email', email: '', verificationId: '', error: '', busy: false };

const errorLine = (): string =>
  A.error ? '<div class="auth-error">' + esc(A.error) + '</div>' : '';

export function signInScreen(error?: string): void {
  A.error = error || '';
  A.busy = false;
  if (A.step === 'email') {
    paintGate(`
      <div class="card" style="margin-top:20px">
        <h2 style="font-size:22px">Welcome back 🐷</h2>
        <p class="sub" style="margin:8px 0 18px;line-height:1.5">This piggy bank lives on the server, so it needs to know who you are. Pop in your email and we'll send you a sign-in code.</p>
        <div class="field"><label>Email</label>
          <input class="input" id="authEmail" type="email" inputmode="email" autocomplete="email"
                 placeholder="you@example.com" value="${esc(A.email)}"></div>
        <button class="btn primary wide" data-act="auth-send">Send me a code</button>
        ${errorLine()}
      </div>`);
    const el = $('#authEmail') as HTMLInputElement | null;
    if (el && !A.email) el.focus();
  } else {
    paintGate(`
      <div class="card" style="margin-top:20px">
        <h2 style="font-size:22px">Check your email 📬</h2>
        <p class="sub" style="margin:8px 0 18px;line-height:1.5">If <b>${esc(A.email)}</b> has an account, a 6-digit code is on its way. It's good for 15 minutes.</p>
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
    const { verificationId } = await requestCode(email);
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
    await enterBooks();
  } catch (err) {
    signInScreen(err instanceof ApiError ? err.message : "Couldn't reach the server — try again in a moment.");
  }
}

export function backToEmail(): void {
  A.step = 'email';
  A.verificationId = '';
  signInScreen();
}

export function doSignOut(): void {
  signOut();
  session.user = null;
  session.book = null;
  rememberBook(null);
  A.step = 'email';
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
  setState(blankState());
  signInScreen('That session has expired — sign in again.');
}
