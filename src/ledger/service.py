"""Load a book into its wire state, and replace it from one.

The sync model is deliberately whole-book: a book is small, so GET hands
back everything and PUT replaces everything in one transaction. Finer-grained
CRUD can grow beside this without changing the schema.

Whole-book writes and shared books do not mix on their own — the second
saver would flatten the first. `sync_book` closes that: the client says which
version it loaded, and anything written since is three-way merged in rather
than overwritten. `book_snapshots` is what makes the "since" knowable.
"""

import secrets
from datetime import date, datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid4

from sqlmodel import Session, col, delete, select

from core.utils import ensure_utc, utcnow
from identity.models import User
from ledger.merge import merge_books
from ledger.models import (
    Account,
    AccountKind,
    AccountOwnership,
    Book,
    BookInvite,
    BookMember,
    BookSnapshot,
    CurrencyRate,
    Expense,
    Frequency,
    Ledger,
    LedgerKind,
    MemberRole,
    Person,
    Rule,
    RuleOverride,
    Settlement,
    SettlementItem,
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


def memberships_of(session: Session, user: User) -> list[BookMember]:
    rows = session.exec(
        select(BookMember).where(BookMember.user_id == user.id).order_by(col(BookMember.created_at))
    ).all()
    return list(rows)


def membership_in(session: Session, book_id: UUID, user_id: UUID) -> BookMember | None:
    return session.exec(select(BookMember).where(BookMember.book_id == book_id, BookMember.user_id == user_id)).first()


def books_for_user(session: Session, user: User) -> list[Book]:
    books = [session.get(Book, m.book_id) for m in memberships_of(session, user)]
    return [b for b in books if b is not None]


def member_count(session: Session, book_id: UUID) -> int:
    return len(session.exec(select(BookMember).where(BookMember.book_id == book_id)).all())


def owner_count(session: Session, book_id: UUID) -> int:
    """How many owners a book has — what tells a client whether leaving is on
    offer. A book keeps at least one, so the last owner's way out is to
    delete it, and saying so beats a refused request."""
    rows = session.exec(
        select(BookMember).where(BookMember.book_id == book_id, BookMember.role == MemberRole.owner)
    ).all()
    return len(rows)


def get_book_for_user(session: Session, user: User) -> Book | None:
    """The user's default book — the one they joined or made first."""
    membership = session.exec(
        select(BookMember).where(BookMember.user_id == user.id).order_by(col(BookMember.created_at))
    ).first()
    return session.get(Book, membership.book_id) if membership else None


def create_book(session: Session, user: User, name: str = "Piggy") -> Book:
    """A new piggy bank, owned by whoever asked for it."""
    book = Book(id=uuid4(), name=name.strip() or "Piggy")
    session.add(book)
    session.add(BookMember(book_id=book.id, user_id=user.id, role=MemberRole.owner))
    session.commit()
    session.refresh(book)
    return book


def ensure_book_for_user(session: Session, user: User) -> Book:
    return get_book_for_user(session, user) or create_book(session, user)


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
    settlement_ids = [s.id for s in settlements]
    settled_items: dict[str, list[str]] = {s.id: [] for s in settlements}
    if settlement_ids:
        rows = session.exec(
            select(SettlementItem)
            .where(col(SettlementItem.settlement_id).in_(settlement_ids))
            .order_by(col(SettlementItem.position))
        ).all()
        for row in rows:
            settled_items[row.settlement_id].append(row.item_id)

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
                itemIds=settled_items[s.id],
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
        settlement_ids = [
            s.id for s in session.exec(select(Settlement).where(col(Settlement.ledger_id).in_(ledger_ids))).all()
        ]
        if settlement_ids:
            session.exec(delete(SettlementItem).where(col(SettlementItem.settlement_id).in_(settlement_ids)))  # type: ignore[call-overload, arg-type, unused-ignore]
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
    session.flush()  # settlement items reference settlements
    for s in state.settlements:
        # Ticking the same item twice would break the primary key; the order
        # of first mention is the one worth keeping.
        for position, item_id in enumerate(dict.fromkeys(s.itemIds)):
            session.add(SettlementItem(settlement_id=s.id, item_id=item_id, position=position))
    session.commit()


# --------------------------------------------------------------------------
# Deleting a book
# --------------------------------------------------------------------------


def delete_book(session: Session, book: Book) -> None:
    """Erase a piggy bank and everything in it, for everyone in it.

    The contents go through the same wipe a full sync does; what is left is
    the rows that only exist to serve this book — its memberships, its link,
    and the snapshots kept for merging. There is no undo, which is why the
    API only lets an owner ask for it.
    """
    _wipe_book(session, book)
    session.exec(delete(BookSnapshot).where(col(BookSnapshot.book_id) == book.id))  # type: ignore[call-overload, arg-type, unused-ignore]
    session.exec(delete(BookInvite).where(col(BookInvite.book_id) == book.id))  # type: ignore[call-overload, arg-type, unused-ignore]
    session.exec(delete(BookMember).where(col(BookMember.book_id) == book.id))  # type: ignore[call-overload, arg-type, unused-ignore]
    session.delete(book)
    session.commit()


# --------------------------------------------------------------------------
# Versioned sync
# --------------------------------------------------------------------------

# How many past versions stay mergeable. A client further behind than this
# gets a 409 and reloads; in practice that means a tab left open for days.
SNAPSHOT_HISTORY = 20

INVITE_TTL_DAYS = 14
# No 0/O/1/I/L: these codes get read aloud and retyped.
INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
INVITE_LENGTH = 8


class StaleBookError(Exception):
    """The client's base version is too old to merge against."""


def _snapshot_at(session: Session, book_id: UUID, version: int) -> BookState | None:
    row = session.get(BookSnapshot, (book_id, version))
    return BookState.model_validate_json(row.state) if row else None


def _store_snapshot(session: Session, book_id: UUID, version: int, state: BookState) -> None:
    if session.get(BookSnapshot, (book_id, version)) is not None:
        return
    session.add(BookSnapshot(book_id=book_id, version=version, state=state.model_dump_json()))
    session.exec(
        delete(BookSnapshot).where(
            col(BookSnapshot.book_id) == book_id,
            col(BookSnapshot.version) <= version - SNAPSHOT_HISTORY,
        )
    )


def read_book(session: Session, book: Book) -> BookState:
    """The book's state, with a snapshot recorded so a later PUT can merge."""
    state = book_to_state(session, book)
    _store_snapshot(session, book.id, book.version, state)
    session.commit()
    return state


def sync_book(session: Session, book: Book, incoming: BookState, base_version: int | None) -> BookState:
    """Write `incoming`, folding it onto anything committed since `base_version`.

    `base_version` None means "I know what I'm doing, overwrite" — the import
    path and any client that never read a version.
    """
    if base_version is not None and base_version != book.version:
        base = _snapshot_at(session, book.id, base_version)
        if base is None:
            raise StaleBookError(f"version {base_version} is no longer mergeable")
        incoming = merge_books(base, incoming, book_to_state(session, book))

    next_version = book.version + 1
    replace_book(session, book, incoming)
    book.version = next_version
    session.add(book)
    session.commit()

    state = book_to_state(session, book)
    _store_snapshot(session, book.id, next_version, state)
    session.commit()
    return state


# --------------------------------------------------------------------------
# Membership and invites
# --------------------------------------------------------------------------


def claim_person(session: Session, membership: BookMember, person_id: str | None) -> BookMember:
    """Say which person in the tally this account is. None unlinks."""
    if person_id is not None:
        person = session.get(Person, person_id)
        if person is None or person.book_id != membership.book_id:
            raise LookupError("No such person in this book.")
        taken = session.exec(
            select(BookMember).where(
                BookMember.book_id == membership.book_id,
                BookMember.person_id == person_id,
                col(BookMember.user_id) != membership.user_id,
            )
        ).first()
        if taken is not None:
            raise ValueError("Somebody else is already linked to that person.")
    membership.person_id = person_id
    session.add(membership)
    session.commit()
    session.refresh(membership)
    return membership


def remove_member(session: Session, book_id: UUID, user_id: UUID) -> None:
    membership = membership_in(session, book_id, user_id)
    if membership is None:
        raise LookupError("Not a member of this book.")
    owners = session.exec(
        select(BookMember).where(BookMember.book_id == book_id, BookMember.role == MemberRole.owner)
    ).all()
    if membership.role == MemberRole.owner and len(owners) == 1:
        raise ValueError("A piggy bank needs at least one owner.")
    session.delete(membership)
    session.commit()


def _fresh_code(session: Session) -> str:
    while True:
        code = "".join(secrets.choice(INVITE_ALPHABET) for _ in range(INVITE_LENGTH))
        if session.exec(select(BookInvite).where(BookInvite.code == code)).first() is None:
            return code


def create_invite(session: Session, book_id: UUID, user: User) -> BookInvite:
    """This book's link, minted only if it hasn't got one.

    One book, one live link. Minting a second on every press left codes alive
    that the share screen no longer showed, so an owner could not revoke what
    they had handed out — and a pile of anonymous codes reads as "every link
    I have ever made", not "the link to this piggy bank".
    """
    existing = current_invite(session, book_id)
    if existing is not None:
        return existing
    invite = BookInvite(
        book_id=book_id,
        code=_fresh_code(session),
        created_by=user.id,
        expires_at=utcnow() + timedelta(days=INVITE_TTL_DAYS),
    )
    session.add(invite)
    session.commit()
    session.refresh(invite)
    return invite


def live_invites(session: Session, book_id: UUID) -> list[BookInvite]:
    now = utcnow()
    rows = session.exec(select(BookInvite).where(BookInvite.book_id == book_id)).all()
    return [i for i in rows if i.revoked_at is None and ensure_utc(i.expires_at) > now]


def current_invite(session: Session, book_id: UUID) -> BookInvite | None:
    """The one live link for this book, or None. The newest wins if history
    left more than one behind — the migration that retires the extras is
    what keeps that from happening again."""
    live = live_invites(session, book_id)
    return max(live, key=lambda i: ensure_utc(i.created_at)) if live else None


def revoke_invite(session: Session, invite: BookInvite) -> None:
    invite.revoked_at = utcnow()
    session.add(invite)
    session.commit()


def revoke_book_invites(session: Session, book_id: UUID) -> None:
    """Kill this book's link. Anyone still holding it stops getting in."""
    now = utcnow()
    for invite in live_invites(session, book_id):
        invite.revoked_at = now
        session.add(invite)
    session.commit()


def invite_by_code(session: Session, code: str) -> BookInvite:
    invite = session.exec(select(BookInvite).where(BookInvite.code == code.strip().upper())).first()
    if invite is None:
        raise LookupError("That invite code doesn't exist.")
    if invite.revoked_at is not None:
        raise ValueError("That invite has been revoked.")
    if ensure_utc(invite.expires_at) <= utcnow():
        raise ValueError("That invite has expired. Ask for a new link.")
    return invite


def accept_invite(session: Session, invite: BookInvite, user: User) -> BookMember:
    """Join the invite's book. Joining twice is a no-op, not an error."""
    existing = membership_in(session, invite.book_id, user.id)
    if existing is not None:
        return existing
    membership = BookMember(book_id=invite.book_id, user_id=user.id, role=MemberRole.member)
    session.add(membership)
    session.commit()
    session.refresh(membership)
    return membership
