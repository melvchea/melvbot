---
name: telegram-no-link-previews
description: Use when sending Telegram messages that contain URLs, or adding a raw sendMessage/editMessageText call.
always: false
---

# Telegram: no link previews

Set `link_preview_options: {"is_disabled": true}` (legacy: `disable_web_page_preview: true`) on every send. `TelegramApi` already sets `disable_web_page_preview`, so only a raw `sendMessage` / `editMessageText` outside it needs the flag. Headline link shape: `morning-update-format`.
