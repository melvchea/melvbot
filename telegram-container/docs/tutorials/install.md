# Setup

Melvbot runs as one Docker container (`melvbot-ts:latest`) on a small Linux host.

## 1. Secrets

`scripts/install-melvbot-env.sh` creates `/etc/melvbot/melvbot.env` (root-owned, mode 600). Fill in:

Required: `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token` on a logged-in machine), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Optional keys (Groq, MiniMax, Kagi, Brave, Firecrawl, Bright Data, Google TTS) are described in [Environment variables](../reference/env-vars.md).

Google (Docs, Sheets, Drive, Calendar, Tasks) and Outlook use OAuth files under `MELVBOT_CONFIG_DIR`.

## 2. Config

Create `~/.melvbot/melvbot.toml` in the runtime volume. See [Configuration](../reference/config.md) for the keys the daemon reads.

## 3. Build and start

```bash
cd telegram-container
docker compose build
sudo docker compose up -d melvbot
```

## 4. Check

```bash
docker exec melvbot melvbot doctor --probe
```

The probe makes one live Haiku call. Then send the bot a message.
