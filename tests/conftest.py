"""Backend test fixtures: a real scratch Postgres database, dropped afterwards.

The schema is built from SQLModel.metadata (not the migrations), which is why
test_migrations.py exists — it checks the migration chain produces the same
tables.
"""

import os

# Hermetic settings: no .env, test environment, scratch database.
os.environ["ENVIRONMENT"] = "test"
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql://piggy_user:piggy_dev_password@localhost:5432/piggy_test",
)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402
from sqlmodel import Session, SQLModel, delete  # noqa: E402

from core.config import Settings, get_settings  # noqa: E402

Settings.model_config["env_file"] = None
get_settings.cache_clear()

import identity.models  # noqa: E402, F401
import ledger.models  # noqa: E402, F401
from database.connection import engine  # noqa: E402


def _admin_url() -> str:
    url = os.environ["DATABASE_URL"]
    return url.rsplit("/", 1)[0] + "/postgres"


@pytest.fixture(scope="session", autouse=True)
def test_database():
    db_name = os.environ["DATABASE_URL"].rsplit("/", 1)[1]
    admin = create_engine(_admin_url(), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}"'))
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    SQLModel.metadata.create_all(engine)
    yield
    engine.dispose()
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
    admin.dispose()


@pytest.fixture(autouse=True)
def clean_tables(test_database):
    yield
    with Session(engine) as session:
        for table in reversed(SQLModel.metadata.sorted_tables):
            session.exec(delete(table))  # type: ignore[call-overload]
        session.commit()


@pytest.fixture
def session(test_database):
    with Session(engine) as s:
        yield s


@pytest.fixture
def client():
    from api import app

    return TestClient(app)
