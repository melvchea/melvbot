# Configuration

`~/.melvbot/melvbot.toml` (in the runtime volume; `MELVBOT_TOML` overrides the path). Secrets never go here; see [Environment variables](env-vars.md).

```toml
[transports.telegram]
tts_enabled = true
tts_provider = "google"        # google | minimax
tts_voice = "en-GB-Standard-C"
# tts_model = "..."            # MiniMax TTS model, used when tts_provider = "minimax"
tts_auto = "voice"             # off | voice | always

[assistant]
model = "claude-haiku-5-5"     # non-claude ids fall back to this
reasoning = "low"              # off | low | medium | high
idle_reset_hours = 6

[sheets]
owner1_spreadsheet_id = "..."
owner2_spreadsheet_id = "..."
ev_spreadsheet_id = "..."

[notes]
"slug" = "<Google Doc id>"

[nudges]
headroom = true
ev_interval = true
spend_gap = true
digest_log = true
save_offer = true
monthly_review = true
task_evening = true           # 19:15 SGT task list
nagoya_countdown = true       # Heads up: 30/14/7/3/1 days to the first upcoming date in Note nagoya-dec-2026
task_deadline = true          # Heads up: open Tasks due in 1-7 days
match_day = true              # Heads up: day-of and day-before lines from Note watch-list
monthly_review_job_id = "..."
```

## `[assistant]`

| Key | Meaning |
|-----|---------|
| `model` | Claude model id. Haiku 5.5 is the default ($0.10 in / $0.50 out per MTok, cache read $0.01; 5× above 100K-token prompts). |
| `reasoning` | Session effort (default `low`): `low`, `medium` or `high` run adaptive thinking at that effort; `off` disables thinking. Higher is slower and uses more quota. A turn runs at effort `medium` (with `off`: a 4096-token thinking budget) for that turn only when the text starts with `think:` (prefix stripped) or matches a complex-prose rule (compare/vs, pros and cons, which is better, plan my/a/the, step by step, why does/is/do/did/would, calculate/total cost, should I ... or, trade-offs, remember/note down/add to note/update…note/edits to house rules or about me) or is over 300 chars or has two questions; `,commands`, intercepts and media never trigger. `turn_log` records `thinking` and `think_rule` (`melvbot turns` shows `think=`). |
| `idle_reset_hours` | A chat session older than this starts fresh. |

## `[notes]`

Maps a note slug to its Google Doc id. `about-me` and `house-rules` are loaded into every system prompt; other notes appear in the index and are recalled by relevance.

## `[nudges]`

Boolean switches for proactive messages: `headroom`, `ev_interval`, `spend_gap`, `digest_log`, `save_offer`, `monthly_review` (job id in `monthly_review_job_id`) and `task_evening` (19:15 SGT list of tasks due or overdue; see [Architecture](../explanation/architecture.md#reminders)). `task_evening` defaults to on. `nagoya_countdown`, `task_deadline` and `match_day` add lines to the Morning Update Heads up block; `match_day` reads one `YYYY-MM-DD text` line per match from the Note `watch-list`, which you create.
