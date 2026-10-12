#!/bin/sh
set -eu

# Host RAM sampler for the 3am maint report (Min/Avg/Max over 24h).
# One concern: append used/total plus Docker and top host RSS, drop old rows.
# Columns: ts used total docker_bytes top_rss_bytes top_comm
# (legacy 3-column rows stay valid; extra fields are 0 / -)

MELVBOT_WORKSPACE="${MELVBOT_WORKSPACE:-/home/melvbot/melvbot-workspace}"
MELVBOT_DATA="${MELVBOT_DATA:-$MELVBOT_WORKSPACE/melvbot-data}"
STATE_DIR="${STATE_DIR:-$MELVBOT_DATA/config/state}"
MEM_SAMPLES_FILE="${MEM_SAMPLES_FILE:-$STATE_DIR/mem-samples.tsv}"
MEMINFO_PATH="${MEMINFO_PATH:-/proc/meminfo}"
MEM_SAMPLE_WINDOW_SEC="${MEM_SAMPLE_WINDOW_SEC:-86400}"
MEMINFO_KB_BYTES=1024
DOCKER_BIN="${DOCKER_BIN:-docker}"
PS_BIN="${PS_BIN:-ps}"
PROC_CGROUP_DIR="${PROC_CGROUP_DIR:-/proc}"
DOCKER_STATS_TIMEOUT_SEC="${DOCKER_STATS_TIMEOUT_SEC:-15}"
COMM_MAX_CHARS=32
MISSING_COMM="-"

_kB_field() {
    awk -v key="$1" '
        $1 == key {
            print $2
            found = 1
            exit 0
        }
        END { if (!found) exit 1 }
    ' "$MEMINFO_PATH"
}

_sanitize_comm() {
    printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_' | cut -c"1-$COMM_MAX_CHARS"
}

_docker_bytes() {
    _stats=""
    if ! command -v "$DOCKER_BIN" >/dev/null 2>&1; then
        printf '%s\n' "0"
        return 0
    fi
    if command -v timeout >/dev/null 2>&1; then
        _stats="$(timeout "$DOCKER_STATS_TIMEOUT_SEC" "$DOCKER_BIN" stats --no-stream --format '{{.MemUsage}}' 2>/dev/null || true)"
    else
        _stats="$("$DOCKER_BIN" stats --no-stream --format '{{.MemUsage}}' 2>/dev/null || true)"
    fi
    if [ -z "$_stats" ]; then
        printf '%s\n' "0"
        return 0
    fi
    printf '%s\n' "$_stats" | awk '
        function to_bytes(s,   n, u, f) {
            if (match(s, /^[0-9]+(\.[0-9]+)?/)) {
                n = substr(s, RSTART, RLENGTH) + 0
                u = substr(s, RSTART + RLENGTH)
            } else {
                return 0
            }
            f = 1
            if (u == "KiB" || u == "kB" || u == "KB") f = 1024
            else if (u == "MiB" || u == "MB") f = 1024 * 1024
            else if (u == "GiB" || u == "GB") f = 1024 * 1024 * 1024
            else if (u == "TiB" || u == "TB") f = 1024 * 1024 * 1024 * 1024
            else if (u != "B" && u != "b" && u != "") f = 1
            return n * f
        }
        {
            split($0, parts, " ")
            sum += to_bytes(parts[1])
        }
        END { printf "%.0f\n", sum + 0 }
    '
}

_in_docker_cgroup() {
    _cg="${PROC_CGROUP_DIR}/$1/cgroup"
    [ -f "$_cg" ] || return 1
    grep -q 'docker-' "$_cg" 2>/dev/null
}

_top_host_rss() {
    _rss_bytes=0
    _comm="$MISSING_COMM"
    _ps_out="$("$PS_BIN" -eo pid=,rss=,args= --no-headers --sort=-rss 2>/dev/null || true)"
    if [ -n "$_ps_out" ]; then
        while IFS= read -r _line; do
            set -- $_line
            [ "$#" -ge 2 ] || continue
            _pid=$1
            _rss_kb=$2
            shift 2
            [ -n "$_pid" ] && [ -n "$_rss_kb" ] || continue
            case "$_pid" in
                *[!0-9]*) continue ;;
            esac
            case "$_rss_kb" in
                *[!0-9]*) continue ;;
            esac
            if _in_docker_cgroup "$_pid"; then
                continue
            fi
            _base="$MISSING_COMM"
            if [ "$#" -ge 1 ]; then
                _base=${1##*/}
            fi
            [ -n "$_base" ] || _base="$MISSING_COMM"
            _rss_bytes=$((_rss_kb * MEMINFO_KB_BYTES))
            _comm="$(_sanitize_comm "$_base")"
            [ -n "$_comm" ] || _comm="$MISSING_COMM"
            break
        done <<EOF
$_ps_out
EOF
    fi
    printf '%s\t%s\n' "$_rss_bytes" "$_comm"
}

_now="$(date +%s)"
_total_kb="$(_kB_field "MemTotal:")" || exit 1
_avail_kb="$(_kB_field "MemAvailable:")" || exit 1
_total_bytes=$((_total_kb * MEMINFO_KB_BYTES))
_used_bytes=$(((_total_kb - _avail_kb) * MEMINFO_KB_BYTES))
_docker_bytes="$(_docker_bytes)"
_top="$(_top_host_rss)"
_top_rss="${_top%%	*}"
_top_comm="${_top#*	}"
_cutoff=$((_now - MEM_SAMPLE_WINDOW_SEC))

mkdir -p "$STATE_DIR"
_tmp="$(mktemp "${MEM_SAMPLES_FILE}.XXXXXX")"
if [ -f "$MEM_SAMPLES_FILE" ]; then
    awk -v cutoff="$_cutoff" '
        $1 ~ /^[0-9]+$/ && $1 >= cutoff { print }
    ' "$MEM_SAMPLES_FILE" > "$_tmp" || true
fi
printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$_now" "$_used_bytes" "$_total_bytes" "$_docker_bytes" "$_top_rss" "$_top_comm" >> "$_tmp"
mv "$_tmp" "$MEM_SAMPLES_FILE"
