/**
 * The Piggy data model.
 *
 * Flat and relational on purpose: every entity below maps 1:1 to a SQL table
 * in the FastAPI/SQLModel backend (see src/piggy/models in the repo root).
 * The GitHub Pages build persists this exact shape as JSON in localStorage;
 * the backend persists it in Postgres. Keep the two in lockstep.
 *
 *   people | accounts | ledgers | rules | rule_overrides | expenses | settlements
 *
 * Money is always a decimal amount + ISO-4217 currency code, converted to the
 * base currency through either a snapshotted fx rate (expenses/settlements,
 * so old months never change) or the live rate table (recurring rules).
 */

/** ISO-4217 code, e.g. "CHF". */
export type CurrencyCode = string;
/** "YYYY-MM-DD" */
export type ISODate = string;
/** "YYYY-MM" */
export type MonthKey = string;
/** ISO-8601 timestamp. */
export type Timestamp = string;

export type SplitMode = 'equal' | 'shares' | 'exact';

/**
 * How a cost is divided between people.
 * - equal:  evenly between `participants`
 * - shares: weighted by `values` (weights, not money)
 * - exact:  `values` are amounts in the item's currency
 * Backend equivalent: split_mode column + expense_shares rows.
 */
export interface Split {
  mode: SplitMode;
  /** Person ids taking part; empty/missing means everyone. */
  participants: string[];
  /** Per-person weight or exact amount, keyed by person id. */
  values: Record<string, number>;
}

export interface Person {
  id: string;
  name: string;
  emoji: string;
  /** Display colour, hex. */
  color: string;
}

export type AccountKind = 'personal' | 'joint';

/**
 * Where money comes from. Paying from an account credits its owners in
 * proportion to `ownership` (person id -> share, shares sum to 1).
 * Backend equivalent: accounts + account_ownership rows.
 */
export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  ownership: Record<string, number>;
}

export type LedgerKind = 'household' | 'trip';

/** A book of expenses: the monthly household or a one-off trip pot. */
export interface Ledger {
  id: string;
  name: string;
  emoji: string;
  kind: LedgerKind;
  currency: CurrencyCode;
  startDate?: ISODate | '';
  endDate?: ISODate | '';
  archived: boolean;
  createdAt: Timestamp;
}

export type Frequency = 'monthly' | 'bimonthly' | 'quarterly' | 'semiannual' | 'yearly';

export type PaymentMethod = 'card' | 'direct-debit' | 'transfer' | 'cash' | 'twint' | 'other';

/** A recurring bill: rent, Netflix, quarterly water. Generates occurrences. */
export interface Rule {
  id: string;
  ledgerId: string;
  name: string;
  emoji: string;
  amount: number;
  currency: CurrencyCode;
  frequency: Frequency;
  /** Day of month the bill lands (clamped to the month's length). */
  dueDay: number;
  startMonth: MonthKey;
  endMonth: MonthKey | null;
  accountId: string;
  method: PaymentMethod;
  split: Split;
  active: boolean;
  notes: string;
  createdAt: Timestamp;
}

/** One month's deviation from a rule: different amount, date, account, or skipped. */
export interface RuleOverride {
  id: string;
  ruleId: string;
  period: MonthKey;
  amount?: number;
  currency?: CurrencyCode;
  accountId?: string;
  date?: ISODate;
  split?: Split;
  skipped?: boolean;
}

/** A one-off expense. `planned` = booked but not yet paid (stays off the tally). */
export interface Expense {
  id: string;
  ledgerId: string;
  name: string;
  emoji: string;
  amount: number;
  currency: CurrencyCode;
  /** Rate to base currency snapshotted at entry, so history never drifts. */
  fxRate: number | null;
  date: ISODate;
  accountId: string;
  method: PaymentMethod;
  planned: boolean;
  split: Split;
  notes: string;
  createdAt: Timestamp;
}

/** Money one person actually handed the other — cancels against the tally. */
export interface Settlement {
  id: string;
  ledgerId: string;
  date: ISODate;
  fromPersonId: string;
  toPersonId: string;
  amount: number;
  currency: CurrencyCode;
  fxRate: number | null;
  method: string;
  note: string;
  /**
   * What the repayment was for: expense ids, or `ruleId|YYYY-MM` for one
   * month of a recurring bill. A record of intent only — the tally moves by
   * `amount`, which may be less or more than those items add up to.
   * Backend equivalent: settlement_items rows.
   */
  itemIds?: string[];
  createdAt: Timestamp;
}

export interface Settings {
  theme: string;
  baseCurrency: CurrencyCode;
  currencies: CurrencyCode[];
  /** 1 unit of `code` = rates[code] units of base currency. */
  rates: Record<CurrencyCode, number>;
  ratesUpdatedAt: Timestamp | null;
  lastPayMethod?: string;
}

export interface Meta {
  appName: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** The whole book — what gets exported, imported and persisted. */
export interface AppState {
  schemaVersion: number;
  meta: Meta;
  settings: Settings;
  people: Person[];
  accounts: Account[];
  ledgers: Ledger[];
  rules: Rule[];
  overrides: RuleOverride[];
  expenses: Expense[];
  settlements: Settlement[];
}

/**
 * A rule materialised for one month, unified with ad-hoc expenses for
 * rendering and balance maths. Never persisted.
 */
export interface Occurrence {
  kind: 'recurring';
  id: string; // `${ruleId}|${period}`
  ruleId: string;
  period: MonthKey;
  ledgerId: string;
  date: ISODate;
  name: string;
  emoji: string;
  amount: number;
  currency: CurrencyCode;
  fxRate: null;
  accountId: string;
  method: PaymentMethod;
  split: Split;
  frequency: Frequency;
  skipped: boolean;
  notes: string;
}

export type LedgerItem =
  | Occurrence
  | (Expense & { kind: 'adhoc' });
