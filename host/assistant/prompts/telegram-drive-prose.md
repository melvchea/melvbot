---
name: telegram-drive-prose
description: Use when handling Telegram Note or Sheet list, rename, create, or delete prose.
always: false
---

# Note and Sheet prose

A saved Doc is a Note. {{owner1}}, {{owner2}} and {{vehicle}} are Sheets. Whole-message Note / Sheets prose (trailing `.!?` ok) never starts an agent turn. The Telegram message says Note or Sheets.

**Notes**
- `list notes` / `list my notes` / `show notes` / `my notes` (also `list docs` / `list google docs`): one clickable `slug — Title` line per Note (opens the Doc), or `No Notes.`
- `combine Notes <slug-or-title> and <slug-or-title> to <new-slug>` / `merge notes …`: Confirm | Cancel. Creates the new Note, or replaces the target if that slug already exists (source Notes stay pinned). Omitting `to <new-slug>` prompts for the slug.
- `show google doc link to <slug-or-title>` / `link to <slug-or-title> note`: one Drive edit URL.
- `rename note|doc|google doc <slug-or-title> to <phrase>` (also `rename the <x> note|doc to …`, `retitle …`, `change the title of <x> note|doc to …`; needs an explicit new title): renames the Google Doc in Drive (file name + title; slug unchanged).
- `delete note <slug-or-title>`: refuses procedure slugs (`phone-buy`, `ev-buy`, `family-eat`, `sim-card-plan`); others confirm Delete | Cancel.

**Sheets**
- `list sheets` / `show sheets` / `my sheets` (also `list google sheets`): one clickable {{owner1}}/{{owner2}}/{{vehicle}} line per pinned Sheet (opens the spreadsheet), or `not yet created` with no link.
- `show google sheet link <{{owner1}}|{{owner2}}|ev>` / `link to <{{owner1}}|{{owner2}}|ev> sheet`: one Drive edit URL.
- `rename sheet <{{owner1}}|{{owner2}}|ev> to <phrase>`: renames the Google Sheet file in Drive.
- `create`/`delete` sheet prose for a named sheet (`create {{owner1}} sheet`, `create {{owner2}} sheet`, `create ev sheet`): confirm Create new | Delete existing | Cancel. Create new = empty spreadsheet + pin; Delete existing refuses (pins cannot be empty).
