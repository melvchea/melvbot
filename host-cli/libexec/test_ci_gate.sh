#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT="${HOME}/melvbot-storage/host-cli/libexec/ci-gate"

expect() {
	local want="$1" json="$2" got
	got="$(CI_GATE_JSON="${json}" "${SCRIPT}" abc)"
	[ "${got}" = "${want}" ] || { printf 'FAIL: want %s, got %s for %s\n' "${want}" "${got}" "${json}" >&2; exit 1; }
}

expect wait '{"workflow_runs":[]}'
expect wait '{"workflow_runs":[{"name":"CI","status":"in_progress","created_at":"1"}]}'
expect pass '{"workflow_runs":[{"name":"CI","status":"completed","conclusion":"success","created_at":"1"}]}'
expect fail '{"workflow_runs":[{"name":"CI","status":"completed","conclusion":"failure","created_at":"1"}]}'
# a rerun that succeeds supersedes the earlier red run; other workflows are ignored
expect pass '{"workflow_runs":[{"name":"CI","status":"completed","conclusion":"failure","created_at":"1"},{"name":"CI","status":"completed","conclusion":"success","created_at":"2"},{"name":"Dependabot Updates","status":"completed","conclusion":"failure","created_at":"3"}]}'
expect wait 'not json'
echo ok
