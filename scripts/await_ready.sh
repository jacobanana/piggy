#!/usr/bin/env bash
# Block until the dev environment is prepared; return immediately when it is.
#
# Contract:
#   prepared            -> returns in milliseconds
#   preparation running -> joins it (flock) instead of racing it
#   never prepared      -> runs the preparation inline
#   --refresh           -> force a re-run
#
# Run this before pytest, tsc, alembic, or the app on a fresh container.
set -uo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

run_dir="$repo_root/.dev"
mkdir -p "$run_dir"
marker="$run_dir/prepared"

[[ "${1:-}" == "--refresh" ]] && rm -f "$marker"

[[ -f "$marker" ]] && exit 0

exec 9>"$run_dir/prepare.lock"
flock 9
# Someone else may have finished while we waited on the lock.
[[ -f "$marker" ]] && exit 0

# 9>&- closes the lock fd for children, so a daemonised Postgres can't
# inherit it and hold the lock for the container's life.
bash scripts/start_app.sh --prepare-only 9>&-
