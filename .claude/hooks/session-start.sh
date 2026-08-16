#!/usr/bin/env bash
# SessionStart: get the checkout ready to be checked, without making the
# session wait for it.
#
# A container is cloned fresh for every web and mobile session, which leaves
# no .venv, no frontend/node_modules and no running Postgres. Until those
# exist, `uv run pytest` and `npm test` fail for reasons that have nothing to
# do with the change being made.
#
# The preparation takes minutes on a cold container and milliseconds on a warm
# one, so it runs detached and `scripts/await_ready.sh` is what blocks on it.
set -uo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$repo_root" || exit 0

run_dir="$repo_root/.dev"
mkdir -p "$run_dir"

if [[ -f "$run_dir/prepared" ]]; then
  context="The dev stack is already prepared."
else
  # setsid detaches it from the session's process group, so the hook returns
  # now and the work survives.
  detach=()
  command -v setsid >/dev/null && detach=(setsid)
  "${detach[@]}" nohup bash scripts/await_ready.sh >"$run_dir/prepare.log" 2>&1 </dev/null &
  disown $! 2>/dev/null || true

  context="Preparing the dev stack in the background (Postgres, uv sync, migrations, a dev user, npm install). Log: .dev/prepare.log"
fi

jq -n --arg context "$context" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: ($context + "\n\nBefore running pytest, tsc, alembic or the app, run `bash scripts/await_ready.sh` — it returns immediately when preparation is done and blocks until it is when it is not. Do not diagnose a failing test or a missing module before it has returned.")
  }
}'
