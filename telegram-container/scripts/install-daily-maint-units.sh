#!/bin/sh
set -eu

# Install melvbot-daily-maint.{service,timer}, melvbot-maint-alert.service,
# and melvbot-mem-sample.{service,timer}.
# Does not overlap scripts/install-cron-timers.py (melvbot-cron-* only).
#
# Tests set SUDO, SYSTEMCTL, and SYSTEMD_DIR to a fake toolchain and dest.

REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SUDO="${SUDO:-sudo}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"

UNITS="melvbot-daily-maint.service melvbot-daily-maint.timer melvbot-maint-alert.service melvbot-mem-sample.service melvbot-mem-sample.timer"

for unit in $UNITS; do
    src="$DEPLOY_DIR/$unit"
    if [ ! -f "$src" ]; then
        echo "missing unit file: $src" >&2
        exit 1
    fi
    "$SUDO" install -m 0644 "$src" "$SYSTEMD_DIR/$unit"
done

"$SUDO" "$SYSTEMCTL" daemon-reload
"$SUDO" "$SYSTEMCTL" enable --now melvbot-daily-maint.timer
"$SUDO" "$SYSTEMCTL" enable --now melvbot-mem-sample.timer
