#!/bin/sh
set -eu

MELVBOT_WORKSPACE="${MELVBOT_WORKSPACE:-/home/melvbot/melvbot-workspace}"
MELVBOT_REPO="${MELVBOT_REPO:-/home/melvbot/melvbot-storage/telegram-container}"
COMPOSE_FILE="${COMPOSE_FILE:-$MELVBOT_REPO/docker-compose.yml}"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not found (run this on the host, not inside the melvbot container)" >&2
  exit 1
fi

log "building melvbot image..."
docker compose -f "$COMPOSE_FILE" build melvbot

log "restarting melvbot container..."
docker compose -f "$COMPOSE_FILE" up -d --force-recreate melvbot

log "waiting for container..."
sleep 8

log "doctor check:"
docker exec melvbot melvbot doctor

log "done"
