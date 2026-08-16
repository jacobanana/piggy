/** Global event delegation — every click/input/change routes through data-act. */
import { S, UI, account, activeLedger, ledger, person, rule, save } from './context';
import { commit, render } from './render';
import {
  F, accountForm, addChooser, closeModal, doSettle, expenseForm, ledgerForm, occurrenceModal,
  onboard, personForm, refreshSplit, ruleForm, rulesModal, saveAccount, saveExpense, saveLedger,
  saveOccurrence, savePerson, saveRule, saveSettings, saveSettlement, settingsModal, settleModal,
  settlementForm, toast,
} from './modals';
import { backToEmail, doSignOut, retry, sendCode, submitCode } from './auth';
import { exportCSV, exportJSON, fetchRates, importJSONFile } from './importexport';
import { applyTheme } from './theme';
import { blankState } from '../model/state';
import { setState } from './context';
import { addMonths, fromCents, monthOf, thisMonth, todayISO, $ } from '../lib/utils';
import { DEFAULT_RATES } from '../lib/constants';

export function wireEvents(): void {
  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const act = el.dataset.act!, id = el.dataset.id!, v = el.dataset.v!;
    if (!S) return;
    const l = activeLedger();
    switch (act) {
      /* sign-in gate (self-hosted build only) */
      case 'auth-send': case 'auth-resend': void sendCode(); return;
      case 'auth-verify': void submitCode(); return;
      case 'auth-back': backToEmail(); return;
      case 'auth-retry': retry(); return;
      case 'signout': closeModal(); doSignOut(); return;

      case 'backdrop': if (e.target === el) closeModal(); return;
      case 'close': closeModal(); return;
      case 'ledger': UI.ledgerId = id; UI.month = thisMonth(); render(); return;
      case 'new-ledger': ledgerForm(); return;
      case 'edit-ledger': ledgerForm(ledger(id)); return;
      case 'ledger-kind': {
        F.kind = v;
        el.parentElement!.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
        const td = $('#tripDates'); if (td) td.style.display = v === 'trip' ? '' : 'none';
        return;
      }
      case 'save-ledger': saveLedger(id || undefined); return;
      case 'del-ledger':
        if (confirm('Delete this list and everything in it?')) {
          S.ledgers = S.ledgers.filter((x) => x.id !== id);
          S.expenses = S.expenses.filter((x) => x.ledgerId !== id);
          S.rules = S.rules.filter((x) => x.ledgerId !== id);
          S.settlements = S.settlements.filter((x) => x.ledgerId !== id);
          UI.ledgerId = (S.ledgers[0] || {}).id ?? null;
          closeModal(); commit();
        }
        return;
      case 'month': UI.month = v === '0' ? thisMonth() : addMonths(UI.month, Number(v)); render(); return;
      case 'scope': UI.scope = v as 'month' | 'all'; render(); return;
      case 'add': if (l && l.kind === 'trip') expenseForm(); else addChooser(); return;
      case 'new-exp': expenseForm(); return;
      case 'new-rule': ruleForm(); return;
      case 'rules': rulesModal(); return;
      case 'edit-rule': ruleForm(rule(id)); return;
      case 'settings': settingsModal(); return;
      case 'save-settings': saveSettings(); return;
      case 'open':
        if (el.dataset.kind === 'recurring') occurrenceModal(id);
        else expenseForm(S.expenses.find((x) => x.id === id));
        return;
      case 'emo': F.emoji = v; $('#emoPick')!.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); return;
      case 'color': F.color = v; $('#colorPick')!.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); return;
      case 'split-mode': F.split!.mode = v as 'equal' | 'shares' | 'exact'; refreshSplit(); return;
      case 'split-who': {
        const parts = F.split!.participants;
        const i = parts.indexOf(id);
        if (i >= 0) { if (parts.length > 1) parts.splice(i, 1); }
        else parts.push(id);
        refreshSplit(); return;
      }
      case 'rule-active': F.active = v === '1'; el.parentElement!.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); return;
      case 'occ-skip': F.skip = v === '1'; el.parentElement!.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); return;
      case 'exp-planned': {
        F.planned = v === '1';
        el.parentElement!.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
        const dl = $('#dateLbl'); if (dl) dl.textContent = F.planned ? 'Due' : 'Date';
        const al = $('#accLbl'); if (al) al.textContent = F.planned ? "Who'll pay" : 'Paid from';
        return;
      }
      case 'mark-paid': {
        const exp = S.expenses.find((x) => x.id === id);
        if (!exp) return;
        exp.planned = false;
        /* you can't have paid it on a date that hasn't happened — a booking due
           next month, paid today, belongs to today */
        const moved = exp.date > todayISO();
        if (moved) exp.date = todayISO();
        if (activeLedger()!.kind !== 'trip' && monthOf(exp.date) !== UI.month) UI.month = monthOf(exp.date);
        commit(); toast(moved ? 'Paid — dated today' : 'Paid 🎉'); return;
      }
      case 'save-exp': saveExpense(id || undefined); return;
      case 'del-exp':
        if (confirm('Delete this expense?')) { S.expenses = S.expenses.filter((x) => x.id !== id); closeModal(); commit(); }
        return;
      case 'save-rule': saveRule(id || undefined); return;
      case 'del-rule':
        if (confirm('Delete this bill from every month?')) {
          S.rules = S.rules.filter((x) => x.id !== id);
          S.overrides = S.overrides.filter((o) => o.ruleId !== id);
          closeModal(); commit();
        }
        return;
      case 'save-occ': saveOccurrence(id); return;
      case 'reset-occ': {
        const [rid, per] = id.split('|');
        S.overrides = S.overrides.filter((o) => !(o.ruleId === rid && o.period === per));
        closeModal(); commit(); return;
      }
      case 'settle': settleModal(); return;
      case 'do-settle': doSettle(el.dataset.from!, el.dataset.to!, el.dataset.c!); return;
      case 'new-settle':
        settlementForm(null, {
          from: el.dataset.from, to: el.dataset.to,
          amount: el.dataset.c ? fromCents(Number(el.dataset.c)) : null, method: F.method,
        });
        return;
      case 'pay-method': {
        F.method = v;
        $('#payPick')!.querySelectorAll('button').forEach((b) => {
          const on = b.dataset.v === v;
          b.classList.toggle('on', on);
          const t = b.querySelector('.tick');
          if (t) t.textContent = on ? '✓' : '';
        });
        return;
      }
      case 'open-settle': settlementForm(S.settlements.find((x) => x.id === id)); return;
      case 'save-settle': saveSettlement(id || undefined); return;
      case 'del-settle':
        if (confirm('Delete this repayment? The amount goes back on the tally.')) {
          S.settlements = S.settlements.filter((x) => x.id !== id);
          closeModal(); commit();
        }
        return;
      case 'swap-settle': {
        const f = $('#sFrom') as HTMLSelectElement, t = $('#sTo') as HTMLSelectElement;
        const val = f.value; f.value = t.value; t.value = val; return;
      }
      case 'new-person': personForm(); return;
      case 'edit-person': personForm(person(id)); return;
      case 'save-person': savePerson(id || undefined); return;
      case 'del-person':
        if (confirm('Remove this person? Their past entries stay but stop counting.')) {
          S.people = S.people.filter((x) => x.id !== id);
          S.accounts = S.accounts.filter((a) => !(a.kind === 'personal' && a.ownership[id]));
          S.accounts.forEach((a) => { delete a.ownership[id]; });
          closeModal(); commit(); settingsModal();
        }
        return;
      case 'new-account': accountForm(); return;
      case 'edit-account': accountForm(account(id)); return;
      case 'acc-kind': F.kind = v; el.parentElement!.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); return;
      case 'save-account': saveAccount(id || undefined); return;
      case 'del-account':
        if (S.expenses.some((x) => x.accountId === id) || S.rules.some((x) => x.accountId === id)) { toast('Still used by some expenses'); return; }
        S.accounts = S.accounts.filter((a) => a.id !== id);
        closeModal(); commit(); settingsModal(); return;
      case 'add-cur': {
        const c = ($('#sNewCur') as HTMLInputElement).value.trim().toUpperCase();
        if (c.length === 3) {
          if (!S.settings.rates[c]) S.settings.rates[c] = DEFAULT_RATES[c] || 1;
          if (!S.settings.currencies.includes(c)) S.settings.currencies.push(c);
          save(); closeModal(); settingsModal();
        }
        return;
      }
      case 'theme':
        S.settings.theme = v; applyTheme(v); save();
        $('#themePick')!.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
        return;
      case 'fetch-rates': void fetchRates(); return;
      case 'export': exportJSON(); return;
      case 'export-csv': exportCSV(); return;
      case 'import': ($('#importFile') as HTMLInputElement).click(); return;
      case 'reset':
        if (confirm('Erase everything and start over?')) {
          setState(blankState());
          UI.ledgerId = null; UI.month = thisMonth(); UI.scope = 'month';
          closeModal(); commit();
        }
        return;
      case 'ob-go': onboard(); return;
    }
  });

  document.addEventListener('input', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLInputElement>('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'split-val') F.split!.values[el.dataset.id!] = el.value;
    if (el.dataset.act === 'own') F.own![el.dataset.id!] = Number(el.value) || 0;
    if (el.dataset.act === 'rate') {
      const v = Number(String(el.value).replace(',', '.'));
      if (v > 0) { S.settings.rates[el.dataset.id!] = v; save(); }
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'importFile' && t.files && t.files[0]) importJSONFile(t.files[0]);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key !== 'Enter') return;
    const id = (e.target as HTMLElement).id;
    if (id === 'authEmail') { e.preventDefault(); void sendCode(); }
    if (id === 'authCode') { e.preventDefault(); void submitCode(); }
  });
}
