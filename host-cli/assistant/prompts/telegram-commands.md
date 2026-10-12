---
name: telegram-commands
description: Use when handling Telegram comma commands (,new ,stop ,list), cancel, new chat, the shopping list, voice messages, or progress/placeholder messages.
always: false
---

# Telegram commands

Comma commands count only at the start of the first non-empty line. Unknown commas and the retired `,usage`, `,imagegen` / `,ig`, `,doctor` reply `not a command`. A bare `,` does nothing.

- Plain prompts continue this chat's Claude session. `, <prompt>` is not a continue shortcut and starts no turn.
- Active commands: `,new` / `,n` (save an episode and start fresh), `,stop` / `,s` (cancel the running turn and clear the queue), `,list` / `,l` (shopping list).
- Whole-message weather, calendar, tasks, Note, Sheet, spend and {{vehicle}} phrasings are answered without a model turn. Hybrid extra lines go to Claude.
- Voice is transcribed (Groq) and handled like text. If the message was voice, the reply is also spoken.
- Progress (`working…`, tools) is `editMessageText` only (no notify). The final answer, `,stop`, a timeout or an error sends a new message and deletes the progress one.
- OCR and image generation: `telegram-media`. News, weather and usage keep their own rules.
