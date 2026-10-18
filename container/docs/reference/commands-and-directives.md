# Commands & directives

Only your configured chat (`TELEGRAM_CHAT_ID`) is served.

## Comma commands

A comma command must start the first non-empty line.

| Command | Does |
|---------|------|
| `,new` / `,n` | Save an episodic snapshot and start a fresh session |
| `,stop` / `,s` | Cancel the running turn and clear the queue |
| `,list` / `,l` | Show the shopping list |
| `,restart` / `,r` | Replies "Restarting…", persists the update offset, then exits non-zero so Docker restarts the container; posts "Back online." after boot |
| `,status` / `,st` | Non-LLM status: version and uptime, doctor summary (no probes) with non-ok checks, brave usage, reminder ticker and alerts sent today, turns today by route |
| `,help` / `,h` | Lists the comma commands and the main instant phrases (generated from `COMMAND_TABLE` in `telegram/commands.ts`) |

An unknown comma word replies `Unknown command ,word`; the old `,usage`, `,imagegen`/`,ig` and `,doctor` were removed and now get the same reply. A bare `,` does nothing.

## Handled without Claude

Whole-message phrasings (trailing `.!?` is fine):

- **Weather:** `weather`, `singapore weather`, `afternoon weather`
- **Calendar:** `calendar`, `what's on today|tomorrow|this week`, `schedule tomorrow`
- **Tasks:** `tasks`, `my to-do list`
- **Reminders:** `reminders`, `what reminders do I have` (Recurring jobs, Upcoming 7 days incl. family calendar, Tasks)
- **Notes:** list
- **Sheets:** list; `spend` and `EV` summaries
- **Media:** OCR of the last photo

Anything else (longer requests, writes, questions) goes to Claude.

Voice, photos and text files are covered in [Use melvbot](../how-to/usage.md).

## Confirm taps

These always ask for Confirm: new, About-me or house-rules note writes, note delete, spend or EV void, sheet rule changes, cron add/update/enable/disable/delete, calendar or task delete. Large or duplicate-looking spend entries ask too.

## Host CLI

`docker exec melvbot melvbot <command>`:

| Command | Does |
|---------|------|
| `doctor [--probe]` | Health checks; `--probe` makes a live Claude call |
| `note list\|get\|add\|describe\|delete\|restore\|append-history\|replace-section` | Notes |
| `note rename <slug> <title...>` | Renames the Google Doc in Drive (file name + title; slug unchanged); undoable via `memory undo`, no Confirm |
| `sheet rename <owner1\|owner2\|ev> <title...>` | Renames the Google Sheet file in Drive |
| `sheet rules\|spend\|ev\|pin ...` | Sheets |
| `google calendar\|tasks list\|create\|update\|delete` | Calendar and Tasks; `calendar create --reminder` makes a Telegram-pinged reminder (end defaults to +15 min); `calendar list` without `--calendar` merges primary and family |
| `outlook inbox` | Mail digest |
| `cron list\|get\|add\|update\|enable\|disable\|delete\|run-once\|prune-slots` | Scheduled jobs |
| `memory undo` | Undo the last memory write |
| `web search\|extract\|ask ...` | Web search and page extraction that return a short digest from Groq/MiniMax (used by the host `webx` wrapper) |

## Observability

Every handled comma command and prose intercept logs `intercept <name>` and writes a `turn_log` row with route `intercept:<name>` and no prompt text. `melvbot turns` / `dturns` show per-route counts on the last line, so unused instant features are visible. Instant replies time out after 25 s with a short error message.
