#!/usr/bin/env bash
# One entry point to a running Piggy, on a laptop or a fresh Claude container.
#
#   bash scripts/start_app.sh                 prepare + start backend & frontend
#   bash scripts/start_app.sh --prepare-only  install deps, start Postgres, migrate, stop
#   bash scripts/start_app.sh --fresh         wipe the dev database first
#
# Postgres: uses Docker when the daemon is reachable, otherwise falls back to
# a local Debian cluster via pg_ctlcluster (what Claude web/phone containers
# have). Idempotent: a running stack is reused, not restarted.
#
# Runtime state lives in .dev/ (gitignored): logs, pids, the prepared marker.
# Stop everything with scripts/stop_app.sh.
set -uo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

run_dir="$repo_root/.dev"
mkdir -p "$run_dir"

PREPARE_ONLY=0
FRESH=0
for arg in "$@"; do
  case "$arg" in
    --prepare-only) PREPARE_ONLY=1 ;;
    --fresh) FRESH=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

BACKEND_PORT="${PIGGY_BACKEND_PORT:-8000}"
FRONTEND_PORT="${PIGGY_FRONTEND_PORT:-5173}"
DB_URL="${DATABASE_URL:-postgresql://piggy_user:piggy_dev_password@localhost:5432/piggy}"

log() { echo "[start_app] $*"; }

# --- postgres ---------------------------------------------------------------

pg_ready() { psql "$DB_URL" -c 'select 1' >/dev/null 2>&1; }

start_postgres() {
  if pg_ready; then log "postgres already answering"; return 0; fi

  if docker info >/dev/null 2>&1; then
    log "starting postgres via docker compose"
    docker compose up -d --wait postgres
  elif command -v pg_ctlcluster >/dev/null 2>&1; then
    log "starting local postgres cluster (no docker here)"
    local version
    version=$(ls /etc/postgresql 2>/dev/null | head -1)
    pg_ctlcluster "$version" main start 2>/dev/null || true
    # Ensure role + database exist (idempotent).
    if command -v runuser >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
      runuser -u postgres -- psql -tc "SELECT 1 FROM pg_roles WHERE rolname='piggy_user'" | grep -q 1 ||
        runuser -u postgres -- psql -c "CREATE USER piggy_user WITH PASSWORD 'piggy_dev_password' CREATEDB"
      runuser -u postgres -- psql -tc "SELECT 1 FROM pg_database WHERE datname='piggy'" | grep -q 1 ||
        runuser -u postgres -- psql -c "CREATE DATABASE piggy OWNER piggy_user"
    else
      sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='piggy_user'" | grep -q 1 ||
        sudo -u postgres psql -c "CREATE USER piggy_user WITH PASSWORD 'piggy_dev_password' CREATEDB"
      sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='piggy'" | grep -q 1 ||
        sudo -u postgres psql -c "CREATE DATABASE piggy OWNER piggy_user"
    fi
  else
    log "ERROR: no docker and no pg_ctlcluster — install Postgres or start Docker"; exit 1
  fi

  for _ in $(seq 1 30); do pg_ready && return 0; sleep 1; done
  log "ERROR: postgres did not come up"; exit 1
}

# --- prepare ------------------------------------------------------------------

prepare() {
  local t0=$SECONDS

  local pids=()
  start_postgres &
  pids+=($!)

  if [[ ! -d .venv || pyproject.toml -nt .venv ]]; then
    log "uv sync"
    uv sync >>"$run_dir/setup.log" 2>&1 &
    pids+=($!)
  fi

  if [[ ! -d frontend/node_modules || frontend/package-lock.json -nt frontend/node_modules ]]; then
    log "npm install"
    (cd frontend && npm install) >>"$run_dir/setup.log" 2>&1 &
    pids+=($!)
  fi

  wait "${pids[@]}" 2>/dev/null || true
  pg_ready || { log "postgres failed — see above"; exit 1; }

  if [[ $FRESH -eq 1 ]]; then
    log "dropping and recreating the dev database"
    psql "${DB_URL%/*}/postgres" -c 'DROP DATABASE IF EXISTS piggy WITH (FORCE)' >/dev/null 2>&1 || true
    psql "${DB_URL%/*}/postgres" -c 'CREATE DATABASE piggy' >/dev/null 2>&1 || true
  fi

  log "alembic upgrade head"
  uv run alembic upgrade head >>"$run_dir/setup.log" 2>&1 || { tail -5 "$run_dir/setup.log"; exit 1; }

  # A dev user so the login picker has someone to offer.
  uv run manage list 2>/dev/null | grep -q "dev@piggy.local" ||
    uv run manage create --email dev@piggy.local --name "Dev" --role admin >>"$run_dir/setup.log" 2>&1 || true

  touch "$run_dir/prepared"
  log "prepared in $((SECONDS - t0))s"
}

prepare

if [[ $PREPARE_ONLY -eq 1 ]]; then
  exit 0
fi

# --- start ---------------------------------------------------------------------

spawn() {
  local name="$1"; shift
  local pidfile="$run_dir/$name.pid"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    log "$name already running"
    return 0
  fi
  local detach=()
  command -v setsid >/dev/null && detach=(setsid)
  "${detach[@]}" nohup "$@" >"$run_dir/$name.log" 2>&1 </dev/null &
  echo $! >"$pidfile"
  log "$name started (log: .dev/$name.log)"
}

if ! curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
  DEV_AUTH_ENABLED="${DEV_AUTH_ENABLED:-true}" spawn backend \
    uv run uvicorn api:app --app-dir src --reload --host 127.0.0.1 --port "$BACKEND_PORT"
fi

spawn frontend bash -c "cd frontend && PIGGY_API_URL=http://127.0.0.1:$BACKEND_PORT npx vite --host 127.0.0.1 --port $FRONTEND_PORT --strictPort"

for _ in $(seq 1 30); do
  curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:$FRONTEND_PORT/" >/dev/null 2>&1 && break
  sleep 1
done

base="http://127.0.0.1:$FRONTEND_PORT"
echo "$base" >"$run_dir/base_url"
log "frontend: $base   backend: http://127.0.0.1:$BACKEND_PORT/api/health"
echo "$base"
