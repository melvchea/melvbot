# Environment variables

Set in `/etc/melvbot/melvbot.env` (root-only) and injected by Docker Compose.

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude subscription token (`claude setup-token`). `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from the agent on purpose. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Bot token and the single chat it serves. |
| `GROQ_API_KEY` | Voice transcription and the first fallback provider. |
| `MINIMAX_API_KEY` | Video reading, video generation, second fallback provider, and optional TTS. Token Plan ends 28 Apr 2027; renew before then. |
| `KAGI_SESSION_LINK` | Kagi session link (`https://kagi.com/search?token=...`, from Kagi settings). First web search provider; unset skips Kagi. Melvbot exchanges it for a `kagi_session` cookie and reads `/html/search`; three failed or empty searches in a row skip Kagi for 15 min. |
| `FIRECRAWL_API_KEY` | Firecrawl key: last web search provider (after Kagi and Brave), and the first page-read step (`/v2/scrape`). |
| `BRIGHTDATA_API_KEY` | Bright Data Web Unlocker key: second page-read step after Firecrawl (HTML run through the in-process extractor). Unset skips it. |
| `BRIGHTDATA_ZONE` | Bright Data Web Unlocker zone name sent with each `/request` call. |
| `SEARCH_PROVIDERS` | Comma list in order from `kagi`, `brave`, `firecrawl` (default `kagi,brave,firecrawl`). |
| `BRAVE_SEARCH_API_KEY` | Brave Search key, second web search provider (after Kagi). Unset skips Brave. |
| `BRAVE_COUNTRY` | Country code sent to Brave (default `ALL`; Brave rejects `SG`). |
| `BRAVE_MONTHLY_QUOTA` | Brave calls budgeted per month (default `1000`, the free $5 credit). Older name for `WEB_QUOTA_BRAVE`, which wins when both are set. |
| `WEB_QUOTA_FIRECRAWL` | Firecrawl calls per month before it is skipped for the rest of the month (default `500`). Counted for search and scrape; a 402 or 429 answer also skips it until month end. |
| `WEB_QUOTA_BRIGHTDATA` | Bright Data calls per month before it is skipped (default `5000`). A 402 or 429 answer also skips it until month end. |
| `WEB_QUOTA_BRAVE` | Brave limit per month (default `1000`), same as `BRAVE_MONTHLY_QUOTA`. |

| `GOOGLE_CLOUD_TTS_API_KEY` | Spoken replies. |
| `FAMILY_CALENDAR_ID` | Family calendar (default: profile.toml `family_calendar_id`) merged into agenda and reminder listings. |
| `MELVBOT_CONFIG_DIR` | Google/Microsoft OAuth files and state. |
| `MELVBOT_TOML` | Path to `melvbot.toml`. |
| `MELVBOT_PROMPTS_DIR` | Rule files (mounted from `host/assistant/prompts`). |
| `MELVBOT_WORKSPACE` | Workspace root (`/workspace`). |

Monthly counts are kept in the conversation DB (`web_quota`, `brave_usage`) and shown by `doctor` and `status`. Providers are skipped only at their limit or after a 402/429, not spread across the month. Fetched pages are cached there for 1 hour by URL (`page_cache`), so a repeat `web_fetch` skips the providers.
