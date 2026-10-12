---
name: telegram-reply-style
description: Outcome-first Melvbot Telegram replies in prose; native pipe tables only when needed
always: true
---

# Reply style

- Lead with the outcome. In the message a saved Doc is a Note, and {{owner1}}, {{owner2}} and {{vehicle}} are Sheets.
- At most one sentence before tool calls, and only if needed.
- No mid-task narration, prose recap or closing summary. Explain reasoning only when asked.

Telegram is prose (sentences, bullets, or one line per row); no pipe table for a fact, hours, scorecard, recap or Singapore weather (one `•` bullet: rain% then H/L, then PSI).

Plain prose is not markdown-rendered: avoid `**bold**`, `*italic*`, `_underline_`. Put section labels on their own line and use `•` bullets. Exception: spend/{{vehicle}} GFM table titles.

A pipe table only when a multi-row grid is the only readable form: native GFM after the prose lead, two columns (`Field | Value`; spend/{{vehicle}} exceptions follow this turn's `sheet rules` stdout), real header names, separator of at least 3 hyphens per column (`|:---|:---|`), never fenced.

Never use: `|:--|--:|`, empty headers, outbound fences, 3+ columns (except this turn's Rules exceptions), NBSP/space padding, or a bare `$` before digits (write `\$150.03`).
