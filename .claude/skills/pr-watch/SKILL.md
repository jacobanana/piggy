---
name: pr-watch
description: Drive a pull request to green and to merge — subscribe to its events, diagnose and fix failing CI, and resolve merge conflicts by merging main in. Use after opening a PR, when asked to watch, monitor, babysit or autofix one, and whenever a CI failure or a conflict notice arrives.
---

# Watch a pull request

## Subscribe, then stop polling

Call `subscribe_pr_activity(owner="jacobanana", repo="piggy", pullNumber=<n>)`
once, then end the turn. Events arrive as wakes; no `sleep`, no re-check
loops. Webhooks miss things, so if `send_later` is available, schedule one
check-in about an hour out; when it fires, re-check state, act, re-arm
silently. Stop when the PR is merged or closed, or when asked to.

## A red check is diagnosed, never re-run hopefully

Get the failing job log first. Reproduce locally:

| Failing job | Reproduce with |
| --- | --- |
| checks (ruff / mypy / tsc / vitest) | `bash scripts/checks.sh` |
| backend tests | `bash scripts/await_ready.sh && uv run pytest` |
| frontend build | `cd frontend && npm run build` |

"Flaky" is a last-resort diagnosis reserved for jobs that died before any
test body ran (checkout, install, lost runner) — those get one re-run.
Never make a test pass by weakening it: no skips, no loosened assertions,
no inflated timeouts. If the test is wrong, that's a conversation in the
thread, not a silent edit.

## Conflicts are resolved by merging main in

This repo merges PRs and never rewrites pushed history:

```bash
git fetch origin main && git merge origin/main
# resolve; package-lock.json and uv.lock are regenerated, not hand-merged
bash scripts/checks.sh && uv run pytest
git push
```

If a migration came in on both sides: `uv run alembic heads` — two heads
means re-chain yours (edit its `down_revision`), don't add a merge migration.

## Red on main too?

Check before spending an afternoon: `git stash && git checkout main &&
git pull && bash scripts/checks.sh`. If main is red, say so once in the
thread and act when the recovery notice arrives.

## What goes in the thread

Reply when a round resolves the task, hits a real blocker, or raises a
question — not on every push. Don't reply to your own comments coming back
as events.
