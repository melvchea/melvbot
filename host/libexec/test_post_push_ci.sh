#!/usr/bin/env bash
set -euo pipefail

readonly HOOK="${HOME}/melvbot-storage/host/libexec/post-push-ci"
stub="$(mktemp)"
trap 'rm -f "${stub}"' EXIT
printf '#!/usr/bin/env bash\necho "stub CI"\n' >"${stub}"
chmod +x "${stub}"

run() { printf '{"tool_input":{"command":"%s"}}' "$1" | DCI="${stub}" "${HOOK}"; }

for cmd in "git status" "git log --oneline" "echo git pushed"; do
  [ -z "$(run "${cmd}")" ] || { echo "FAIL: hook must stay silent for: ${cmd}" >&2; exit 1; }
done

for cmd in "git push" "git add x && git commit -m y && git push origin main"; do
  got="$(run "${cmd}" | jq -r '.hookSpecificOutput.additionalContext')"
  [ "${got}" = "stub CI" ] || { echo "FAIL: push must return dci output for: ${cmd}: ${got}" >&2; exit 1; }
done
echo ok
