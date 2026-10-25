#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT="${HOME}/melvbot-storage/host/bin/dalerts"
readonly A='{"number":1,"rule":{"id":"js/redos","security_severity_level":"high"},"most_recent_instance":{"location":{"path":"a.ts","start_line":4}}}'
readonly B='{"number":2,"rule":{"id":"js/x","security_severity_level":"medium"},"most_recent_instance":{"location":{"path":"b.ts","start_line":9}}}'

got="$(DALERTS_JSON='[]' "${SCRIPT}")" || { echo "FAIL: empty list must exit 0" >&2; exit 1; }
[ "${got}" = "dalerts: no open alerts" ] || { echo "FAIL: empty output: ${got}" >&2; exit 1; }

rc=0
got="$(DALERTS_JSON="[${B},${A}]" "${SCRIPT}")" || rc=$?
[ "${rc}" = 1 ] || { echo "FAIL: open alerts must exit 1, got ${rc}" >&2; exit 1; }
want=$'high (1)\n  #1 js/redos a.ts:4\nmedium (1)\n  #2 js/x b.ts:9'
[ "${got}" = "${want}" ] || { printf 'FAIL: grouping/order:\n%s\n' "${got}" >&2; exit 1; }

rc=0
DALERTS_JSON='not json' "${SCRIPT}" >/dev/null 2>&1 || rc=$?
[ "${rc}" = 2 ] || { echo "FAIL: bad response must exit 2, got ${rc}" >&2; exit 1; }
echo ok
