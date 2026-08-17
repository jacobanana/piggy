# 🐷 Piggy

Shared expenses for two — recurring bills, everyday extras, things booked but
not yet paid, and holiday pots, split evenly, by shares or to the cent, with one
running receipt tallying who owes whom across every month and an itemised log of
every repayment between you. Multi-currency, with its own exchange rates.

**Live (frontend-only):** https://jacobanana.github.io/piggy/
Everything stays in your browser's localStorage; export/import JSON any time.
Add it to your home screen and it opens full screen and works with no signal —
on an iPhone that is also what stops iOS clearing the book after a week unused.

## Two shapes, one product

| | GitHub Pages | Self-hosted |
| --- | --- | --- |
| Frontend | Vite + TypeScript, no framework | the same build, served by the backend |
| Persistence | localStorage + JSON export | Postgres via `GET/PUT /api/book` |
| Auth | none | passwordless email codes → JWT |
| Installable | yes — home screen, offline, no backend | yes — the book still needs the network |
| Shipped by | `release.yml` → GitHub Pages | `release.yml` → a GHCR image → [mixedmode-deploy](https://github.com/jacobanana/mixedmode-deploy) |

Both ship from the same green commit on every push to `main`. The self-hosted
half runs on a small box shared with a few other apps, described in that second
repo — this one builds the image and names it; that one records the version as
a commit and rolls the stack over, so a rollback is a revert there.

The data model is identical in both: `frontend/src/model/types.ts` and
`src/ledger/models.py` mirror each other field for field, and a Piggy JSON
export is byte-compatible with the sync API body.

## Run it

```bash
# Frontend only (what Pages ships)
cd frontend && npm install && npm run dev

# Everything, no docker (needs local Postgres, or docker just for it)
make install
make dev              # backend :8000, frontend :5173

# Everything, in docker
docker compose up --build     # backend + built SPA on :8000, adminer on :8080
```

First user (auth):

```bash
uv run manage create --email you@example.com --name "You" --role admin
```

Sign-in codes are emailed when SMTP is configured, printed to the backend log
when it isn't, and `uv run manage login-code --email you@example.com` reads
the pending code back — a mail outage is never a lockout. The rest of the
CLI: `list`, `set-role`, `set-email`, `activate`, `deactivate`, `logout`.

## Development

```bash
bash scripts/checks.sh        # the commit gate: ruff + mypy + tsc + vitest
uv run pytest                 # backend tests (real Postgres, scratch DBs)
make migration m="..."        # alembic autogenerate; read the body before applying
```

`scripts/start_app.sh` prepares a cold machine end to end (deps, Postgres —
Docker or a local cluster, migrations, a dev user) and is what the
`.claude/` SessionStart hook runs, so the repo is fully workable from
Claude Code on the web or a phone.

## Layout

```
frontend/          Vite app: model/ (types), domain/ (pure maths), app/ (UI)
src/               FastAPI backend: core/, database/, identity/, ledger/
alembic/           migrations
tests/             backend tests (pytest, real Postgres)
scripts/           start_app / stop_app / checks / await_ready
.claude/           hooks + skills for developing from Claude
```
