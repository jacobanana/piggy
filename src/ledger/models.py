"""The Piggy data model — the SQL side of frontend/src/model/types.ts.

One Book is one whole piggy bank (what the frontend calls its AppState):
its people, accounts, ledgers, rules, overrides, expenses and settlements.
Keep the two model files in lockstep.

Conventions:
- Entity ids are client-generated opaque strings (UUIDs from the frontend),
  so a book syncs to SQL without id remapping. Books and users use real UUIDs.
- Money is Numeric(12,2) + an ISO-4217 code; fx snapshots are Numeric(16,8).
- Enums are stored as VARCHAR with a CHECK constraint (native_enum=False):
  no ALTER TYPE migrations, and the same schema works on any backend.
- A Split is its own table so expenses, rules and overrides share one
  representation of "who is this for".
"""

import enum
from datetime import date as Date
from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import Column, Text, UniqueConstraint
from sqlalchemy import Enum as SAEnum
from sqlmodel import Field, SQLModel

from core.db import utc_datetime_field
from core.utils import utcnow

ID_LENGTH = 64  # client-generated opaque id
CURRENCY_LENGTH = 3
MONTH_LENGTH = 7  # "YYYY-MM"
ITEM_REF_LENGTH = ID_LENGTH + MONTH_LENGTH + 1  # an id, or "ruleId|YYYY-MM"


def varchar_enum(enum_cls: type[enum.Enum], **kwargs: Any) -> Any:
    """Enum column stored as VARCHAR + CHECK, never a native Postgres type."""
    return Field(
        sa_column=Column(
            SAEnum(enum_cls, native_enum=False, values_callable=lambda e: [m.value for m in e], length=20),
            nullable=kwargs.pop("nullable", False),
            index=kwargs.pop("index", False),
        ),
        **kwargs,
    )


class SplitMode(enum.StrEnum):
    equal = "equal"
    shares = "shares"
    exact = "exact"


class AccountKind(enum.StrEnum):
    personal = "personal"
    joint = "joint"


class LedgerKind(enum.StrEnum):
    household = "household"
    trip = "trip"


class Frequency(enum.StrEnum):
    monthly = "monthly"
    bimonthly = "bimonthly"
    quarterly = "quarterly"
    semiannual = "semiannual"
    yearly = "yearly"


class MemberRole(enum.StrEnum):
    owner = "owner"
    member = "member"


class Book(SQLModel, table=True):
    """One whole piggy bank — the unit a user syncs, exports and imports.

    A user can belong to several: the flat with the housemates, a trip with
    friends. Each carries its own people, accounts, lists and currencies.
    """

    __tablename__ = "books"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    name: str = Field(default="Piggy", max_length=255)
    theme: str = Field(default="blueberry", max_length=32)
    base_currency: str = Field(default="CHF", max_length=CURRENCY_LENGTH)
    last_pay_method: str | None = Field(default=None, max_length=20)
    rates_updated_at: datetime | None = utc_datetime_field(default=None)
    # Bumped on every accepted write. The client echoes the version it loaded
    # back as If-Match, which is what lets a stale PUT be merged rather than
    # allowed to overwrite somebody else's edits.
    version: int = Field(default=1)
    created_at: datetime = utc_datetime_field(default_factory=utcnow)
    updated_at: datetime = utc_datetime_field(default_factory=utcnow)


class BookMember(SQLModel, table=True):
    """Who can open a book, and who they are inside it.

    `person_id` links the account to a Person in the book's tally — Marc signs
    in and claims the "Marc" row rather than becoming a second Marc. It stays
    null for a member who hasn't claimed anyone yet.
    """

    __tablename__ = "book_members"

    book_id: UUID = Field(foreign_key="books.id", primary_key=True)
    user_id: UUID = Field(foreign_key="users.id", primary_key=True)
    role: MemberRole = varchar_enum(MemberRole, default=MemberRole.member)
    person_id: str | None = Field(default=None, max_length=ID_LENGTH)
    created_at: datetime = utc_datetime_field(default_factory=utcnow)


class BookInvite(SQLModel, table=True):
    """A shareable code that lets whoever holds it join one book.

    Deliberately multi-use until it expires or is revoked: the point is to
    paste one link into a group chat, not to mint one per friend.
    """

    __tablename__ = "book_invites"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    book_id: UUID = Field(foreign_key="books.id", index=True)
    code: str = Field(unique=True, index=True, max_length=32)
    created_by: UUID = Field(foreign_key="users.id")
    created_at: datetime = utc_datetime_field(default_factory=utcnow)
    expires_at: datetime = utc_datetime_field()
    revoked_at: datetime | None = utc_datetime_field(default=None)


