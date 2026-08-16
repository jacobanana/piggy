#!/usr/bin/env bash
# Stop what start_app.sh started. Kills the process group per pidfile,
# since `npx vite` is a launcher whose child holds the port.
set -uo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || repo_root=$(cd "$(dirname "$0")/.." && pwd)
run_dir="$repo_root/.dev"

for name in backend frontend; do
  pidfile="$run_dir/$name.pid"
  [[ -f "$pidfile" ]] || continue
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    echo "stopped $name"
  fi
  rm -f "$pidfile"
done
