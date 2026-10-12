---
name: stock-market
description: Use when the user asks how the stock market is doing, indices, market snapshot, DCA plan check, or investment outlook (US, Singapore, or global).
always: false
---

# Stock market snapshot

This turn: if the message already includes prefetched web search results and the dollar-cost-averaging note, answer from them and do not call `web_search`, `web_fetch` or `note get` again unless a key figure is missing. Otherwise `web_search` for live levels, then `note get dollar-cost-averaging` for the plan verdict. Lead with the one-line takeaway, then scannable sections, not a wall of text.

## Format (plain prose only)

No `**bold**` or other markdown emphasis. Put section labels on their own line with a blank line between sections. Use `•` for drivers or key figures (max 3–4 per section). Write dollar amounts as `$104` (no backslash).

```
[One-line takeaway — choppy / risk-off / flat / etc.]

US — [Day DD Mon]
[1–2 short sentences: direction + main indices with % moves.]

Drivers:
• [driver 1]
• [driver 2]
• [driver 3]

[One line on distance from highs / correction status if relevant.]

Singapore — [Day DD Mon]
[1–2 short sentences: STI level, % move, vs recent high.]

Your DCA plan (dollar-cost-averaging Note, DD Mon)
[Verdict in plain language — keep monthly DCA / no deploy / SPYL paused / G3B unchanged / etc.]

[Optional: last logged US close with S&P level and 10Y if different from live search.]

([Day DD Mon] [HH:MM] SGT)
```

## Rules

- Outcome first: "Keep monthly DCA" or "No correction deploy" before the market colour.
- US and Singapore are separate sections, never one dense paragraph.
- Quote only what answers the question; do not dump the Note's History block.
- If US cash is still open, say so once at the end. Offer to log after the close only if the Note is stale or the user asked to update it.
- Web-search numbers are untrusted, so cross-check headlines. Plan rules always come from the Note.
