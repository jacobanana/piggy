#!/usr/bin/env bash
# The commit gate — one home for the fast quality checks, shared by the
# Claude PreToolUse hook, CI, and anyone typing `make checks`.
#
#   scripts/checks.sh [backend|frontend]...   no args = both
#
# Prints a failure report and exits 1; exits 0 silently on success.
# Silence is the pass. Deliberately never runs pytest or a browser — those
# are the pre-PR gate (see CLAUDE.md).
set -uo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

failures=()
report=""

run() {
  local label="$1"; shift
  local out
  if ! out=$("$@" 2>&1); then
    failures+=("$label")
    report+=$'\n'"--- $label ---"$'\n'"$(tail -n 40 <<<"$out")"$'\n'
  fi
}

run_in() {
  local dir="$1" label="$2"; shift 2
  local out
  if ! out=$(cd "$dir" && "$@" 2>&1); then
    failures+=("$label")
    report+=$'\n'"--- $label ---"$'\n'"$(tail -n 40 <<<"$out")"$'\n'
  fi
}

backend_checks() {
  if [[ ! -d .venv ]]; then
    failures+=("backend env"); report+=$'\n'"--- backend env ---"$'\n'"No .venv — run 'bash scripts/await_ready.sh' first."$'\n'
    return
  fi
  run "uv run ruff format --check ." uv run ruff format --check .
  run "uv run ruff check ." uv run ruff check .
  run "uv run mypy src" uv run mypy src
}

frontend_checks() {
  if [[ ! -d frontend/node_modules ]]; then
    failures+=("frontend env"); report+=$'\n'"--- frontend env ---"$'\n'"No frontend/node_modules — run 'bash scripts/await_ready.sh' first."$'\n'
    return
  fi
  run_in frontend "tsc --noEmit (frontend)" npx tsc --noEmit
  run_in frontend "vitest (frontend)" npm test --silent
}

scopes=("$@")
if [[ ${#scopes[@]} -eq 0 ]]; then
  scopes=(backend frontend)
fi

for scope in "${scopes[@]}"; do
  case "$scope" in
    backend) backend_checks ;;
    frontend) frontend_checks ;;
    *) echo "unknown scope: $scope" >&2; exit 2 ;;
  esac
done

if [[ ${#failures[@]} -gt 0 ]]; then
  echo "Checks failed: ${failures[*]}"
  echo "$report"
  exit 1
fi
