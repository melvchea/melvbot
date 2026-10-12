# changelog

## Unreleased

### changes

- web pages are cached 1h by normalised URL in the conversation DB (`page_cache`) and in memory; `webFetch`, `webx extract|ask` and the Telegram web_fetch tool share it; errors and empty pages are not cached
- monthly call counters for Firecrawl and Bright Data (`web_quota`), limits `WEB_QUOTA_FIRECRAWL` (500) and `WEB_QUOTA_BRIGHTDATA` (5000), `WEB_QUOTA_BRAVE` (1000); a provider is skipped only at its limit or after a 402/429 until month end; counts shown in `doctor` and `status`
- `webx ask` skips the digest model call when the fetched sources total under 1500 chars and prints them directly
- web search is Kagi (`KAGI_SESSION_LINK`, HTML results scraped in-process in `providers/kagi_search.ts`), then Brave (`BRAVE_SEARCH_API_KEY`), then Firecrawl search; `SEARCH_PROVIDERS` takes `kagi`, `brave`, `firecrawl`; `SEARCH_HEDGE_MS` is gone
- page reads are Firecrawl scrape (`FIRECRAWL_API_KEY`), then Bright Data Web Unlocker (`BRIGHTDATA_API_KEY`, `BRIGHTDATA_ZONE`), then in-process fetch; the websrchfetchd sidecar is removed (Go code, headless Chrome and its `/fetch`, `/fetch/batch` and `/search` endpoints)
- remove the MiniMax search provider, the `search_watch` sidecar alerts and the web_fetch batch call; web search no longer returns a Quick answer line
- maintenance: the daily Chrome check and its report line are removed; `WEBSRCHFETCHD_URL` is no longer read by melvbot
- prefetch Daily Update Calendar/Tasks/news on `daily_update` kind only; drop leftover Google `.sh` basename routing
- drop leftover Codex, Claude, OpenCode, and Pi dummy engine ids from tests, docs, and onboarding preview
- remove the one-shot Codex/Claude/OpenCode/Pi engine migration and `melvbot migrate-engines`

### fixes

- only offer and bind Cursor sessions the warm SDK can resume, recheck picker Yes before dispatch, and tell Telegram when a prompt had to start fresh after a stale resume

