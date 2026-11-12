#!/usr/bin/env bash
set -euo pipefail

readonly DIR="${HOME}/melvbot-storage/host/libexec"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
head -c 20000 /dev/zero | tr '\0' a >"${tmp}/big.txt"
echo hi >"${tmp}/small.txt"

gate() { printf '{"tool_name":"%s","cwd":"%s","tool_input":%s}' "$1" "${tmp}" "$2" | XDG_STATE_HOME="${tmp}" "${DIR}/read-gate" | jq -r '.hookSpecificOutput.permissionDecision // "allow"'; }
expect() { [ "$2" = "${3:-allow}" ] || { echo "FAIL: $1: got ${3:-allow}, want $2" >&2; exit 1; }; }

expect "big full Read denied" deny "$(gate Read "{\"file_path\":\"${tmp}/big.txt\"}")"
expect "big Read with limit allowed" allow "$(gate Read "{\"file_path\":\"${tmp}/big.txt\",\"limit\":50}")"
expect "big Read allow_large allowed" allow "$(gate Read "{\"file_path\":\"${tmp}/big.txt\",\"allow_large\":true}")"
expect "small Read allowed" allow "$(gate Read "{\"file_path\":\"${tmp}/small.txt\"}")"
expect "big image Read allowed" allow "$(gate Read "{\"file_path\":\"${tmp}/big.PNG\"}")"
expect "cat big file denied" deny "$(gate Bash '{"command":"cat big.txt"}')"
expect "cat big file piped allowed" allow "$(gate Bash '{"command":"cat big.txt | head"}')"
expect "cat small file allowed" allow "$(gate Bash '{"command":"cat small.txt"}')"
expect "bare curl denied" deny "$(gate Bash '{"command":"curl -s https://example.com/x"}')"
expect "curl piped allowed" allow "$(gate Bash '{"command":"curl -s https://example.com/x | jq ."}')"
expect "curl -o allowed" allow "$(gate Bash '{"command":"curl -s -o out.json https://example.com/x"}')"
expect "other command allowed" allow "$(gate Bash '{"command":"git status"}')"
[ "$(wc -l <"${tmp}/melvbot/read-gate.tsv")" = 3 ] || { echo "FAIL: each deny logs one row" >&2; exit 1; }
echo ok
