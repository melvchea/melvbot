# Architecture

Product code is TypeScript under `ts/src`. The container runs `node /opt/melvbot-ts/dist/index.js` (`melvbot-ts:latest`).

```mermaid
flowchart TB
    tg[Telegram Bot API] <--> poller[daemon.ts: poll, commands, progress]
    poller --> prose{{"prose handlers (weather, calendar, tasks, notes, sheets)"}}
    poller --> turn[turn.ts]
    turn --> recall[recall + system prompt cache]
    turn --> claude[claude_session.ts: Claude Agent SDK, Haiku 5.5]
    claude --> tools["in-process MCP tools: melvbot_cli, read_rule, web_search, web_search_read, web_fetch, offer_save"]
    turn -. "Claude unavailable" .-> fallback[fallback.ts: Groq, then MiniMax, read-only]
    tools --> google[Google Docs, Sheets, Calendar, Tasks]
    tools --> kagi[Kagi search, HTML results scraped in-process]
    tools --> brave[Brave Search]
    tools --> firecrawl[Firecrawl search fallback and scrape]
    tools --> bd[Bright Data Web Unlocker fetch fallback]
    cron[cron run-once] --> turn
```

## One chat turn

1. The poller receives a message. Comma commands and whole-message phrasings (weather, calendar, tasks, note and sheet lists) are answered directly, with no model.
2. Otherwise `turn.ts` runs three things in parallel: an optional web-search prefetch, note recall (best FTS match from the cached index), and the system prompt (cached, refreshed in the background).
3. `claude_session.ts` runs one Claude Agent SDK `query()`. A chat's session is continued with `resume`; its transcript lives under `~/.claude` on the runtime volume.
4. The agent has no built-in tools. It can only call the `melvbot` MCP tools. Confirmation gating and the untrusted-content write guard run inside those tools.
5. If Claude is unavailable (limit, login, overload), the turn degrades to a read-only answer from Groq or MiniMax, with a notice. Cron turns fail loudly instead.

## Reminders

Google stores, Telegram alerts. Calendar and Tasks hold the data; melvbot-created events carry a private `melvbot=reminder|event` tag and no Google popup. A background ticker (`src/reminders/ticker.ts`, started by the poll loop) fetches tagged events every 5 minutes and checks the cache every minute: a reminder pings at its start with Done / Snooze buttons (`rm:` callbacks patch the event in Google), an appointment pings 30 minutes ahead. Sent alerts are deduped in `nudges.sqlite3`. At 19:15 SGT it lists tasks still due or overdue with Done / Tomorrow buttons (`tk:`), gated by `[nudges] task_evening`. One formatter (`src/reminders/format.ts`) renders the Morning Update data, agenda replies, alerts and the `reminders` listing.

## Memory layers

| Layer | Where | Lifetime |
|-------|-------|----------|
| Working | Claude session transcript | Until 15 minutes after your last message, or `idle_reset_hours` |
| Episodic | Snapshot saved when a session ends | Injected into the first turn of the next session |
| Semantic | Google Docs notes, indexed in SQLite FTS | Permanent; best match injected per turn |
| Structured | Google Sheets (spend, EV, rules) | Permanent |

## Module map

Live TypeScript tree under `ts/src`. `index.ts` dispatches the CLI (`doctor`, `sheet`, `note`, `google`, `outlook`, `cron`, `memory`, `web`) or starts the poller.

| Area | Modules | Responsibility |
|------|---------|----------------|
| Entry | `index.ts`, `daemon.ts` | CLI dispatch; Telegram long-poll loop, commands, progress edits |
| Telegram | `telegram/api.ts`, `commands.ts`, `progress_edits.ts`, `outbox.ts`, `agenda_prose.ts`, `prose_intercept.ts`, `date_prose.ts`, `weather*.ts`, `shopping_list.ts` | Bot API, command parsing, rate-limited edits, model-free replies |
| Agent | `assistant/claude_session.ts` | One Agent SDK `query()` per turn, resume, idle sweep, unavailable backoff |
| | `assistant/turn.ts` | Turn orchestration, audit log, fallback hand-off |
| | `assistant/custom_tools.ts`, `tools.ts` | MCP tools, CLI allowlist, web search/fetch, confirm and write guards |
| | `assistant/system_prompt.ts`, `recall.ts`, `recall_index.ts` | Prompt build and cache refresh, note recall |
| | `assistant/fallback.ts` | Read-only Groq/MiniMax degraded mode |
| | `assistant/web_content.ts` | HTML to markdown, size cap, TTL caches |
| Notes | `note/*` | Google Docs notes; `read_cache.ts` is a 30 s read cache |
| Sheets | `sheet/*` | Spend, EV, rules |
| Google / Outlook | `google/*`, `outlook/*` | Calendar, Tasks, token handling, mail digest |
| Reminders | `reminders/*`, `nudges/*` | Ticker, formatter, proactive nudges |
| Media | `media/*` | Groq STT, MiniMax vision and images, Google/MiniMax TTS |
| Cron | `cron/*` | Job store, `run-once`, morning update (rendered in code from the Google prefetch, no LLM), DCA jobs (data prefetched in code, one tool-free Claude write-up) |
| Health | `doctor.ts`, `session/turn_lock.ts` | Checks and the turn lock |
