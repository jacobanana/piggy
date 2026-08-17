"""Book sync, and everything about who a book is shared with.

Sync is whole-book in and whole-book out, versioned with ETag/If-Match so
the body stays byte-identical to the frontend's AppState — the wire shape is
the invariant, so the version rides in a header rather than in the JSON.
"""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Response, status
from pydantic import BaseModel, EmailStr
from sqlmodel import Session, col, select

from database.connection import get_session
from identity.api import LoginCodeRequested, get_login_code_service
from identity.dependencies import get_current_user
from identity.models import User
from identity.services import LoginCodeService, UserService
from ledger.models import Book, BookMember, MemberRole
from ledger.schemas import BookState
from ledger.service import (
    INVITE_TTL_DAYS,
    StaleBookError,
    accept_invite,
    books_for_user,
    claim_person,
    create_book,
    create_invite,
    current_invite,
    delete_book,
    ensure_book_for_user,
    invite_by_code,
    member_count,
    membership_in,
    read_book,
    remove_member,
    revoke_book_invites,
    sync_book,
)

router = APIRouter(tags=["book"])


# --------------------------------------------------------------------------
# Wire models
# --------------------------------------------------------------------------


class BookSummary(BaseModel):
    id: UUID
    name: str
    role: str
    members: int
    personId: str | None = None


class BookCreate(BaseModel):
    name: str = "Piggy"


class MemberOut(BaseModel):
    userId: UUID
    email: str
    name: str
    role: str
    personId: str | None = None
    isMe: bool = False


class PersonClaim(BaseModel):
    personId: str | None = None


class InviteOut(BaseModel):
    id: UUID
    code: str
    expiresAt: datetime


class InvitePreview(BaseModel):
    code: str
    bookName: str
    members: int
    alreadyMember: bool


class InviteClaim(BaseModel):
    """Arriving with a link and no account yet."""

    email: EmailStr
    name: str | None = None


# --------------------------------------------------------------------------
# Access
# --------------------------------------------------------------------------

BookId = Annotated[UUID, Path(description="Book id")]


def require_member(
    book_id: BookId,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_session)],
) -> tuple[Book, BookMember]:
    """A book you are in. Anything else is a 404 — non-members learn nothing."""
    membership = membership_in(session, book_id, current_user.id)
    book = session.get(Book, book_id) if membership else None
    if membership is None or book is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="No such piggy bank.")
    return book, membership


def require_owner(
    access: Annotated[tuple[Book, BookMember], Depends(require_member)],
) -> tuple[Book, BookMember]:
    if access[1].role != MemberRole.owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Only an owner can do that.")
    return access


Access = Annotated[tuple[Book, BookMember], Depends(require_member)]
OwnerAccess = Annotated[tuple[Book, BookMember], Depends(require_owner)]
Db = Annotated[Session, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


def _parse_version(if_match: str | None) -> int | None:
    """`If-Match: "7"` -> 7. Absent or unparseable means "just overwrite"."""
    if not if_match:
        return None
    try:
        return int(if_match.strip().strip('"').lstrip("W/").strip('"'))
    except ValueError:
        return None


def _tagged(response: Response, book: Book) -> None:
    response.headers["ETag"] = f'"{book.version}"'


def _summary(session: Session, book: Book, membership: BookMember) -> BookSummary:
    return BookSummary(
        id=book.id,
        name=book.name,
        role=membership.role.value,
        members=member_count(session, book.id),
        personId=membership.person_id,
    )


# --------------------------------------------------------------------------
# The books you are in
# --------------------------------------------------------------------------


@router.get("/books", response_model=list[BookSummary])
def list_books(current_user: CurrentUser, session: Db) -> list[BookSummary]:
    """Every piggy bank this account belongs to. Empty means: make one."""
    out = []
    for book in books_for_user(session, current_user):
        membership = membership_in(session, book.id, current_user.id)
        if membership is not None:
            out.append(_summary(session, book, membership))
    return out


@router.post("/books", response_model=BookSummary, status_code=status.HTTP_201_CREATED)
def post_book(body: BookCreate, current_user: CurrentUser, session: Db) -> BookSummary:
    book = create_book(session, current_user, body.name)
    membership = membership_in(session, book.id, current_user.id)
    assert membership is not None
    return _summary(session, book, membership)


@router.get("/books/{book_id}", response_model=BookState)
def get_book_by_id(access: Access, session: Db, response: Response) -> BookState:
    book, _ = access
    state = read_book(session, book)
    _tagged(response, book)
    return state


@router.put("/books/{book_id}", response_model=BookState)
def put_book_by_id(
    state: BookState,
    access: Access,
    session: Db,
    response: Response,
    if_match: Annotated[str | None, Header(alias="If-Match")] = None,
) -> BookState:
    """Replace the book, merging in anything written since If-Match."""
    book, _ = access
    try:
        merged = sync_book(session, book, state, _parse_version(if_match))
    except StaleBookError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="This piggy bank has moved on too far to merge your copy. Reload to catch up.",
        ) from exc
    _tagged(response, book)
    return merged