class BookSnapshot(SQLModel, table=True):
    """The book's full wire state at one version.

    Kept so a PUT from a client that loaded version N can be three-way merged
    against version N rather than clobbering everything written since. Pruned
    to the most recent few per book; a client older than that gets a 409 and
    reloads.
    """

    __tablename__ = "book_snapshots"

    book_id: UUID = Field(foreign_key="books.id", primary_key=True)
    version: int = Field(primary_key=True)
    state: str = Field(sa_column=Column(Text, nullable=False))
    created_at: datetime = utc_datetime_field(default_factory=utcnow)


class CurrencyRate(SQLModel, table=True):
    """1 unit of `code` = `rate` units of the book's base currency."""

    __tablename__ = "currency_rates"

    book_id: UUID = Field(foreign_key="books.id", primary_key=True)
    code: str = Field(primary_key=True, max_length=CURRENCY_LENGTH)
    rate: Decimal = Field(max_digits=16, decimal_places=8)
    # Pinned codes are the book's quick-pick currency list in the UI.
    pinned: bool = Field(default=False)


class Person(SQLModel, table=True):
    __tablename__ = "people"

    id: str = Field(primary_key=True, max_length=ID_LENGTH)
    book_id: UUID = Field(foreign_key="books.id", index=True)
    name: str = Field(max_length=255)
    emoji: str = Field(max_length=16)
    color: str = Field(max_length=16)


class Account(SQLModel, table=True):
    __tablename__ = "accounts"

    id: str = Field(primary_key=True, max_length=ID_LENGTH)
    book_id: UUID = Field(foreign_key="books.id", index=True)
    name: str = Field(max_length=255)
    kind: AccountKind = varchar_enum(AccountKind)


class AccountOwnership(SQLModel, table=True):
    """Shares sum to 1 per account; paying credits owners in proportion."""

    __tablename__ = "account_ownership"

    account_id: str = Field(foreign_key="accounts.id", primary_key=True, max_length=ID_LENGTH)
    person_id: str = Field(foreign_key="people.id", primary_key=True, max_length=ID_LENGTH)
    share: Decimal = Field(max_digits=7, decimal_places=4)


class Ledger(SQLModel, table=True):
    __tablename__ = "ledgers"

    id: str = Field(primary_key=True, max_length=ID_LENGTH)
    book_id: UUID = Field(foreign_key="books.id", index=True)
    name: str = Field(max_length=255)
    emoji: str = Field(max_length=16)
    kind: LedgerKind = varchar_enum(LedgerKind)
    currency: str = Field(max_length=CURRENCY_LENGTH)
    start_date: Date | None = Field(default=None)
    end_date: Date | None = Field(default=None)
    archived: bool = Field(default=False)
    created_at: datetime = utc_datetime_field(default_factory=utcnow)


class Split(SQLModel, table=True):
    """How a cost divides between people; shared by expenses, rules, overrides."""

    __tablename__ = "splits"

    id: str = Field(primary_key=True, max_length=ID_LENGTH)
    mode: SplitMode = varchar_enum(SplitMode)


class SplitShare(SQLModel, table=True):
    """A participant in a split; `value` is a weight (shares) or an amount (exact)."""

    __tablename__ = "split_shares"

    split_id: str = Field(foreign_key="splits.id", primary_key=True, max_length=ID_LENGTH)
    person_id: str = Field(foreign_key="people.id", primary_key=True, max_length=ID_LENGTH)
    value: Decimal | None = Field(default=None, max_digits=12, decimal_places=2)


