# CLAUDE.md

## WHAT THIS IS

Piggy: shared expenses for two. One repo, two deployment shapes:

1. **GitHub Pages** — the Vite frontend alone, persisting to localStorage.
   This is the live product at https://jacobanana.github.io/piggy/ and it
   must always work with no backend at all.
2. **Self-hosted** — the same frontend served by the FastAPI backend, with
   Postgres, passwordless email-code auth, and whole-book sync
   (`GET/PUT /api/book`).

## THE ONE INVARIANT THAT MATTERS

The data model lives in two files that mirror each other field for field:

- `frontend/src/model/types.ts` — the TypeScript entities + the JSON wire shape
- `src/ledger/models.py` — the SQL tables (with `src/ledger/schemas.py` as the
  camelCase wire format between them)

Change one, change all three, and prove it with
`uv run pytest tests/test_book.py` (the round-trip test). The frontend's
localStorage JSON, its export files, and the API body are the same shape —
that is what keeps the Pages build and the backend build one product.

## CODEBASE MAP

- `frontend/src/domain/` — pure maths: splits, balances, recurrence, fx.
  Tested by Vitest. No DOM anywhere in this directory.
- `frontend/src/app/` — rendering, modals, events; DOM allowed, maths not.
- `src/identity/` — users, email codes, JWT. `src/manage.py` is the user CLI.
- `src/ledger/` — the Book data model and the sync service.
- `alembic/` — migrations (load the `migrations` skill before touching).

## WORKFLOW

**Before any check, wait for the environment**: `bash scripts/await_ready.sh`.
It returns instantly when the container is warm. Do not diagnose a failing
test or a missing module before it has returned.

**The commit gate**: `bash scripts/checks.sh` — ruff, mypy, tsc, vitest.
Silence is the pass. The Claude hook runs it before every `git commit`.

**The pre-PR gate**: `bash scripts/checks.sh && uv run pytest`. checks.sh
deliberately never runs pytest (it needs Postgres); the pair is the real bar.

**Done means seen, not green**: any visual change is exercised in the running
app and shown as screenshots (load the `app-screenshots` skill), not
described. `bash scripts/start_app.sh` runs everything without Docker,
including on a fresh web/phone container.

**Users in dev**: `uv run manage create --email you@example.com --name You
--role admin`. Sign-in codes print to the backend log when SMTP is unset;
`uv run manage login-code --email ...` reads the pending one back.

Most sessions here are fired from a phone and read back as a pull request.
A stated bug, a scoped issue, a change already described — build it and push
it. Ask first only when the data model or a user-facing flow would change
shape.

## CONVENTIONS THAT BITE

- Money maths happens in integer cents (`frontend/src/domain/`); rounding
  rules (who absorbs the leftover cent) are load-bearing and tested.
- Planned expenses stay out of every total that describes reality.
- Expenses and settlements snapshot their fx rate; rules use the live table.
- Enums are VARCHAR + CHECK, never native Postgres enums.
- The Pages build must never require the backend: no unguarded `/api` calls
  in `frontend/src/` outside a storage adapter.
