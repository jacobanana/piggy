"""The migration chain must produce the same tables the models declare.

Tests build their schema from SQLModel.metadata, so migrations are the one
thing production runs that the suite otherwise wouldn't.
"""

import os

import pytest
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlmodel import SQLModel

from alembic import command

MIGRATION_DB = "piggy_migration_test"


@pytest.fixture
def migration_engine():
    base_url = os.environ["DATABASE_URL"].rsplit("/", 1)[0]
    admin = create_engine(base_url + "/postgres", isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{MIGRATION_DB}"'))
        conn.execute(text(f'CREATE DATABASE "{MIGRATION_DB}"'))
    engine = create_engine(base_url + f"/{MIGRATION_DB}")
    yield engine
    engine.dispose()
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{MIGRATION_DB}" WITH (FORCE)'))
    admin.dispose()


def test_upgrade_head_matches_models(migration_engine, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", str(migration_engine.url).replace("***", "piggy_dev_password"))
    from core.config import get_settings

    get_settings.cache_clear()
    try:
        cfg = Config("alembic.ini")
        command.upgrade(cfg, "head")

        migrated = set(inspect(migration_engine).get_table_names()) - {"alembic_version"}
        declared = set(SQLModel.metadata.tables.keys())
        assert migrated == declared
    finally:
        get_settings.cache_clear()


def test_single_head():
    from alembic.script import ScriptDirectory

    cfg = Config("alembic.ini")
    script = ScriptDirectory.from_config(cfg)
    assert len(script.get_heads()) == 1, "two migration heads — re-chain, don't merge"