class Rule(SQLModel, table=True):
    """A recurring bill; occurrences are computed, never stored."""

    __tablename__ = "rules"

    id: str = Field(primary_key=True, max_length=ID_LENGTH)
    ledger_id: str = Field(foreign_key="ledgers.id", index=True, max_length=ID_LENGTH)
    name: str = Field(max_length=255)
    emoji: str = Field(max_length=16)
    amount: Decimal = Field(max_digits=12, decimal_places=2)
    currency: str = Field(max_length=CURRENCY_LENGTH)
    frequency: Frequency = varchar_enum(Frequency)
    due_day: int = Field(ge=1, le=31)
    start_month: str = Field(max_length=MONTH_LENGTH)
    end_month: str | None = Field(default=None, max_length=MONTH_LENGTH)
    account_id: str = Field(foreign_key="accounts.id", max_length=ID_LENGTH)
    method: str = Field(max_length=20)
    split_id: str = Field(foreign_key="splits.id", max_length=ID_LENGTH)
    active: bool = Field(default=True)
    notes: str = Field(default="", max_length=1000)
    created_at: datetime = utc_datetime_field(default_factory=utcnow)
    updated_at: datetime = utc_datetime_field(default_factory=utcnow)


class RuleOverride(SQLModel, table=True):
    """One month's deviation from a rule. Null fields fall through to the rule."""

    __tablename__ = "rule_overrides"
    __table_args__ = (UniqueConstraint("rule_id", "period", name="uq_rule_overrides_rule_period"),)

    id: str = Field(primary_key=True, max_length=ID_LENGTH)
    rule_id: str = Field(foreign_key="rules.id", index=True, max_length=ID_LENGTH)
    period: str = Field(max_length=MONTH_LENGTH)
    amount: Decimal | None = Field(default=None, max_digits=12, decimal_places=2)
    currency: str | None = Field(default=None, max_length=CURRENCY_LENGTH)
    account_id: str | None = Field(default=None, foreign_key="accounts.id", max_length=ID_LENGTH)
    date: Date | None = Field(default=None)
    split_id: str | None = Field(default=None, foreign_key="splits.id", max_length=ID_LENGTH)
    skipped: bool = Field(default=False)


class Expense(SQLModel, table=True):
    """A one-off expense. planned=True means booked but not yet paid."""

    __tablename__ = "expenses"

    id: str = Field(primary_key=True, max_length=ID_LENGTH)
    ledger_id: str = Field(foreign_key="ledgers.id", index=True, max_length=ID_LENGTH)
    name: str = Field(max_length=255)
    emoji: str = Field(max_length=16)
    amount: Decimal = Field(max_digits=12, decimal_places=2)
    currency: str = Field(max_length=CURRENCY_LENGTH)
    fx_rate: Decimal | None = Field(default=None, max_digits=16, decimal_places=8)
    date: Date = Field(index=True)
    account_id: str = Field(foreign_key="accounts.id", max_length=ID_LENGTH)
    method: str = Field(max_length=20)
    planned: bool = Field(default=False)
    split_id: str = Field(foreign_key="splits.id", max_length=ID_LENGTH)
    notes: str = Field(default="", max_length=1000)
    created_at: datetime = utc_datetime_field(default_factory=utcnow)
    updated_at: datetime = utc_datetime_field(default_factory=utcnow)


class Settlement(SQLModel, table=True):
    """Money one person actually handed the other."""

    __tablename__ = "settlements"

    id: str = Field(primary_key=True, max_length=ID_LENGTH)
    ledger_id: str = Field(foreign_key="ledgers.id", index=True, max_length=ID_LENGTH)
    date: Date = Field(index=True)
    from_person_id: str = Field(foreign_key="people.id", max_length=ID_LENGTH)
    to_person_id: str = Field(foreign_key="people.id", max_length=ID_LENGTH)
    amount: Decimal = Field(max_digits=12, decimal_places=2)
    currency: str = Field(max_length=CURRENCY_LENGTH)
    fx_rate: Decimal | None = Field(default=None, max_digits=16, decimal_places=8)
    method: str = Field(max_length=20)
    note: str = Field(default="", max_length=1000)
    created_at: datetime = utc_datetime_field(default_factory=utcnow)


class SettlementItem(SQLModel, table=True):
    """What a repayment was for — one row per item it was logged against.

    `item_id` is an expense id, or `ruleId|YYYY-MM` for one month of a
    recurring bill; occurrences are computed rather than stored, so this
    deliberately carries no foreign key. A record of intent only: the tally
    moves by the settlement's amount, which may be a part of what these come
    to, or more.
    """

    __tablename__ = "settlement_items"

    settlement_id: str = Field(foreign_key="settlements.id", primary_key=True, max_length=ID_LENGTH)
    item_id: str = Field(primary_key=True, max_length=ITEM_REF_LENGTH)
    # Kept so the picker hands them back in the order they were ticked.
    position: int = Field(default=0)
