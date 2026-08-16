"""Users and the email-code credential.

Auth is passwordless, same as reathletic-agenda: a six-digit one-time code
emailed to the address, exchanged for a JWT pair. There is no password and
no credential stored on the user row — the mailbox is the credential.
"""

import enum
from datetime import datetime
from uuid import UUID, uuid4

from sqlmodel import Field, SQLModel

from core.db import utc_datetime_field
from core.utils import utcnow

CODE_LENGTH = 6


class UserRole(enum.StrEnum):
    admin = "admin"
    member = "member"


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    email: str = Field(unique=True, index=True, max_length=255)
    name: str = Field(max_length=255)
    role: UserRole = Field(default=UserRole.member, index=True)
    is_active: bool = Field(default=True)
    # Stateless force-sign-out: tokens issued before this instant are refused.
    sessions_invalidated_at: datetime | None = utc_datetime_field(default=None)
    created_at: datetime = utc_datetime_field(default_factory=utcnow)
    updated_at: datetime = utc_datetime_field(default_factory=utcnow)


class EmailVerification(SQLModel, table=True):
    __tablename__ = "email_verifications"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    email: str = Field(max_length=255, index=True)
    code: str = Field(max_length=CODE_LENGTH)
    attempts: int = Field(default=0, ge=0)
    expires_at: datetime = utc_datetime_field()
    consumed_at: datetime | None = utc_datetime_field(default=None)
    created_at: datetime = utc_datetime_field(default_factory=utcnow)
