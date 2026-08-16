"""Load a book into its wire state, and replace it from one.

The sync model is deliberately whole-book: the client is localStorage-first
and a book is small, so GET hands back everything and PUT replaces
everything in one transaction. Finer-grained CRUD can grow beside this
without changing the schema.
"""

from datetime import date, datetime
from decimal import Decimal
from uuid import uuid4

from sqlmodel import Session, col, delete, select

from core.utils import utcnow
from identity.models import User
from ledger.models import (
    Account,
    AccountKind,
    AccountOwnership,
    Book,
    BookMember,
    CurrencyRate,
    Expense,
    Frequency,
    Ledger,
    LedgerKind,
    Person,
    Rule,
    RuleOverride,
    Settlement,
    Split,
    SplitMode,
    SplitShare,
)
from ledger.schemas import (
    AccountState,
    BookState,
    ExpenseState,
    LedgerState,
    MetaState,
    PersonState,
    RuleOverrideState,
    RuleState,
    SettingsState,
    SettlementState,
    SplitState,
)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _date_str(d: date | None) -> str | None:
    return d.isoformat() if d else None


def _parse_date(s: str | None) -> date | None:
    return date.fromisoformat(s) if s else None


def _dec(v: float | None) -> Decimal | None:
    return None if v is None else Decimal(str(v))


def get_book_for_user(session: Session, user: User) -> Book | None:
    membership = session.exec(select(BookMember).where(BookMember.user_id == user.id)).first()
    return session.get(Book, membership.book_id) if membership else None


def ensure_book_for_user(session: Session, user: User) -> Book:
    book = get_book_for_user(session, user)
    if book:
        return book
    book = Book(id=uuid4())
    session.add(book)
    session.add(BookMember(book_id=book.id, user_id=user.id))
    session.commit()
    session.refresh(book)
    return book


# --------------------------------------------------------------------------
# Book -> BookState
# --------------------------------------------------------------------------


def _split_state(session: Session, split_id: str | None) -> SplitState | None:
    if split_id is None:
        return None
    split = session.get(Split, split_id)
    if split is None:
        return None
    shares = session.exec(select(SplitShare).where(SplitShare.split_id == split_id)).all()
    return SplitState(
        mode=split.mode.value,
        participants=[s.person_id for s in shares],
        values={s.person_id: float(s.value) for s in shares if s.value is not None},
    )


def book_to_state(session: Session, book: Book) -> BookState:
    people = session.exec(select(Person).where(Person.book_id == book.id)).all()
    accounts = session.exec(select(Account).where(Account.book_id == book.id)).all()
    ledgers = session.exec(select(Ledger).where(Ledger.book_id == book.id)).all()
    ledger_ids = [ledger.id for ledger in ledgers]
    rates = session.exec(select(CurrencyRate).where(CurrencyRate.book_id == book.id)).all()

    ownership: dict[str, dict[str, float]] = {a.id: {} for a in accounts}
    for own in session.exec(
        select(AccountOwnership).where(col(AccountOwnership.account_id).in_(list(ownership)))
    ).all():
        ownership[own.account_id][own.person_id] = float(own.share)

    rules = session.exec(select(Rule).where(col(Rule.ledger_id).in_(ledger_ids))).all() if ledger_ids else []
    rule_ids = [r.id for r in rules]
    overrides = (
        session.exec(select(RuleOverride).where(col(RuleOverride.rule_id).in_(rule_ids))).all() if rule_ids else []
    )
    expenses = session.exec(select(Expense).where(col(Expense.ledger_id).in_(ledger_ids))).all() if ledger_ids else []
    settlements = (
        session.exec(select(Settlement).where(col(Settlement.ledger_id).in_(ledger_ids))).all() if ledger_ids else []
    )

    return BookState(
        meta=MetaState(appName=book.name, createdAt=_iso(book.created_at), updatedAt=_iso(book.updated_at)),
        settings=SettingsState(
            theme=book.theme,
            baseCurrency=book.base_currency,
            currencies=[r.code for r in rates if r.pinned],
            rates={r.code: float(r.rate) for r in rates},
            ratesUpdatedAt=_iso(book.rates_updated_at),
            lastPayMethod=book.last_pay_method,
        ),
        people=[PersonState(id=p.id, name=p.name, emoji=p.emoji, color=p.color) for p in people],
        accounts=[AccountState(id=a.id, name=a.name, kind=a.kind.value, ownership=ownership[a.id]) for a in accounts],
        ledgers=[
            LedgerState(
                id=ledger.id,
                name=ledger.name,
                emoji=ledger.emoji,
                kind=ledger.kind.value,
                currency=ledger.currency,
                startDate=_date_str(ledger.start_date),
                endDate=_date_str(ledger.end_date),
                archived=ledger.archived,
                createdAt=_iso(ledger.created_at),
            )
            for ledger in ledgers
        ],
        rules=[
            RuleState(
                id=r.id,
                ledgerId=r.ledger_id,
                name=r.name,
                emoji=r.emoji,
                amount=float(r.amount),
                currency=r.currency,
                frequency=r.frequency.value,
                dueDay=r.due_day,
                startMonth=r.start_month,
                endMonth=r.end_month,
                accountId=r.account_id,
                method=r.method,
                split=_split_state(session, r.split_id) or SplitState(),
                active=r.active,
                notes=r.notes,
                createdAt=_iso(r.created_at),
            )
            for r in rules
        ],
        overrides=[
            RuleOverrideState(
                id=o.id,
                ruleId=o.rule_id,
                period=o.period,
                amount=float(o.amount) if o.amount is not None else None,
                currency=o.currency,
                accountId=o.account_id,
                date=_date_str(o.date),
                split=_split_state(session, o.split_id),
                skipped=o.skipped,
            )
            for o in overrides
        ],
        expenses=[
            ExpenseState(
                id=e.id,
                ledgerId=e.ledger_id,
                name=e.name,
                emoji=e.emoji,
                amount=float(e.amount),
                currency=e.currency,
                fxRate=float(e.fx_rate) if e.fx_rate is not None else None,
                date=e.date.isoformat(),
                accountId=e.account_id,
                method=e.method,
                planned=e.planned,
                split=_split_state(session, e.split_id) or SplitState(),
                notes=e.notes,
                createdAt=_iso(e.created_at),
            )
            for e in expenses
        ],
        settlements=[
            SettlementState(
                id=s.id,
                ledgerId=s.ledger_id,
                date=s.date.isoformat(),
                fromPersonId=s.from_person_id,
                toPersonId=s.to_person_id,
                amount=float(s.amount),
                currency=s.currency,
                fxRate=float(s.fx_rate) if s.fx_rate is not None else None,
                method=s.method,
                note=s.note,
                createdAt=_iso(s.created_at),
            )
            for s in settlements
        ],
    )


