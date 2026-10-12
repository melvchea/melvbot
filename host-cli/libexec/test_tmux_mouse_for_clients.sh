#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT="${HOME}/melvbot-storage/host-cli/libexec/tmux-mouse-for-clients.sh"

fail() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

expect() {
	local width="$1" height="$2" want="$3"
	local got
	got="$("${SCRIPT}" --classify "${width}" "${height}")"
	if [ "${got}" != "${want}" ]; then
		fail "${width}x${height} expected mouse ${want}, got ${got}"
	fi
}

expect 52 20 off
expect 52 38 off
expect 79 24 off
expect 80 24 on
expect 100 18 off
expect 100 22 on
expect 132 43 on

printf 'ok\n'
