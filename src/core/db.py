from typing import Any

from sqlalchemy import DateTime
from sqlmodel import Field


def utc_datetime_field(**kwargs: Any) -> Any:
    """SQLModel field stored as TIMESTAMP WITH TIME ZONE, so nothing lands naive."""
    return Field(sa_type=DateTime(timezone=True), **kwargs)  # type: ignore[call-overload]
