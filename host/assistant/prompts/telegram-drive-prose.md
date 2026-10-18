---
name: telegram-drive-prose
description: Use when handling Telegram Note or Sheet list, rename, create, or delete prose.
always: false
---

# Note and Sheet prose

A saved Doc is a Note. {{owner1}}, {{owner2}} and {{vehicle}} are Sheets. Whole-message Note / Sheets prose (trailing `.!?` ok) never starts an agent turn. The Telegram message says Note or Sheets.

**Notes**
- `list notes` / `list my notes` / `show notes` / `my notes` (also `list docs` / `list google docs`): one clickable `slug — Title` line per Note (opens the Doc), or `No Notes.`
- Combine, link, rename and delete of Notes are Claude turns (use the `melvbot note` CLI). Deleting refuses procedure slugs (`phone-buy`, `ev-buy`, `family-eat`, `sim-card-plan`).

**Sheets**
- `list sheets` / `show sheets` / `my sheets` (also `list google sheets`): one clickable {{owner1}}/{{owner2}}/{{vehicle}} line per pinned Sheet (opens the spreadsheet), or `not yet created` with no link.
- Sheet link, rename, create and delete are Claude turns (use the `melvbot sheet` CLI). Delete refuses pins that cannot be empty.
