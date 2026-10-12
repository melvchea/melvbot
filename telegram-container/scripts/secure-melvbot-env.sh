#!/usr/bin/env bash
# Lock /etc/melvbot/melvbot.env to root-only; inject via sudo docker compose.
set -euo pipefail

ENV_FILE="/etc/melvbot/melvbot.env"
ENV_DIR="/etc/melvbot"
COMPOSE_FILE="$HOME/melvbot-storage/telegram-container/docker-compose.yml"
MELVBOT_COMPOSE="$HOME/.local/bin/melvbot-compose"

log() { printf '[secure-melvbot-env] %s\n' "$*"; }

if ! sudo test -f "$ENV_FILE"; then
  echo "missing $ENV_FILE" >&2
  exit 1
fi

log "root-only permissions on $ENV_DIR and $ENV_FILE"
sudo install -d -m 750 -o root -g root "$ENV_DIR"
sudo chown root:root "$ENV_FILE"
sudo chmod 600 "$ENV_FILE"

if [ -r "$ENV_FILE" ]; then
  echo "unexpected: melvbot can still read $ENV_FILE" >&2
  exit 1
fi
log "melvbot cannot read $ENV_FILE (expected)"

chmod +x "$MELVBOT_COMPOSE"

log "restart melvbot via melvbot-compose (root reads env_file)"
"$MELVBOT_COMPOSE" up -d

log "doctor"
"$MELVBOT_COMPOSE" exec -T melvbot melvbot doctor

log "done"
