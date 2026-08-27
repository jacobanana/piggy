/**
 * Turning a bank statement's raw movements into something a book understands:
 * which payments are the same thing happening again (rent, Netflix, the
 * quarterly water bill), which are a habit without a rhythm (the supermarket),
 * and which happened once.
 *
 * Pure data-in data-out, like everything in domain/ — the statement never
 * leaves the caller's hands.
 */
import type { CamtTx } from './camt053';
import type { Frequency, PaymentMethod } from '../model/types';

export type GroupKind = 'recurring' | 'frequent' | 'one-off';

export interface TxGroup {
  key: string;
  /** What to call the expense(s) — the counterparty, cleaned up. */
  label: string;
  emoji: string;
  kind: GroupKind;
  /** Set when kind is 'recurring' — the cadence the dates actually keep. */
  frequency: Frequency | null;
  /** Median day of month the payment lands. */
  dueDay: number;
  /** Median amount — the figure a recurring bill would be created with. */
  amountCents: number;
  /** Amounts move around (electricity), as opposed to a fixed subscription. */
  variable: boolean;
  method: PaymentMethod;
  /** Oldest first. */
  txs: CamtTx[];
}

/* ---------- naming ---------- */

/** Words that say how it was paid, not what it was — every bank stamps some on. */
const NOISE = new Set([
  'PAYMENT', 'PAIEMENT', 'ZAHLUNG', 'PAGAMENTO', 'ACHAT', 'KAUF', 'EINKAUF', 'PURCHASE',
  'CARD', 'KARTE', 'CARTE', 'DEBIT', 'CREDIT', 'TWINT', 'MAESTRO', 'VISA', 'MASTERCARD',
  'ORDER', 'AUFTRAG', 'ORDRE', 'TRANSFER', 'VIREMENT', 'UEBERWEISUNG', 'STANDING',
  'DAUERAUFTRAG', 'LSV', 'DD', 'REF', 'NR', 'NO', 'THE',
]);

/**
 * The stable part of a movement's wording: letters only, noise words and
 * reference numbers dropped, anchored on the first distinctive word so the
 * branch doesn't split the brand. "MIGROS M LAUSANNE" and "MIGROS M RENENS"
 * are one habit; "COOP-4231 KARTE 21.03" and "COOP-1077 KARTE 04.04" are one
 * merchant. Short leading words ("LA POSTE") keep a second word to mean
 * anything.
 */
export function groupKey(tx: CamtTx): string {
  const raw = (tx.party || tx.info).toUpperCase();
  const words = raw.replace(/[^A-ZÀ-ÖØ-Þ]+/g, ' ').split(' ')
    .filter((w) => w.length >= 2 && !NOISE.has(w));
  if (!words.length) return '';
  return words[0].length >= 4 ? words[0] : words.slice(0, 2).join(' ');
}

