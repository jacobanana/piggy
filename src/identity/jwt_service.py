"""JWT issue/verify — HS256, one shared secret, access + refresh types."""

import enum
from datetime import timedelta
from uuid import UUID, uuid4

from jose import JWTError, jwt
from pydantic import BaseModel

from core.config import get_settings
from core.utils import utcnow


class TokenType(enum.StrEnum):
    ACCESS = "access"
    REFRESH = "refresh"


class TokenPayload(BaseModel):
    sub: str
    role: str
    type: TokenType
    exp: int
    iat: int


def token_lifetime(token_type: TokenType) -> timedelta:
    settings = get_settings()
    if token_type == TokenType.REFRESH:
        return timedelta(days=settings.refresh_token_expire_days)
    return timedelta(minutes=settings.access_token_expire_minutes)


class JWTService:
    @staticmethod
    def create_token(user_id: UUID, role: str, token_type: TokenType = TokenType.ACCESS) -> str:
        settings = get_settings()
        now = utcnow()
        expire = now + token_lifetime(token_type)
        payload = {
            "sub": str(user_id),
            "role": role,
            "type": token_type.value,
            "exp": int(expire.timestamp()),
            "iat": int(now.timestamp()),
            "jti": str(uuid4()),
        }
        return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)

    @staticmethod
    def verify_token(token: str) -> TokenPayload:
        settings = get_settings()
        try:
            payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
            return TokenPayload(**payload)
        except JWTError as e:
            raise JWTError(f"Invalid or expired token: {e}") from e
