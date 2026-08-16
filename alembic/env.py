"""Alembic migration environment."""

from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool
from sqlmodel import SQLModel

from alembic import context
from core.config import get_settings

# Import all models so SQLModel.metadata knows every table (autogenerate).
from identity.models import EmailVerification, User  # noqa: F401
from ledger.models import (  # noqa: F401
    Account,
    AccountOwnership,
    Book,
    BookMember,
    CurrencyRate,
    Expense,
    Ledger,
    Person,
    Rule,
    RuleOverride,
    Settlement,
    Split,
    SplitShare,
)

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# One source of truth for the URL: application settings.
settings = get_settings()
config.set_main_option("sqlalchemy.url", str(settings.database_url))

target_metadata = SQLModel.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
            # Commit per revision so later revisions can use what earlier
            # ones created (and enum-style DDL never fights a transaction).
            transaction_per_migration=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
