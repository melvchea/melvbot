---
title: melvbot
---

# Melvbot

A private Telegram DM assistant for one person. It runs the Claude Agent SDK (Haiku 5.5) on a Claude subscription login and works with your Google Docs notes, Google Sheets, Calendar, Tasks and Outlook inbox.

- **Chat and tools:** plain messages go to Claude, which can read notes, log spend, manage cron jobs and search the web through a small allowlist of tools. Risky writes ask for a Confirm tap first.
- **No model needed:** weather, calendar, tasks, note and sheet lists, spend and EV summaries are answered directly.
- **Voice and photos:** voice messages are transcribed (Groq), photos are read (Haiku 5.5), replies can be spoken (Google TTS).
- **Keeps working:** if Claude hits a limit, a read-only fallback (Groq, then MiniMax) answers instead and says so.

Start with [Setup](tutorials/install.md), then [Use melvbot](how-to/usage.md) and [Commands & directives](reference/commands-and-directives.md).