const mostCommon = <T>(xs: T[]): T => {
  const counts = new Map<T, number>();
  xs.forEach((x) => counts.set(x, (counts.get(x) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

/** A tidy display name: the counterparty as usually written, else the reference line. */
function labelOf(txs: CamtTx[]): string {
  const named = txs.map((t) => t.party.trim()).filter(Boolean);
  const src = named.length ? mostCommon(named) : (txs[0].info.trim() || 'Payment');
  return src.length > 40 ? src.slice(0, 40).trimEnd() + '…' : src;
}

/* ---------- emoji suggestion ---------- */

const EMOJI_HINTS: [RegExp, string][] = [
  [/\b(MIGROS|COOP|ALDI|LIDL|DENNER|VOLG|SPAR|CARREFOUR|TESCO|EDEKA|REWE|MONOPRIX|SUPERMARC|SUPERMARK|GROCER)/, '🛒'],
  [/\b(SBB|CFF|FFS|BAHN|RAILWAY|TRAIN|BUS|TRAM|METRO|UBER(?!\s*EATS)|TAXI|PARKING|PARKHAUS|MOBILITY)/, '🚆'],
  [/\b(SWISSCOM|SUNRISE|SALT|WINGO|YALLO|TELEKOM|TELECOM|VODAFONE|ORANGE|MOBILE|INTERNET)/, '🌐'],
  [/\b(NETFLIX|SPOTIFY|DISNEY|YOUTUBE|ITUNES|APPLE\.?COM|PRIME|CANAL|HBO|DEEZER|AUDIBLE|STEAM|PLAYSTATION|PATREON)/, '📺'],
  [/\b(ASSUR|INSURANCE|VERSICHER|CSS|HELSANA|SWICA|SANITAS|CONCORDIA|AXA|ALLIANZ|GENERALI|MOBILIAR|VAUDOISE)/, '🛡️'],
  [/\b(PHARM|APOTHEKE|DROGERIE|MEDIC|DENTIST|ZAHN|ARZT|DOCTEUR|DOCTOR|HOSPITAL|HOPITAL|SPITAL|CLINIQUE|KLINIK)/, '💊'],
  [/\b(RESTAURANT|PIZZERIA|CAFE|KAFFEE|BISTRO|MCDONALD|BURGER|KEBAB|SUSHI|TAKEAWAY|EAT\.?CH|UBEREATS|JUSTEAT|SMOOD)/, '🍜'],
  [/\b(MIETE|LOYER|RENT|IMMOBILIEN|REGIE|WINCASA|LIVIT|GERANCE|HYPOTHEK|MORTGAGE)/, '🏠'],
  [/\b(ELECTRIC|STROM|ENERGIE|ENERGY|EWZ|BKW|ROMANDE|GAZ|GAS|WASSER|WATER|EAU|CHAUFFAGE)/, '💡'],
  [/\b(HOTEL|AIRBNB|BOOKING|HOSTEL|AUBERGE)/, '🏨'],
  [/\b(EASYJET|RYANAIR|LUFTHANSA|AIRLINE|AIRWAYS|FLIGHT|AEROPORT|AIRPORT|FLUGHAFEN)/, '✈️'],
  [/\b(GALAXUS|DIGITEC|AMAZON|ZALANDO|IKEA|CONFORAMA|BRICO|HORNBACH|OBI|JUMBO)/, '📦'],
  [/\b(ESSO|SHELL|AVIA|AGROLA|SOCAR|TAMOIL|TANKSTELLE|STATION.?SERVICE|FUEL|GARAGE)/, '⛽'],
  [/\b(FITNESS|GYM|SPORT|PISCINE|CINEMA|KINO|THEATER|CONCERT|TICKETCORNER)/, '🎉'],
  [/\b(STEUER|IMPOT|IMPOTS|TAX|GEMEINDE|COMMUNE|CANTON|SERAFE|BILLAG)/, '🧾'],
];

export function suggestEmoji(text: string, recurring: boolean): string {
  const up = ' ' + text.toUpperCase() + ' ';
  for (const [re, emoji] of EMOJI_HINTS) if (re.test(up)) return emoji;
  return recurring ? '🔁' : '📦';
}

/* ---------- cadence ---------- */

const DAY_MS = 86_400_000;
const dayNum = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

/** How many days apart each cadence lands, with room for bank-day drift. */
const CADENCES: [Frequency, number, number][] = [
  ['monthly', 25, 36],
  ['bimonthly', 53, 70],
  ['quarterly', 82, 101],
  ['semiannual', 170, 197],
  ['yearly', 350, 381],
];

const median = (ns: number[]): number => {
  const s = [...ns].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

/**
 * The rhythm a set of dates keeps, if it keeps one. Three payments (two gaps)
 * are the least that can be called a pattern; every gap has to fit the same
 * cadence band, so one skipped month breaks it — better to under-claim than
 * to invent a bill.
 */
export function detectFrequency(dates: string[]): Frequency | null {
  if (dates.length < 3) return null;
  const days = dates.map(dayNum).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);
  const m = median(gaps);
  const hit = CADENCES.find(([, lo, hi]) => m >= lo && m <= hi);
  if (!hit) return null;
  return gaps.every((g) => g >= hit[1] && g <= hit[2]) ? hit[0] : null;
}

/* ---------- the classifier ---------- */

/**
 * Group a statement's payments-out and say what each group is. Groups come
 * back recurring first, then frequent, then one-offs newest first — the order
 * the review screen reads them in.
 */
export function classify(txs: CamtTx[]): TxGroup[] {
  const byKey = new Map<string, CamtTx[]>();
  txs.forEach((tx, i) => {
    // An unnameable movement can't be matched to anything: it stands alone.
    const key = groupKey(tx) || '#' + i;
    const list = byKey.get(key);
    if (list) list.push(tx); else byKey.set(key, [tx]);
  });

  const groups = [...byKey.entries()].map(([key, list]): TxGroup => {
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    // A same-day pair (a batch booking split in two) is one event, not a rhythm.
    const dates = [...new Set(list.map((t) => t.date))];
    const frequency = detectFrequency(dates);
    const amounts = list.map((t) => t.amountCents);
    const mid = median(amounts);
    const spread = mid > 0 ? (Math.max(...amounts) - Math.min(...amounts)) / mid : 0;
    const kind: GroupKind = frequency ? 'recurring' : dates.length >= 4 ? 'frequent' : 'one-off';
    const label = labelOf(list);
    return {
      key, label, kind, frequency,
      emoji: suggestEmoji(label + ' ' + list[0].info, kind === 'recurring'),
      dueDay: median(list.map((t) => Number(t.date.slice(8)))),
      amountCents: mid,
      variable: spread > 0.1,
      method: mostCommon(list.map((t) => t.method)),
      txs: list,
    };
  });

  const rank: Record<GroupKind, number> = { recurring: 0, frequent: 1, 'one-off': 2 };
  return groups.sort((a, b) =>
    rank[a.kind] - rank[b.kind]
    || b.txs.length - a.txs.length
    || (a.txs[a.txs.length - 1].date < b.txs[b.txs.length - 1].date ? 1 : -1));
}
