"""Auth endpoints: request a code, verify it, refresh, whoami.

Logout is client-side (drop the tokens). The dev endpoints exist only when
DEV_AUTH_ENABLED=true, which the settings validator forbids in production.
"""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from jose import JWTError
from pydantic import BaseModel, EmailStr
from sqlmodel import Session, select

from core.config import get_settings
from database.connection import get_session
from identity.dependencies import get_current_user, get_user_service, token_predates_invalidation
from identity.jwt_service import JWTService, TokenType
from identity.models import User
from identity.services import LoginCodeService, UserService

router = APIRouter(prefix="/auth", tags=["authentication"])


class LoginCodeRequest(BaseModel):
    email: EmailStr


class LoginCodeRequested(BaseModel):
    verification_id: UUID
    expires_at: datetime


class LoginCodeVerifyRequest(BaseModel):
    verification_id: UUID
    code: str


class RefreshTokenRequest(BaseModel):
    refresh_token: str


class UserOut(BaseModel):
    id: UUID
    email: str
    name: str
    role: str
    is_active: bool


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserOut


def build_token_response(user: User) -> TokenResponse:
    settings = get_settings()
    return TokenResponse(
        access_token=JWTService.create_token(user.id, user.role.value, TokenType.ACCESS),
        refresh_token=JWTService.create_token(user.id, user.role.value, TokenType.REFRESH),
        expires_in=settings.access_token_expire_minutes * 60,
        user=UserOut(id=user.id, email=user.email, name=user.name, role=user.role.value, is_active=user.is_active),
    )


def get_login_code_service(session: Annotated[Session, Depends(get_session)]) -> LoginCodeService:
    return LoginCodeService(session)


@router.post("/code/request", response_model=LoginCodeRequested, status_code=status.HTTP_202_ACCEPTED)
def request_login_code(
    body: LoginCodeRequest,
    service: Annotated[LoginCodeService, Depends(get_login_code_service)],
) -> LoginCodeRequested:
    verification = service.request(body.email)
    return LoginCodeRequested(verification_id=verification.id, expires_at=verification.expires_at)


@router.post("/code/verify", response_model=TokenResponse)
def verify_login_code(
    body: LoginCodeVerifyRequest,
    service: Annotated[LoginCodeService, Depends(get_login_code_service)],
) -> TokenResponse:
    return build_token_response(service.verify(body.verification_id, body.code))


@router.post("/refresh", response_model=TokenResponse)
def refresh_token(
    body: RefreshTokenRequest,
    user_service: Annotated[UserService, Depends(get_user_service)],
) -> TokenResponse:
    try:
        payload = JWTService.verify_token(body.refresh_token)
    except JWTError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=f"Invalid or expired token: {e}") from e
    if payload.type != TokenType.REFRESH:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid token type. Expected refresh token.")
    user = user_service.get_user_by_id(UUID(payload.sub))
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="User account is deactivated")
    if token_predates_invalidation(user, payload.iat):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Session no longer valid. Please sign in again.")
    return build_token_response(user)


@router.get("/me", response_model=UserOut)
def me(current_user: Annotated[User, Depends(get_current_user)]) -> UserOut:
    return UserOut(
        id=current_user.id,
        email=current_user.email,
        name=current_user.name,
        role=current_user.role.value,
        is_active=current_user.is_active,
    )


# --- dev-only login (mounted conditionally by the composition root) ----------

dev_router = APIRouter(prefix="/auth/dev", tags=["dev-authentication"])


class DevLoginRequest(BaseModel):
    email: EmailStr


@dev_router.get("/users", response_model=list[UserOut])
def dev_users(session: Annotated[Session, Depends(get_session)]) -> list[UserOut]:
    users = session.exec(select(User).where(User.is_active == True)).all()  # noqa: E712
    return [UserOut(id=u.id, email=u.email, name=u.name, role=u.role.value, is_active=u.is_active) for u in users]


@dev_router.post("/login", response_model=TokenResponse)
def dev_login(
    body: DevLoginRequest,
    user_service: Annotated[UserService, Depends(get_user_service)],
) -> TokenResponse:
    user = user_service.get_user_by_email(body.email.strip().lower())
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="No such active user")
    return build_token_response(user)
