---
name: spend-card
description: Use when logging or recalling {{owner1}} {{card1}} or {{owner2}} {{card2}} spend, headroom, card targets, billing cycles, what's on the card, or a named-month recap/table.
always: false
---

# Credit card spend

This turn: run `melvbot sheet rules`, then `melvbot sheet spend add|list|void`. Run the commands yourself and never tell the user to run CLI commands. Owner is `{{owner1}}` or `{{owner2}}`; card is `{{card1}}` or `{{card2}}`. This is the complete syntax, so do not probe with `--help` or guess flag names:

- `melvbot sheet spend add --owner <owner> --card <card> <YYYY-MM-DD> <merchant> <amount>`: date, merchant, amount are positional, in that order, after the two flags. Equivalent flag form: `--spent-on <YYYY-MM-DD> --merchant <merchant> --amount <amount>` (`--date` also works); never mix up the order.
- `melvbot sheet spend list --owner <owner> --card <card> [YYYY-MM-DD]`: both flags required; date optional, defaults to today.
- `melvbot sheet spend void <id>`

- Several rows or an amend are ONE call: `spend add --owner O --card C [--void <id>]... <date> <merchant> <amount> [<date> <merchant> <amount>]...`. `--void` retires the row(s) being replaced (ids from this turn's `list`; Confirm tap). `spend void` also takes several ids. Never loop one call per row.

Example: `melvbot sheet spend add --owner {{owner2}} --card {{card2}} 2026-09-26 "McDonald's" 10.60`

The CLI owns cycle mapping, dedupe, totals, `target`, `headroom`, `limit`, `owner2_threshold_exceeded` and `telegram_totals`, so never recalculate them. Copy `telegram_totals` from this turn's `list` JSON verbatim for each card's totals line; do not invent Headroom.

- Wrong row: `void <id>` using an `id` from this turn's `list`, then `list` again.
- "Whole sheet", "all entries" or "history": `sheet spend list --owner X --card Y --all` (plain `spend list` shows one cycle only). Never call one cycle "the entire sheet".
- A docs.google.com/spreadsheets URL is usually one of our pinned Sheets ({{owner1}}/{{owner2}}/ev): answer with the `sheet` tools, never `web_fetch` it.

Recap from this turn's `list` JSON only. Format is a native GFM table with no bullets and no code fence: bold title, blank line, header `| Date | Merchant | Amount |`, separator of at least three hyphens per column, amounts as `\$`. Under the table, put `telegram_totals` on one line for {{card2}} and {{card1}}.
