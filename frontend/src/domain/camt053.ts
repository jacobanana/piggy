/**
 * camt.053 (ISO 20022 bank statement) reading — entirely on this device.
 *
 * A bank statement is about the most sensitive file a reader will ever hand
 * this app, so the importer's one security property is structural: the file
 * is parsed *here*, in the page, and nothing of it is ever sent anywhere or
 * kept — only the expenses the reader explicitly ticks become book data.
 *
 * The XML reader below is deliberately hand-rolled rather than DOMParser:
 *  - it lives in domain/ (no DOM), so Vitest exercises it directly;
 *  - it refuses `<!DOCTYPE` and every other `<!` declaration outright, which
 *    makes XXE and entity-expansion attacks impossible by construction —
 *    there is no entity table to poison. Only the five built-in entities and
 *    numeric character references are decoded;
 *  - depth and node counts are capped, so a hostile file costs bounded work.
 * Bank statements never carry a DTD, so nothing legitimate is refused.
 */
import type { ISODate, PaymentMethod } from '../model/types';

/* ---------- a strict, tiny XML tree ---------- */

export interface XmlEl {
  /** Local name — any namespace prefix is stripped. */
  name: string;
  attrs: Record<string, string>;
  children: XmlEl[];
  /** Own text content (direct text + CDATA, concatenated). */
  text: string;
}

const MAX_DEPTH = 64;
const MAX_NODES = 300_000;

const fail = (msg: string): never => { throw new Error(msg); };

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>;

/** The five XML entities and numeric refs, nothing else — no DTD, no custom entities. */
function decodeText(s: string): string {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const a = s.indexOf('&', i);
    if (a < 0) { out += s.slice(i); break; }
    out += s.slice(i, a);
    const sc = s.indexOf(';', a + 1);
    if (sc < 0 || sc - a > 9) fail('Stray & — not well-formed XML');
    const body = s.slice(a + 1, sc);
    if (/^#(x[0-9a-fA-F]{1,6}|\d{1,7})$/.test(body)) {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0x10ffff))) fail('Bad character reference');
      out += String.fromCodePoint(code);
    } else {
      const named = NAMED[body];
      if (!named) fail('Unknown entity &' + body + ';');
      out += named;
    }
    i = sc + 1;
  }
  return out;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9._:-]*$/;
const localName = (raw: string): string => {
  if (!NAME_RE.test(raw)) fail('Malformed tag name');
  const i = raw.indexOf(':');
  return i >= 0 ? raw.slice(i + 1) : raw;
};

