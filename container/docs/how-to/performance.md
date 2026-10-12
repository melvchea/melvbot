# Assistant performance (Melvbot)

Melvbot's TypeScript daemon is the only conversational backend. It runs the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) with `claude-haiku-5-5` at adaptive thinking, effort `low` by default (effort `medium` only for `think:` or complex-prose turns). `claude_session.ts` runs one `query()` per Telegram turn; the SDK spawns a native `claude` subprocess for it (about 1.5 s of startup, about 220 MiB peak).

## Sessions

Each chat's session id lives in `claude_sessions` (chat_key → session_id → last_used_at). The next turn passes it as `resume`, and the transcript under `~/.claude` (on the HOME volume) is the conversation window. A session ends 15 minutes after its last user prompt (idle sweep, saving an episodic snapshot first), after `idle_reset_hours`, or on `,new`. Cron turns (`chatKey: null`) never persist or resume.

## Auth

- Set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the environment, or have `~/.claude/.credentials.json` in the runtime HOME.
- `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from the agent's environment, so turns only run on the subscription login.

```bash
docker exec melvbot melvbot doctor          # expect: assistant provider: ok
docker exec melvbot melvbot doctor --probe  # one live Haiku call
```

## Tools

The session's built-in toolset is empty (`tools: []`, `settingSources: []`, `permissionMode: "dontAsk"`). Only the in-process `melvbot` MCP server is allowed: `melvbot_cli`, `read_rule`, `web_search`, `web_search_read`, `web_fetch`, `offer_save` (`custom_tools.ts`). `web_search` takes `queries` (1-3, run in parallel, grouped per query) or `query`; `web_search_read` searches and reads the top 1-2 result pages in one call. Confirmation gating and the untrusted-content write guard run inside those tools.

## What keeps turns fast

- **System prompt cache:** the notes index, About-me, house rules and procedures are cached for 5 minutes and rebuilt in the background every 4 minutes (`system_prompt.refresh` in the logs), so a message never waits on Google. Turns use `buildSystemPromptFrozen()`: the built prompt is reused for 60 minutes so note edits don't respawn the live session and rewrite the prompt cache; note add/delete/restore/rename reset it. Note bodies are fetched 6 at a time.
- **Prompt caching:** the system prompt is byte-stable between turns, so the API serves it from cache. Keep volatile content (recall, episodic memory) in the user message.
- **Note reads:** `note get` and `note list` from the model are served in-process from a 30 s cache. Any other `melvbot` call clears it.
- **Recall:** the best-matching Note is injected from the cached index (SQLite FTS5 plus lexical scoring), with no extra Docs round trip.
- **Parallel pre-steps:** web prefetch, recall and the system prompt are resolved together before the agent starts.
- **No model for common reads:** weather, calendar, tasks and note/sheet lists are answered directly (see [Commands & directives](../reference/commands-and-directives.md)), costing no Claude quota.

## Reviewed, no action

Checked 2026-10-11 on `turn_log` (307 Claude turns since 2026-10-02); don't re-investigate unless the numbers change.

- **Memory (notes and recall):** healthy. 15 notes, 2 recall misses in 307 turns, recall adds at most about 1.2K chars per turn, context averages 21K tokens (max 56K, 12 turns over the 40K reset limit). Leave the notes, `MIN_RECALL_SCORE` and `RESUME_CONTEXT_TOKEN_LIMIT` as they are.
- **1-hour prompt-cache TTL:** rejected. Turns after a 5-60 min gap (62 of 307) re-write about 11K tokens against about 4K under 5 min, but the 1h write price is 1.6× ($0.20 vs $0.125 per MTok) on every write, so the saving (about $0.05 per 10 days) roughly equals the extra cost, and gaps over 1h (45 turns) stay cold either way.

## Web tools

`web_search` (Kagi first, then Brave, then Firecrawl; 8 results, each snippet capped at 250 chars at a word boundary; tracking params and fragments stripped from URLs and duplicate URLs dropped within and across a batched call's queries) is cached for 10 minutes by query, and `web_fetch` for 5 minutes by URL. Fetched pages are reduced to the main article as markdown (nav, footer and scripts dropped; external links kept up to 25) and capped at about 8k tokens. A search is prefetched before the agent only for open-web phrasings such as reviews, forums, `vs`, alternatives; it is skipped when the message is about your own notes, sheets or spend, because prefetched web text marks the turn untrusted and blocks its writes.

## When Claude is unavailable

On a usage limit, expired login or overload, a live chat turn degrades to a read-only answer from Groq (`qwen/qwen3.8-27b`), then MiniMax-M3, with a notice and no tools. After such an error the bot skips Claude for 5 minutes (or until the reset time) and then probes again. Cron jobs fail loudly instead. The daily maintenance run also probes the Claude login.

## Host resources

The **target** host is **1 vCPU / 4 GiB** RAM. `docker-compose.yml` requests `cpus: "1.0"`, `mem_limit: 3g` and `memswap_limit: 3g` (equal to the cap, so the container cannot page into host swap and stall on 1 vCPU). Idle RSS is about 55 MiB; a turn peaks near 220 MiB. Pid 1 is `node --max-old-space-size=384` with `MALLOC_ARENA_MAX=2` and single-thread ONNX/BLAS. `/tmp` is a 32m tmpfs; keep `TMPDIR` on a disk-backed path (entrypoint sets `/workspace/.melvbot-tmp`).

The runtime image has only `ca-certificates` on top of Node (no ffmpeg, git, ripgrep, procps or curl). Voice STT/TTS go through APIs that return OGG directly.

Watch **`MemAvailable`**, not `MemFree`. **Never `docker stop melvbot`** — recycle only via `melvbot-compose` after compose edits. Compose json-file logging is capped at **10m × 3** files. Exit code **137** means OOM. Host swap: 2 GiB file behind zswap (zstd) at `vm.swappiness=60`, so idle pages compress in RAM; do not add zram.

Durable facts belong in **`melvbot note add`**, not in the system prompt.
