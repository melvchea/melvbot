#!/bin/sh
set -eu

REPORT_FILE="${MELVBOT_MAINT_REPORT:-/var/lib/melvbot/config/state/maint-report.txt}"

if [ ! -f "$REPORT_FILE" ]; then
  printf '%s\n' \
    "timestamp:unknown" \
    "disk-root:unknown" \
    "disk-tmp:unknown" \
    "updates:unknown" \
    "upgrades:unknown" \
    "held-back:unknown" \
    "reboot:unknown" \
    "upgraded-packages:" \
    "none" \
    "held-packages:" \
    "none" \
    "withdrawn-packages:" \
    "none" \
    "versions:" \
    "no changes"
  exit 0
fi

cat "$REPORT_FILE"