# --------------------------------------------------------------------------
# BookState -> Book (full replace, one transaction)
# --------------------------------------------------------------------------


def _wipe_book(session: Session, book: Book) -> None:
    ledger_ids = [ledger.id for ledger in session.exec(select(Ledger).where(Ledger.book_id == book.id)).all()]
    account_ids = [a.id for a in session.exec(select(Account).where(Account.book_id == book.id)).all()]
    split_ids: list[str] = []

    if ledger_ids:
        rule_ids = [r.id for r in session.exec(select(Rule).where(col(Rule.ledger_id).in_(ledger_ids))).all()]
        for e in session.exec(select(Expense).where(col(Expense.ledger_id).in_(ledger_ids))).all():
            split_ids.append(e.split_id)
        for r in session.exec(select(Rule).where(col(Rule.ledger_id).in_(ledger_ids))).all():
            split_ids.append(r.split_id)
        if rule_ids:
            for o in session.exec(select(RuleOverride).where(col(RuleOverride.rule_id).in_(rule_ids))).all():
                if o.split_id:
                    split_ids.append(o.split_id)
            session.exec(delete(RuleOverride).where(col(RuleOverride.rule_id).in_(rule_ids)))  # type: ignore[call-overload, arg-type, unused-ignore]
        session.exec(delete(Settlement).where(col(Settlement.ledger_id).in_(ledger_ids)))  # type: ignore[call-overload, arg-type, unused-ignore]
        session.exec(delete(Expense).where(col(Expense.ledger_id).in_(ledger_ids)))  # type: ignore[call-overload, arg-type, unused-ignore]
        session.exec(delete(Rule).where(col(Rule.ledger_id).in_(ledger_ids)))  # type: ignore[call-overload, arg-type, unused-ignore]
    if split_ids:
        session.exec(delete(SplitShare).where(col(SplitShare.split_id).in_(split_ids)))  # type: ignore[call-overload, arg-type, unused-ignore]
        session.exec(delete(Split).where(col(Split.id).in_(split_ids)))  # type: ignore[call-overload, arg-type, unused-ignore]
    if account_ids:
        session.exec(delete(AccountOwnership).where(col(AccountOwnership.account_id).in_(account_ids)))  # type: ignore[call-overload, arg-type, unused-ignore]
    session.exec(delete(Ledger).where(Ledger.book_id == book.id))  # type: ignore[call-overload, arg-type, unused-ignore]
    session.exec(delete(Account).where(Account.book_id == book.id))  # type: ignore[call-overload, arg-type, unused-ignore]
    session.exec(delete(Person).where(Person.book_id == book.id))  # type: ignore[call-overload, arg-type, unused-ignore]
    session.exec(delete(CurrencyRate).where(CurrencyRate.book_id == book.id))  # type: ignore[call-overload, arg-type, unused-ignore]


