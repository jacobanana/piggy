---
name: migrations
description: Write, re-chain and verify Alembic migrations in this repo. Use whenever a SQLModel model changes, when alembic is mentioned, when a migration has to be written or reviewed, and always after merging main into a branch that carries one — that merge is what produces two heads.
---

# Migrations

Tests build their schema from `SQLModel.metadata`, so migrations are the one
thing production runs that the suite otherwise wouldn't. That is why
`tests/test_migrations.py` exists: it upgrades a scratch database to head and
asserts the resulting tables match the models, and that there is exactly one
head.

## Writing one

```bash
bash scripts/await_ready.sh          # Postgres must be up
make migration m="add wombats"       # alembic revision --autogenerate
```

Then **read the generated body** — autogenerate renders a column rename as
drop+add, which is data loss. Never rename the generated filename. Seed data
does not belong in migrations.

Enums here are stored as VARCHAR with a CHECK constraint
(`native_enum=False` in `src/ledger/models.py`), so adding an enum value is
a plain metadata change — there is deliberately no `ALTER TYPE` dance in
this repo. Keep it that way.

## Two heads after a merge

```bash
uv run alembic heads     # two lines = broken chain
```

Re-chain: edit your (unreleased) migration's `down_revision` to point at the
other head, re-run `uv run alembic heads` (one line now), then verify:

```bash
uv run pytest tests/test_migrations.py
```

Re-chain, do not add a merge migration — until a head has run somewhere you
can't rewrite, linear history is cheaper than a diamond.

## Applying

```bash
make migrate            # local dev
docker compose exec backend alembic upgrade head   # docker stack
```
