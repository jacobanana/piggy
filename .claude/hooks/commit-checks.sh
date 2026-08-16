#!/usr/bin/env bash
# PreToolUse/Bash gate: refuse `git commit` until the fast checks pass.
#
# Reads the hook payload on stdin, and only acts when the command is a real
# commit. The checks themselves live in scripts/checks.sh, shared with CI so
# they cannot drift. Escape hatch: CLAUDE_SKIP_COMMIT_CHECKS=1.
set -uo pipefail

payload=$(cat)
command=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')

# Matches `git commit`, `git -C dir commit`, and commits chained after cd/&&/;.
if ! grep -Eq '(^|[;&|(]|&&)[[:space:]]*git([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$)' <<<"$command"; then
  exit 0
fi

grep -Eq -- '--dry-run' <<<"$command" && exit 0
[[ "${CLAUDE_SKIP_COMMIT_CHECKS:-}" == "1" ]] && exit 0

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$repo_root" || exit 0

# Staged plus unstaged, so `git commit -a` is covered too.
changed=$(git diff --cached --name-only --diff-filter=ACMR; git diff --name-only --diff-filter=ACMR)

scopes=()
grep -Eq '\.py$|^pyproject\.toml$|^alembic/' <<<"$changed" && scopes+=(backend)
grep -q '^frontend/' <<<"$changed" && scopes+=(frontend)
[[ ${#scopes[@]} -eq 0 ]] && exit 0

report=$(scripts/checks.sh "${scopes[@]}") && exit 0

jq -n --arg reason "Commit blocked: checks did not pass. Fix these, then commit again.

$report" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