def _store_split(session: Session, owner_id: str, split: SplitState | None, person_ids: set[str]) -> str | None:
    if split is None:
        return None
    split_id = f"spl_{owner_id}"
    session.add(Split(id=split_id, mode=SplitMode(split.mode or "equal")))
    # Flush the split row before anything references it — without ORM
    # relationships the unit of work does not order inserts by foreign key.
    session.flush()
    for pid in split.participants:
        if pid in person_ids:
            value = split.values.get(pid)
            session.add(SplitShare(split_id=split_id, person_id=pid, value=_dec(value)))
    return split_id


def replace_book(session: Session, book: Book, state: BookState) -> None:
    _wipe_book(session, book)

    book.name = state.meta.appName or "Piggy"
    book.theme = state.settings.theme
    book.base_currency = state.settings.baseCurrency
    book.last_pay_method = state.settings.lastPayMethod
    book.rates_updated_at = (
        datetime.fromisoformat(state.settings.ratesUpdatedAt) if state.settings.ratesUpdatedAt else None
    )
    book.updated_at = utcnow()
    session.add(book)

    pinned = set(state.settings.currencies)
    for code, rate in state.settings.rates.items():
        session.add(
            CurrencyRate(book_id=book.id, code=code[:3].upper(), rate=Decimal(str(rate)), pinned=code in pinned)
        )

    person_ids = {p.id for p in state.people}
    for p in state.people:
        session.add(Person(id=p.id, book_id=book.id, name=p.name, emoji=p.emoji, color=p.color))
    # No ORM relationships means the unit of work will not order inserts by
    # foreign key on its own — flush layer by layer so parents land first.
    session.flush()
    for a in state.accounts:
        session.add(Account(id=a.id, book_id=book.id, name=a.name, kind=AccountKind(a.kind)))
        for pid, share in a.ownership.items():
            if pid in person_ids:
                session.add(AccountOwnership(account_id=a.id, person_id=pid, share=Decimal(str(share))))
    for ledger in state.ledgers:
        session.add(
            Ledger(
                id=ledger.id,
                book_id=book.id,
                name=ledger.name,
                emoji=ledger.emoji,
                kind=LedgerKind(ledger.kind),
                currency=ledger.currency,
                start_date=_parse_date(ledger.startDate),
                end_date=_parse_date(ledger.endDate),
                archived=ledger.archived,
            )
        )
    session.flush()
    for r in state.rules:
        # RuleState.split always exists (defaults to an even split), so the
        # stored id is never None — same for expenses below.
        session.add(
            Rule(
                id=r.id,
                ledger_id=r.ledgerId,
                name=r.name,
                emoji=r.emoji,
                amount=Decimal(str(r.amount)),
                currency=r.currency,
                frequency=Frequency(r.frequency),
                due_day=max(1, min(31, r.dueDay)),
                start_month=r.startMonth,
                end_month=r.endMonth,
                account_id=r.accountId,
                method=r.method,
                split_id=_store_split(session, r.id, r.split, person_ids) or "",
                active=r.active,
                notes=r.notes,
            )
        )
    session.flush()  # overrides reference rules
    for o in state.overrides:
        session.add(
            RuleOverride(
                id=o.id,
                rule_id=o.ruleId,
                period=o.period,
                amount=_dec(o.amount),
                currency=o.currency,
                account_id=o.accountId,
                date=_parse_date(o.date),
                split_id=_store_split(session, o.id, o.split, person_ids),
                skipped=o.skipped,
            )
        )
    for e in state.expenses:
        session.add(
            Expense(
                id=e.id,
                ledger_id=e.ledgerId,
                name=e.name,
                emoji=e.emoji,
                amount=Decimal(str(e.amount)),
                currency=e.currency,
                fx_rate=_dec(e.fxRate),
                date=date.fromisoformat(e.date),
                account_id=e.accountId,
                method=e.method,
                planned=e.planned,
                split_id=_store_split(session, e.id, e.split, person_ids) or "",
                notes=e.notes,
            )
        )
    for s in state.settlements:
        session.add(
            Settlement(
                id=s.id,
                ledger_id=s.ledgerId,
                date=date.fromisoformat(s.date),
                from_person_id=s.fromPersonId,
                to_person_id=s.toPersonId,
                amount=Decimal(str(s.amount)),
                currency=s.currency,
                fx_rate=_dec(s.fxRate),
                method=s.method,
                note=s.note,
            )
        )
    session.commit()
