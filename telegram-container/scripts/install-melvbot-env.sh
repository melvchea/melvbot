#!/usr/bin/env bash
# Install root-owned secrets file for docker compose env_file injection.
set -euo pipefail

DEST=/etc/melvbot/melvbot.env

sudo mkdir -p /etc/melvbot

sudo tee "$DEST" > /dev/null <<'EOF'
# Secrets only — root-owned mode 600; injected via docker compose env_file
CLAUDE_CODE_OAUTH_TOKEN=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
# Telegram voice transcription (Groq Whisper)
GROQ_API_KEY=
# ,list photo OCR (MiniMax-M3)
MINIMAX_API_KEY=
# web_search primary: Kagi session link (https://kagi.com/search?token=...); empty skips Kagi
KAGI_SESSION_LINK=
# Optional web_search fallback (after Kagi)
BRAVE_SEARCH_API_KEY=
# Firecrawl search fallback and page reads (first fetch step)
FIRECRAWL_API_KEY=
# Bright Data Web Unlocker fetch fallback (second fetch step)
BRIGHTDATA_API_KEY=
BRIGHTDATA_ZONE=
# Telegram spoken replies (Google Cloud TTS)
GOOGLE_CLOUD_TTS_API_KEY=
MELVBOT_CONFIG_DIR=/var/lib/melvbot/config
EOF

sudo chown root:root "$DEST"
sudo chmod 600 "$DEST"

echo "Installed $DEST"
ls -la "$DEST"
