"""Book sync endpoints — whole book in, whole book out."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlmodel import Session

from database.connection import get_session
from identity.dependencies import get_current_user
from identity.models import User
from ledger.schemas import BookState
from ledger.service import book_to_state, ensure_book_for_user, replace_book

router = APIRouter(prefix="/book", tags=["book"])


@router.get("", response_model=BookState)
def get_book(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_session)],
) -> BookState:
    book = ensure_book_for_user(session, current_user)
    return book_to_state(session, book)


@router.put("", response_model=BookState)
def put_book(
    state: BookState,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_session)],
) -> BookState:
    """Replace the caller's whole book — the shape of a Piggy JSON export."""
    book = ensure_book_for_user(session, current_user)
    replace_book(session, book, state)
    return book_to_state(session, book)
