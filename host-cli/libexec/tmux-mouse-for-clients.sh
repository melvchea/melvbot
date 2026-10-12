#!/usr/bin/env bash
# Next attach replaces mouse: Termius (phone-sized) → off; PuTTY → on.
# Termius swipe is app scrollback (no wheel). PuTTY wheel is tmux copy-mode.
set -u -o pipefail

readonly PHONE_PORTRAIT_MAX_WIDTH=80
readonly PHONE_LANDSCAPE_MAX_WIDTH=120
readonly PHONE_LANDSCAPE_MAX_HEIGHT=22

client_wants_native_scroll() {
	local width="$1" height="$2"
	if [ "${width}" -lt "${PHONE_PORTRAIT_MAX_WIDTH}" ]; then
		return 0
	fi
	if [ "${width}" -lt "${PHONE_LANDSCAPE_MAX_WIDTH}" ] &&
		[ "${height}" -lt "${PHONE_LANDSCAPE_MAX_HEIGHT}" ]; then
		return 0
	fi
	return 1
}

want_mouse() {
	if client_wants_native_scroll "$1" "$2"; then
		printf '%s\n' off
	else
		printf '%s\n' on
	fi
}

if [ "${1:-}" = "--classify" ]; then
	want_mouse "${2:?width}" "${3:?height}"
	exit 0
fi

if [ -z "${TMUX:-}" ]; then
	printf 'tmux-mouse-for-clients: not in tmux\n' >&2
	exit 1
fi

client="${1:-}"
if [ -n "${client}" ]; then
	dims="$(tmux display-message -t "${client}" -p '#{client_width} #{client_height}')"
else
	dims="$(tmux display-message -p '#{client_width} #{client_height}')"
fi
# shellcheck disable=SC2086
set -- ${dims}
want="$(want_mouse "${1:?}" "${2:?}")"
tmux set -g mouse "${want}"
