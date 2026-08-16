---
name: app-screenshots
description: Run Piggy locally and photograph it with Playwright. Use whenever a frontend change has to be shown rather than described, or when asked to start, run or screenshot the app — seeds the book with real content and captures any screen at phone and desktop widths, no Docker required.
---

# Screenshot the app

A layout claim nobody can see is not evidence. Every visual change gets
screenshotted at the widths it crosses — before and after when the diff is
subtle.

## 1. Start the app

```bash
bash scripts/start_app.sh
```

Idempotent — reuses whatever is already answering. Prints the base URL
(also written to `.dev/base_url`). Logs land in `.dev/{backend,frontend}.log`;
stop with `bash scripts/stop_app.sh`. The frontend alone is enough for
screenshots — a failed backend only matters for auth/sync work.

## 2. Photograph it

```bash
node .claude/skills/app-screenshots/scripts/screenshot.mjs --seed --width phone --width desktop
```

| Option | Meaning |
| --- | --- |
| `--seed` | Load a realistic book (two people, bills, extras, a trip, a repayment) into localStorage before the shot. Without it you photograph the onboarding screen. |
| `--empty` | Explicitly photograph the onboarding screen. |
| `--width phone\|tablet\|desktop\|<px>` | Repeatable. phone=390, tablet=768, desktop=1440. |
| `--click <selector>` | Repeatable, in order — e.g. `--click '[data-act="settings"]'` to open a modal. |
| `--act <data-act>` | Shorthand for `--click '[data-act="..."]'`. |
| `--full-page` | Capture the whole scroll height. |
| `--name <slug>` | Filename prefix. |
| `--base <url>` | Override the base URL (default: `.dev/base_url`, then :5173). |

PNGs land in `.dev/screenshots/` and every written filename is printed —
read the images back and attach them with SendUserFile. An empty board
photographs as an empty board: seed first, then shoot the thing the change
is about.

Common shots:

```bash
# The month view, both widths
node .claude/skills/app-screenshots/scripts/screenshot.mjs --seed --width phone --width desktop

# Settings modal
node .claude/skills/app-screenshots/scripts/screenshot.mjs --seed --act settings --name settings

# Recurring bills manager
node .claude/skills/app-screenshots/scripts/screenshot.mjs --seed --act rules --name rules

# The add-expense form
node .claude/skills/app-screenshots/scripts/screenshot.mjs --seed --act add --act new-exp --name expense-form
```

## Troubleshooting

- Onboarding showing when you expected data → the seed didn't load; check the
  console errors the script prints.
- Nothing answering → `bash scripts/start_app.sh` first; check `.dev/frontend.log`.
- No browser → the script falls back through `PLAYWRIGHT_CHROMIUM_EXECUTABLE`,
  `/opt/pw-browsers/chromium`, and the system chromium before giving up.
