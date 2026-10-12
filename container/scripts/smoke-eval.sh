#!/bin/sh
# On-demand smoke run: canned Telegram-style prompts through the agent turn.
# Not part of ttest or CI. Every prompt is a real Claude turn (uses quota) and
# may write notes or turn_log rows. Needs jq and the melvbot container running.
# Usage: smoke-eval.sh [prompts.json]
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPTS="${1:-$SCRIPT_DIR/smoke-prompts.json}"
MELVBOT_COMPOSE_BIN="${MELVBOT_COMPOSE_BIN:-/home/melvbot/.local/bin/melvbot-compose}"

[ -f "$PROMPTS" ] || { echo "error: prompts file not found: $PROMPTS" >&2; exit 2; }

# No CLI entry runs an arbitrary prompt through the agent, so this calls
# runTurn (ts/src/assistant/turn.ts) directly inside the container. Telegram
# intercepts are skipped; the reply text goes to stdout.
run_one() {
    "$MELVBOT_COMPOSE_BIN" exec -T melvbot node --input-type=module -e "
import { runTurn } from '/opt/melvbot-ts/dist/assistant/turn.js';
const r = await runTurn({ chatKey: null, prompt: process.argv[1], signal: new AbortController().signal, source: 'telegram' });
process.stdout.write('\n<<REPLY>>' + r.text);
" "$1" < /dev/null | sed -n '/<<REPLY>>/,$p' | sed '1s/^<<REPLY>>//'
}

fails=0
rows="${TMPDIR:-/tmp}/smoke-prompts.$$"
jq -r '.[] | [.id, .prompt, .expect] | join("\t")' "$PROMPTS" > "$rows"
IFS="$(printf '\t')"
while read -r id prompt expect; do
    # Stdout only, and a non-zero exec is a FAIL even if stdout matches: sudo
    # or docker noise on stderr must never be regex-matched as a reply.
    if reply="$(run_one "$prompt")" && [ -n "$reply" ] && printf '%s' "$reply" | grep -Eqi -- "$expect"; then
        echo "PASS $id"
    else
        fails=$((fails + 1))
        echo "FAIL $id: expected /$expect/ in: $(printf '%s' "$reply" | tr '\n' ' ' | cut -c1-200)"
    fi
done < "$rows"
rm -f "$rows"
if [ "$fails" -gt 0 ]; then
    echo "smoke: FAIL ($fails)"
    exit 1
fi
echo "smoke: OK"
