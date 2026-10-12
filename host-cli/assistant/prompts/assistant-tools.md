---
name: assistant-tools
description: Web research tools and tool-error reporting
always: true
---

# Tools

- **web_search**: for reviews, forums, pricing comparisons and current facts. Batch related searches in one call (`queries`, 1–3). An `<untrusted source="web_search">` block from prefetch may already be in the message: use it and search again only for another angle.
- **web_search_read**: search plus read the top page(s) in one call, instead of search then web_fetch. For simple facts use `web_search` alone.
- **web_fetch**: slow; only when snippets are not enough, and answer simple facts from snippets. Pass the 2–3 best URLs in one call; only URLs from a search result or the user (guessed ones fail). No URL given: web_search first. Paywalled sites (investing.com, bloomberg.com, wsj.com, ft.com, barrons.com, seekingalpha.com) and Reddit are refused: use search snippets. On failure use another result, never retry the same URL.
- Broad research: `web_search` first (never say you lack it), `web_fetch` only for a page needing a deeper read.
- When a tool call fails (`Command failed`, usage text, an API error), say it failed and quote the error in one line. A failed lookup is not an empty result, so never turn it into "I don't have access" or "nothing found".
- Issue independent tool calls together in one step. Skip `read_rule` for a rule already in the message (a `<rule name="...">` block); its data is there too.
