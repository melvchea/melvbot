#!/usr/bin/env bash
# Install and start the dautodeploy timer as a systemd user unit.
set -eu
src=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
dst=$HOME/.config/systemd/user
mkdir -p "$dst"
cp "$src"/dautodeploy.service "$src"/dautodeploy.timer "$dst"/
systemctl --user daemon-reload
systemctl --user enable --now dautodeploy.timer
systemctl --user list-timers dautodeploy.timer --no-pager