@router.delete("/books/{book_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_book_by_id(access: OwnerAccess, session: Db) -> None:
    """Erase a piggy bank and everything in it.

    Owners only, and it takes the book away from everyone who shares it — so
    the client asks for the name to be typed before it calls this. Leaving is
    the other door: removing yourself as a member keeps the book standing.
    """
    book, _ = access
    delete_book(session, book)


# --------------------------------------------------------------------------
# Members
# --------------------------------------------------------------------------


@router.get("/books/{book_id}/members", response_model=list[MemberOut])
def list_members(access: Access, current_user: CurrentUser, session: Db) -> list[MemberOut]:
    book, _ = access
    rows = session.exec(
        select(BookMember).where(BookMember.book_id == book.id).order_by(col(BookMember.created_at))
    ).all()
    out = []
    for m in rows:
        user = session.get(User, m.user_id)
        if user is None:
            continue
        out.append(
            MemberOut(
                userId=user.id,
                email=user.email,
                name=user.name,
                role=m.role.value,
                personId=m.person_id,
                isMe=user.id == current_user.id,
            )
        )
    return out


@router.put("/books/{book_id}/members/me/person", response_model=MemberOut)
def put_my_person(body: PersonClaim, access: Access, current_user: CurrentUser, session: Db) -> MemberOut:
    """Say which person in the tally is you."""
    _, membership = access
    membership = claim_person(session, membership, body.personId)
    return MemberOut(
        userId=current_user.id,
        email=current_user.email,
        name=current_user.name,
        role=membership.role.value,
        personId=membership.person_id,
        isMe=True,
    )


@router.delete("/books/{book_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_member(user_id: UUID, access: Access, current_user: CurrentUser, session: Db) -> None:
    """Remove somebody, or leave yourself. Anyone may leave; only an owner may evict."""
    book, membership = access
    if user_id != current_user.id and membership.role != MemberRole.owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Only an owner can remove somebody else.")
    remove_member(session, book.id, user_id)


# --------------------------------------------------------------------------
# Invites
# --------------------------------------------------------------------------


@router.get("/books/{book_id}/invite", response_model=InviteOut | None)
def get_invite(access: OwnerAccess, session: Db) -> InviteOut | None:
    """This book's link, or null. One book, one link — never somebody else's."""
    book, _ = access
    invite = current_invite(session, book.id)
    return None if invite is None else InviteOut(id=invite.id, code=invite.code, expiresAt=invite.expires_at)


@router.post("/books/{book_id}/invite", response_model=InviteOut)
def post_invite(access: OwnerAccess, current_user: CurrentUser, session: Db) -> InviteOut:
    """This book's link, minted if it hasn't got one.

    Idempotent on purpose: pressing share twice hands back the same code, so
    the link already sent to somebody stays the live one. Good for
    INVITE_TTL_DAYS, and it opens this book and no other.
    """
    book, _ = access
    invite = create_invite(session, book.id, current_user)
    return InviteOut(id=invite.id, code=invite.code, expiresAt=invite.expires_at)


@router.delete("/books/{book_id}/invite", status_code=status.HTTP_204_NO_CONTENT)
def delete_invite(access: OwnerAccess, session: Db) -> None:
    book, _ = access
    revoke_book_invites(session, book.id)


@router.get("/invites/{code}", response_model=InvitePreview)
def preview_invite(code: str, current_user: CurrentUser, session: Db) -> InvitePreview:
    """What am I being asked to join? Signed-in only, so codes don't leak book names."""
    invite = invite_by_code(session, code)
    book = session.get(Book, invite.book_id)
    if book is None:
        raise LookupError("That piggy bank is gone.")
    return InvitePreview(
        code=invite.code,
        bookName=book.name,
        members=member_count(session, book.id),
        alreadyMember=membership_in(session, book.id, current_user.id) is not None,
    )


@router.post("/invites/{code}/claim", response_model=LoginCodeRequested, status_code=status.HTTP_202_ACCEPTED)
def claim_invite(
    code: str,
    body: InviteClaim,
    login_codes: Annotated[LoginCodeService, Depends(get_login_code_service)],
    session: Db,
) -> LoginCodeRequested:
    """Start signing in against an invite code, making the account if need be.

    Piggy has no open sign-up: `manage create` was the only way in, which left
    an invite link useless to the very person it was sent to. A live code is
    the ticket — hold one and you may mint exactly one account, for the
    address you can read mail at, and the sign-in code goes there as usual.
    """
    invite_by_code(session, code)  # 404/400 before an account is made
    user = UserService(session).ensure_user(body.email, body.name)
    verification = login_codes.request(user.email)
    return LoginCodeRequested(verification_id=verification.id, expires_at=verification.expires_at)


@router.post("/invites/{code}/accept", response_model=BookSummary)
def post_accept_invite(code: str, current_user: CurrentUser, session: Db) -> BookSummary:
    invite = invite_by_code(session, code)
    membership = accept_invite(session, invite, current_user)
    book = session.get(Book, invite.book_id)
    if book is None:
        raise LookupError("That piggy bank is gone.")
    return _summary(session, book, membership)


# --------------------------------------------------------------------------
# The default book — kept so a single-book client needs to know no ids
# --------------------------------------------------------------------------

default_router = APIRouter(prefix="/book", tags=["book"])


@default_router.get("", response_model=BookState)
def get_book(current_user: CurrentUser, session: Db, response: Response) -> BookState:
    book = ensure_book_for_user(session, current_user)
    state = read_book(session, book)
    _tagged(response, book)
    return state


@default_router.put("", response_model=BookState)
def put_book(
    state: BookState,
    current_user: CurrentUser,
    session: Db,
    response: Response,
    if_match: Annotated[str | None, Header(alias="If-Match")] = None,
) -> BookState:
    """Replace the caller's whole book — the shape of a Piggy JSON export."""
    book = ensure_book_for_user(session, current_user)
    try:
        merged = sync_book(session, book, state, _parse_version(if_match))
    except StaleBookError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="This piggy bank has moved on too far to merge your copy. Reload to catch up.",
        ) from exc
    _tagged(response, book)
    return merged


__all__ = ["INVITE_TTL_DAYS", "default_router", "router"]
