# Use melvbot

Commands and instant phrases are in [Commands & directives](../reference/commands-and-directives.md).

## Voice messages

A voice message is transcribed with Groq `whisper-large-v3-turbo` (`GROQ_API_KEY`) and handled like text. With `tts_auto = "voice"` the reply is also sent as a voice note (Google Cloud TTS, `tts_voice`). `tts_enabled = false` turns spoken replies off. See [Configuration](../reference/config.md).

## Photos

Send a photo, then ask for its text (OCR) or ask about it. Photos are read with MiniMax-M3 (`MINIMAX_API_KEY`), up to 10 MB (JPEG, PNG, GIF, WebP). Captions are answered without thinking.

## Text files

Attach `.csv .tsv .txt .json .md .log` (up to 512 KB). The first 60,000 characters are added to your message, defaulting to "Analyze this file."

## Schedule tasks

Jobs live in `cron_jobs.db` and run as systemd timers, each calling `melvbot cron run-once <id>`. To rerun one by hand from the host, use `drun "result" docker exec melvbot melvbot cron run-once <id> --force`.

```bash
docker exec melvbot melvbot cron list
docker exec melvbot melvbot cron add --name "Weekly review" --schedule "0 9 * * 1" --prompt "Summarise my week"
docker exec melvbot melvbot cron disable <id>
```

Changing jobs from chat asks for a Confirm tap. Cron turns never use the chat fallback: if Claude is unavailable the job fails and is reported. Telegram's own **Schedule Message** works for one-off messages.