/** Parse an XML document into a tree. Throws on anything out of shape. */
export function parseXml(src: string): XmlEl {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const doc: XmlEl = { name: '#doc', attrs: {}, children: [], text: '' };
  const stack: XmlEl[] = [doc];
  let i = 0;
  let nodes = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      if (stack.length > 1) fail('Unexpected end of file');
      if (src.slice(i).trim()) fail('Text outside the root element');
      break;
    }
    if (lt > i) {
      const text = src.slice(i, lt);
      if (stack.length === 1) { if (text.trim()) fail('Text outside the root element'); }
      else stack[stack.length - 1].text += decodeText(text);
    }
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt);
      if (e < 0) fail('Unterminated processing instruction');
      i = e + 2; continue;
    }
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      if (e < 0) fail('Unterminated comment');
      i = e + 3; continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      if (e < 0) fail('Unterminated CDATA section');
      if (stack.length > 1) stack[stack.length - 1].text += src.slice(lt + 9, e);
      i = e + 3; continue;
    }
    // The security refusal: <!DOCTYPE and friends mean entity definitions.
    if (src.startsWith('<!', lt)) fail('This file carries a DTD or declaration, which a bank statement never does — refusing to read it.');
    if (src.startsWith('</', lt)) {
      const e = src.indexOf('>', lt);
      if (e < 0) fail('Unterminated close tag');
      const name = localName(src.slice(lt + 2, e).trim());
      const el = stack.pop();
      if (!el || el.name === '#doc' || el.name !== name) fail('Mismatched close tag </' + name + '>');
      i = e + 1; continue;
    }
    // An open (or self-closing) tag.
    const e = src.indexOf('>', lt);
    if (e < 0) fail('Unterminated tag');
    let body = src.slice(lt + 1, e);
    const selfClose = body.endsWith('/');
    if (selfClose) body = body.slice(0, -1);
    const sp = body.search(/[\s]/);
    const el: XmlEl = {
      name: localName((sp < 0 ? body : body.slice(0, sp)).trim()),
      attrs: sp < 0 ? {} : parseAttrs(body.slice(sp)),
      children: [], text: '',
    };
    if (++nodes > MAX_NODES) fail('File has too many elements');
    if (stack.length === 1 && doc.children.length) fail('More than one root element');
    if (stack.length > MAX_DEPTH) fail('File is nested too deeply');
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
    i = e + 1;
  }
  if (stack.length > 1) fail('Unclosed element <' + stack[stack.length - 1].name + '>');
  if (!doc.children.length) fail('Empty file');
  return doc.children[0];
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\s+([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  let seen = 0;
  while ((m = re.exec(s))) {
    out[localName(m[1])] = decodeText(m[3] ?? m[4] ?? '');
    seen = m.index + m[0].length;
  }
  if (s.slice(seen).trim()) fail('Malformed attributes');
  return out;
}

/* ---------- walking helpers ---------- */

const kid = (el: XmlEl | undefined, name: string): XmlEl | undefined =>
  el?.children.find((c) => c.name === name);
const kids = (el: XmlEl | undefined, name: string): XmlEl[] =>
  el ? el.children.filter((c) => c.name === name) : [];
const walk = (el: XmlEl | undefined, ...path: string[]): XmlEl | undefined =>
  path.reduce<XmlEl | undefined>((e, name) => kid(e, name), el);
const textOf = (el: XmlEl | undefined, ...path: string[]): string =>
  (walk(el, ...path)?.text || '').trim();

/* ---------- what comes out ---------- */

/** One booked movement of money, as flat data. */
export interface CamtTx {
  date: ISODate;
  /** Always positive; direction is `debit`. */
  amountCents: number;
  currency: string;
  /** true = money out (an expense candidate), false = money in. */
  debit: boolean;
  reversal: boolean;
  pending: boolean;
  /** The other side's name, when the statement gives one. */
  party: string;
  /** Unstructured remittance / additional info — reference lines. */
  info: string;
  method: PaymentMethod;
}

export interface CamtStatement {
  /** Masked account identification — never the full IBAN. */
  account: string;
  currency: string;
  from: ISODate | '';
  to: ISODate | '';
  txs: CamtTx[];
}

/** CH12 3456 … 7890 — enough to recognise the account, never the whole of it. */
export function maskAccount(id: string): string {
  const flat = id.replace(/\s+/g, '');
  if (flat.length <= 8) return flat;
  return flat.slice(0, 4) + ' ' + flat.slice(4, 8) + ' … ' + flat.slice(-4);
}

/** "1234.56" → 123456, done as string maths so no float ever touches money. */
export function amountToCents(s: string): number {
  const m = /^(\d{1,12})(?:\.(\d{1,5}))?$/.exec(s.trim());
  if (!m) fail('Unreadable amount "' + s + '"');
  const frac = ((m![2] || '') + '000').slice(0, 3);
  return Number(m![1]) * 100 + Math.round(Number(frac) / 10);
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
const dateOf = (el: XmlEl | undefined): string => {
  const raw = textOf(el, 'Dt') || textOf(el, 'DtTm');
  const m = DATE_RE.exec(raw);
  return m ? m[1] : '';
};

/**
 * ISO 20022 bank transaction codes → Piggy's payment methods.
 * Family/sub-family codes, so it holds across banks and languages.
 */
function methodOf(btc: XmlEl | undefined): PaymentMethod {
  const fam = textOf(btc, 'Domn', 'Fmly', 'Cd');
  const sub = textOf(btc, 'Domn', 'Fmly', 'SubFmlyCd');
  if (fam === 'IDDT' || fam === 'RDDT' || sub.endsWith('DD') || sub === 'PMDD') return 'direct-debit';
  if (fam === 'CCRD' || fam === 'MCRD' || sub === 'POSD' || sub === 'POSP' || sub === 'CDPT') return 'card';
  if (sub === 'CWDL') return 'cash';
  if (fam === 'ICDT' || fam === 'RCDT') return 'transfer';
  return 'other';
}

/** The counterparty of a movement: creditor when money left, debtor when it came in. */
function partyOf(txd: XmlEl | undefined, debit: boolean): string {
  const p = walk(txd, 'RltdPties', debit ? 'Cdtr' : 'Dbtr');
  // camt.053.001.08 wraps the name in <Pty>; .001.02 has it directly.
  return textOf(p, 'Nm') || textOf(p, 'Pty', 'Nm');
}

function infoOf(txd: XmlEl | undefined, ntry: XmlEl): string {
  const ustrd = kids(walk(txd, 'RmtInf'), 'Ustrd').map((u) => u.text.trim()).filter(Boolean);
  return (ustrd.join(' ') || textOf(txd, 'AddtlTxInf') || textOf(ntry, 'AddtlNtryInf')).slice(0, 200);
}

const MAX_TXS = 5000;

/**
 * Read a camt.053 file (camt.052 reports and camt.054 notifications share the
 * entry shape and are accepted too). Throws a readable message on anything
 * that isn't one.
 */
export function parseCamt053(src: string): CamtStatement[] {
  const root = parseXml(src);
  if (root.name !== 'Document') fail('Not an ISO 20022 bank file (no <Document> root)');
  const container = kid(root, 'BkToCstmrStmt') || kid(root, 'BkToCstmrAcctRpt') || kid(root, 'BkToCstmrDbtCdtNtfctn');
  if (!container) fail("Not a camt.053 statement — export 'ISO 20022 camt.053' from your e-banking");
  const stmts = [...kids(container, 'Stmt'), ...kids(container, 'Rpt'), ...kids(container, 'Ntfctn')];
  if (!stmts.length) fail('The file has no statement in it');

  let total = 0;
  return stmts.map((st) => {
    const acct = walk(st, 'Acct');
    const account = maskAccount(textOf(acct, 'Id', 'IBAN') || textOf(acct, 'Id', 'Othr', 'Id'));
    const currency = textOf(acct, 'Ccy');
    const period = walk(st, 'FrToDt');
    const txs: CamtTx[] = [];
    kids(st, 'Ntry').forEach((ntry) => {
      if ((total += 1) > MAX_TXS) fail('Statement has too many entries');
      const debit = textOf(ntry, 'CdtDbtInd') === 'DBIT';
      const date = dateOf(kid(ntry, 'BookgDt')) || dateOf(kid(ntry, 'ValDt'));
      if (!date) return; // an entry the bank didn't date is not importable
      const sts = textOf(ntry, 'Sts') || textOf(ntry, 'Sts', 'Cd');
      const pending = !!sts && sts !== 'BOOK';
      const reversal = textOf(ntry, 'RvslInd') === 'true';
      const details = kids(kid(ntry, 'NtryDtls'), 'TxDtls');
      const base = {
        date, pending, reversal,
        currency: (kid(ntry, 'Amt')?.attrs.Ccy || currency || '').toUpperCase(),
      };
      /* A batch booking (one entry, several card payments inside) is split
         into its transactions when each carries its own amount; otherwise
         the entry is one movement. */
      const own = details.filter((d) => textOf(d, 'AmtDtls', 'TxAmt', 'Amt') || textOf(d, 'Amt'));
      if (details.length > 1 && own.length === details.length) {
        own.forEach((d) => {
          const amtEl = walk(d, 'AmtDtls', 'TxAmt', 'Amt') || kid(d, 'Amt');
          const dDebit = (textOf(d, 'CdtDbtInd') || (debit ? 'DBIT' : 'CRDT')) === 'DBIT';
          txs.push({
            ...base,
            currency: (amtEl?.attrs.Ccy || base.currency).toUpperCase(),
            amountCents: amountToCents(amtEl?.text.trim() || '0'),
            debit: dDebit,
            party: partyOf(d, dDebit),
            info: infoOf(d, ntry),
            method: methodOf(kid(d, 'BkTxCd') || kid(ntry, 'BkTxCd')),
          });
        });
      } else {
        const d = details[0];
        txs.push({
          ...base,
          amountCents: amountToCents(textOf(ntry, 'Amt')),
          debit,
          party: partyOf(d, debit),
          info: infoOf(d, ntry),
          method: methodOf(kid(ntry, 'BkTxCd') || kid(d, 'BkTxCd')),
        });
      }
    });
    return {
      account, currency,
      from: DATE_RE.exec(textOf(period, 'FrDtTm'))?.[1] ?? '',
      to: DATE_RE.exec(textOf(period, 'ToDtTm'))?.[1] ?? '',
      txs,
    };
  });
}
