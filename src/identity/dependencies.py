"""FastAPI auth dependencies: bearer parsing, current user, admin gate."""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, Request, status
from jose import JWTError
from sqlmodel import Session

from core.utils import ensure_utc
from database.connection import get_session
from identity.jwt_service import JWTService, TokenPayload, TokenType
from identity.models import User, UserRole
from identity.services import UserService


def get_user_service(session: Annotated[Session, Depends(get_session)]) -> UserService:
    return UserService(session)


def get_current_token(request: Request) -> TokenPayload:
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = auth_header.replace("Bearer ", "")
    try:
        payload = JWTService.verify_token(token)
    except JWTError as e:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid or expired token: {e}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from e
    # A refresh token is validly signed but single-purpose; it must not double
    # as a bearer session.
    if payload.type != TokenType.ACCESS:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type. Provide an access token.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return payload


def token_predates_invalidation(user: User, issued_at: int) -> bool:
    if user.sessions_invalidated_at is None:
        return False
    return datetime.fromtimestamp(issued_at, tz=UTC) < ensure_utc(user.sessions_invalidated_at)


def get_current_user(
    token: Annotated[TokenPayload, Depends(get_current_token)],
    user_service: Annotated[UserService, Depends(get_user_service)],
) -> User:
    user = user_service.get_user_by_id(UUID(token.sub))
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="User not found")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="User account is deactivated")
    if token_predates_invalidation(user, token.iat):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail="Session no longer valid. Please sign in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def require_admin(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    if current_user.role != UserRole.admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return current_user
