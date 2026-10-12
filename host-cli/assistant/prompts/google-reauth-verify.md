---
name: google-reauth-verify
description: Use for Google Calendar or Tasks (list/create/delete/complete), today's agenda or task checks, and after a Google reauth (user pastes `http://localhost:1/?code=...` or auth succeeds).
always: false
---

# Google Calendar and Tasks

The live OAuth grant is **In production**. Weekly `invalid_grant` is revoke/password, not the Testing 7-day expiry. The Calendar/Tasks health check runs in host 3am maint (`daily-maint-google-auth.sh`), not a 07:00 `melvbot-cron-*` job.

Compose already exports `MELVBOT_GOOGLE_HOME`. Never put `google-home`, `melvbot-data/config`, or `/var/lib/melvbot/config/google-home` in Shell text; if Shell is denied for a google-home path, retry without naming that path.

This turn, run `melvbot google …`:

1. `melvbot google calendar list --start "$(TZ=Asia/Singapore date +%FT00:00:00%:z)" --end "$(TZ=Asia/Singapore date -d tomorrow +%FT00:00:00%:z)" --max 30`
2. `melvbot google tasks list --max 20`

Mutate (`calendar create|delete`, `tasks create|complete|delete`) only when the user asked this turn; an auth check alone is not enough. Example: `melvbot google tasks create "TITLE" --due 2026-11-27T00:00:00.000Z`. Reminder shape: the `reminders` rule. Run the commands yourself and never tell the user to add the task by hand.

Report auth, at most 3 Calendar events and at most 3 `needsAction` tasks. On failure include the exact API error.
