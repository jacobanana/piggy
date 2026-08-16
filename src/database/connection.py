"""Database engine and session management."""

from collections.abc import Generator

from sqlmodel import Session, create_engine

from core.config import get_settings

settings = get_settings()

engine = create_engine(
    str(settings.database_url),
    echo=settings.environment == "development",
    pool_pre_ping=True,
)


def get_session() -> Generator[Session, None, None]:
    with Session(engine) as session:
        yield session
