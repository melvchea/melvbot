#!/usr/bin/env bash
set -euo pipefail

readonly DIR="${HOME}/melvbot-storage/host/libexec"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

gate() { printf '{"tool_input":%s}' "$1" | "${DIR}/agent-gate" | jq -r '.hookSpecificOutput.permissionDecision'; }
expect() { [ "$2" = "$3" ] || { echo "FAIL: $1: got $3, want $2" >&2; exit 1; }; }

expect "conforming launch asks" ask "$(gate '{"subagent_type":"general-purpose","model":"haiku","effort":"medium"}')"
expect "omitted type is general-purpose" ask "$(gate '{"model":"haiku","effort":"medium"}')"
expect "fork denied" deny "$(gate '{"subagent_type":"fork","model":"haiku","effort":"medium"}')"
expect "wrong model denied" deny "$(gate '{"model":"sonnet","effort":"medium"}')"
expect "missing effort denied" deny "$(gate '{"model":"haiku"}')"

cap() { printf '{"agent_transcript_path":"%s"}' "$1" | "${DIR}/subagent-cap"; }
u() { printf '{"message":{"usage":{"input_tokens":%s,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}}\n' "$1"; }
u 50000 >"${tmp}/small.jsonl"
u 60000 >"${tmp}/big.jsonl"; u 60000 >>"${tmp}/big.jsonl"
[ -z "$(cap "${tmp}/small.jsonl")" ] || { echo "FAIL: under cap must stay silent" >&2; exit 1; }
cap "${tmp}/big.jsonl" | jq -e '.systemMessage | test("120000")' >/dev/null || { echo "FAIL: over cap must warn" >&2; exit 1; }
echo ok
