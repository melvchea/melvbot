---
name: reminders
description: Use when the user asks to be reminded/notified about something, or when deciding whether a reminder belongs in cron_jobs.db, Google Tasks, or Google Calendar.
always: true
---

# Reminder routing

- Clock-time one-off ("remind me at 3pm…", "tomorrow 9am…") → `google calendar create --summary T --start ISO --reminder` (end defaults to +15 min).
- Appointment or time block → plain `google calendar create` (Telegram heads-up 30 min before).
- Date only → `google tasks create "TITLE" --due YYYY-MM-DD`.
- Recurring → `cron add` (`kind: agent` row: schedule + prompt). `schedule` is five-field cron; a weekday list is `1,2,3,4,5`. Never a Telegram timer. A fixed bullet list is rendered in code with no model turn when its prompt keeps the existing shape (`Start with one title line: Weekly reminder for…` or the monthly `send only this Nth-of-month list`); use free-form `agent` rows only for tasks that need prose.
- A Sheet is never a reminder. A dated reminder seen while discussing a Note is a Task or Calendar entry, never a Note write.
- "reminders" is answered with no model turn; if it reaches you, run `cron list`, `google calendar list` and `google tasks list`, grouped as Recurring, Upcoming 7 days, Tasks.
- To find one by name, run `google calendar list --query X` and `google tasks list --query X` together with one keyword. Plain lists cover only 7 days / 20 tasks, so empty is not "not found".

## Keep every reminder aligned

- One home per item: before adding, run the `--query` lookup above; if it exists in another store, amend it, never add a second. A timed item is a Calendar event, not also a Task. Monthly bullets live only in the Saturday Reminder prompt, read by the single "Monthly reminders from the Saturday Reminder job" row.
- Telegram is the only alert channel: no Google popups; the must-not-miss timed items use `--reminder`.
- A Task's due date is its real date; put any lead time in the title (e.g. "start 1 week before"). Do not move the due date earlier, and the 19:15 sweep is the only Task notification. Undated Tasks never alert; give them a date.
- Messages follow the `Title Ddd D Mon HH:MM` header (CLAUDE.md). Avoid 07:00-07:45, 19:00 and 22:45-23:00 for new jobs; those slots are taken. Sunday 05:30 (`30 5 * * 0`, kind `backup`) is the weekly backup: silent on success, Telegram alert only on failure.
- Weather posts every hour 06:00-22:00 SGT (`0 6-22 * * *`), whatever the rain or PM2.5.

Mutate Tasks/Calendar only if asked this turn. To amend an entry, list first and match by title and date; if several match, ask which.

Only `agent` cron jobs can be changed; `daily_update`, `afternoon_weather`, `outlook_digest`, `maint_report`, `shopee`, `idle_reset`, `backup` change from the host CLI. Every `cron add|update|enable|disable|delete` needs a Confirm tap; a cron-sourced turn is refused.
