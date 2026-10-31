# Troubleshooting

```bash
docker exec melvbot melvbot doctor --probe   # checks config, notes and sheets, rule prompts and the Claude login; `--probe` adds one live Claude call
docker logs --tail 100 melvbot
```

| Symptom | Check |
|---------|-------|
| Replies start with "⚠️ Claude is unavailable" | Usage limit or login problem. The bot retries Claude every 5 minutes. Run `doctor --probe`; renew `CLAUDE_CODE_OAUTH_TOKEN` if the login expired. |
| `assistant provider: error` | No Claude login. Set `CLAUDE_CODE_OAUTH_TOKEN` in `/etc/melvbot/melvbot.env` and restart. |
| `doctor` web search line shows `kagi breaker open` or `kagi not configured` | Kagi session link is unset or no longer accepted, so searches fall back to Brave (1000/month quota) and Firecrawl. Put a fresh session link in `KAGI_SESSION_LINK` in `/etc/melvbot/melvbot.env` and run `ddeploy`. The breaker retries Kagi after 15 min. |
| First message after quiet is slow | Watch `system_prompt.refresh` in the logs; Google is slow when the cache is cold. |
| Voice fails | Missing `GROQ_API_KEY`. |
| Photo fails | Claude login/quota problem; check `melvbot doctor`. |
| Video fails | Missing `MINIMAX_API_KEY`. |
| No web results | Kagi, Brave and Firecrawl search all failed, are unavailable or have no key (doctor `web search` check). Pages go Firecrawl, then Bright Data (`web_fetch: ... trying next` lines show each step), then in-process. |
| Can only copy a whole reply, not some words (Android) | Not a bot setting; replies are plain text. In Telegram for Android, long-press once to select the message, then long-press a word again to get selection handles; drag them and tap Copy. Close the keyboard first, or Copy won't show. Table replies are sent as rich messages and may not allow partial selection. |

The daily maintenance run also probes the Claude login and reports failures.
