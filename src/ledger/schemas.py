"""Wire format for a whole book — byte-for-byte the frontend's AppState.

Field names are camelCase on purpose: this is the JSON the Vite app already
stores in localStorage and exports, so GET /api/book hydrates the client with
no translation layer and PUT /api/book accepts an export unchanged.
"""

from pydantic import BaseModel, Field


class SplitState(BaseModel):
    mode: str = "equal"
    participants: list[str] = Field(default_factory=list)
    values: dict[str, float] = Field(default_factory=dict)


class MetaState(BaseModel):
    appName: str = "Piggy"
    createdAt: str | None = None
    updatedAt: str | None = None


class SettingsState(BaseModel):
    theme: str = "blueberry"
    baseCurrency: str = "CHF"
    currencies: list[str] = Field(default_factory=list)
    rates: dict[str, float] = Field(default_factory=dict)
    ratesUpdatedAt: str | None = None
    lastPayMethod: str | None = None


class PersonState(BaseModel):
    id: str
    name: str
    emoji: str = "🙂"
    color: str = "#5A67E8"


class AccountState(BaseModel):
    id: str
    name: str
    kind: str = "personal"
    ownership: dict[str, float] = Field(default_factory=dict)


class LedgerState(BaseModel):
    id: str
    name: str
    emoji: str = "📒"
    kind: str = "household"
    currency: str = "CHF"
    startDate: str | None = None
    endDate: str | None = None
    archived: bool = False
    createdAt: str | None = None


class RuleState(BaseModel):
    id: str
    ledgerId: str
    name: str
    emoji: str = "🏠"
    amount: float
    currency: str
    frequency: str = "monthly"
    dueDay: int = 1
    startMonth: str
    endMonth: str | None = None
    accountId: str
    method: str = "direct-debit"
    split: SplitState = Field(default_factory=SplitState)
    active: bool = True
    notes: str = ""
    createdAt: str | None = None


class RuleOverrideState(BaseModel):
    id: str
    ruleId: str
    period: str
    amount: float | None = None
    currency: str | None = None
    accountId: str | None = None
    date: str | None = None
    split: SplitState | None = None
    skipped: bool = False


class ExpenseState(BaseModel):
    id: str
    ledgerId: str
    name: str
    emoji: str = "🛒"
    amount: float
    currency: str
    fxRate: float | None = None
    date: str
    accountId: str
    method: str = "card"
    planned: bool = False
    split: SplitState = Field(default_factory=SplitState)
    notes: str = ""
    createdAt: str | None = None


class SettlementState(BaseModel):
    id: str
    ledgerId: str
    date: str
    fromPersonId: str
    toPersonId: str
    amount: float
    currency: str
    fxRate: float | None = None
    method: str = "cash"
    note: str = ""
    createdAt: str | None = None


class BookState(BaseModel):
    schemaVersion: int = 1
    meta: MetaState = Field(default_factory=MetaState)
    settings: SettingsState = Field(default_factory=SettingsState)
    people: list[PersonState] = Field(default_factory=list)
    accounts: list[AccountState] = Field(default_factory=list)
    ledgers: list[LedgerState] = Field(default_factory=list)
    rules: list[RuleState] = Field(default_factory=list)
    overrides: list[RuleOverrideState] = Field(default_factory=list)
    expenses: list[ExpenseState] = Field(default_factory=list)
    settlements: list[SettlementState] = Field(default_factory=list)
