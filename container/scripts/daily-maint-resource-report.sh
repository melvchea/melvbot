#!/bin/sh
# Sourced by daily-maint-melvbot.sh. Mem window stats and daily resource deltas
# for maint-report.txt. Expects STATE_DIR, DOCKER_BUILD_CACHE, _si_to_bytes.

MEM_SAMPLES_FILE="${MEM_SAMPLES_FILE:-$STATE_DIR/mem-samples.tsv}"
RESOURCE_SNAPSHOT_FILE="${RESOURCE_SNAPSHOT_FILE:-$STATE_DIR/resource-snapshot}"
MEM_SAMPLE_WINDOW_SEC="${MEM_SAMPLE_WINDOW_SEC:-86400}"

_resource_snapshot_value() {
    [ -f "$RESOURCE_SNAPSHOT_FILE" ] || return 1
    awk -F= -v key="$1" '$1 == key { print $2; found = 1; exit 0 } END { if (!found) exit 1 }' \
        "$RESOURCE_SNAPSHOT_FILE"
}

_emit_signed_delta_bytes() {
    _key="$1"
    _cur="$2"
    _prev="$3"
    [ -n "$_prev" ] || return 0
    echo "${_key}:$((_cur - _prev))"
}

write_resource_snapshot() {
    mkdir -p "$STATE_DIR"
    {
        echo "disk_root_used=$1"
        echo "disk_tmp_used=$2"
        echo "cache_private=$3"
    } > "$RESOURCE_SNAPSHOT_FILE"
}

emit_mem_report_fields() {
    [ -f "$MEM_SAMPLES_FILE" ] || return 0
    _now="$(date +%s)"
    _cutoff=$((_now - MEM_SAMPLE_WINDOW_SEC))
    awk -v cutoff="$_cutoff" '
        $1 ~ /^[0-9]+$/ && $1 >= cutoff && NF >= 3 {
            used = $2 + 0
            total = $3 + 0
            n++
            if (n == 1 || used < min_u) min_u = used
            if (n == 1 || used > max_u) max_u = used
            sum += used
            last_total = total
            if (NF >= 4) {
                docker = $4 + 0
                nd++
                if (nd == 1 || docker < min_d) min_d = docker
                if (nd == 1 || docker > max_d) max_d = docker
                sum_d += docker
            }
            if (NF >= 6) {
                top = $5 + 0
                nt++
                if (nt == 1 || top < min_t) min_t = top
                if (nt == 1 || top > max_t) max_t = top
                sum_t += top
                comm = $6
                if (comm != "" && comm != "-") {
                    count_c[comm]++
                    if (count_c[comm] > best_c) {
                        best_c = count_c[comm]
                        mode_c = comm
                    }
                }
            }
        }
        END {
            if (n < 1) exit 0
            printf "mem-total-bytes:%.0f\n", last_total
            printf "mem-min-bytes:%.0f\n", min_u
            printf "mem-avg-bytes:%.0f\n", sum / n
            printf "mem-max-bytes:%.0f\n", max_u
            if (nd >= 1) {
                printf "mem-docker-min-bytes:%.0f\n", min_d
                printf "mem-docker-avg-bytes:%.0f\n", sum_d / nd
                printf "mem-docker-max-bytes:%.0f\n", max_d
            }
            if (nt >= 1) {
                printf "mem-top-rss-min-bytes:%.0f\n", min_t
                printf "mem-top-rss-avg-bytes:%.0f\n", sum_t / nt
                printf "mem-top-rss-max-bytes:%.0f\n", max_t
                if (mode_c != "") printf "mem-top-comm:%s\n", mode_c
            }
        }
    ' "$MEM_SAMPLES_FILE"
}

_cache_private_bytes() {
    _field="$(printf '%s' "$DOCKER_BUILD_CACHE" | awk -F/ '{ print $2 }')"
    [ -n "$_field" ] || {
        printf '%s\n' "0"
        return 0
    }
    _si_to_bytes "$_field" 2>/dev/null || printf '%s\n' "0"
}

_disk_root_used_bytes() {
    df -B1 / | awk 'NR==2 { print $3; exit }'
}

_disk_tmp_used_bytes() {
    du -sb /tmp 2>/dev/null | awk '{ print $1 }'
}

emit_resource_delta_fields() {
    _root="$(_disk_root_used_bytes)"
    _tmp="$(_disk_tmp_used_bytes)"
    _cache="$(_cache_private_bytes)"
    [ -n "$_root" ] || _root=0
    [ -n "$_tmp" ] || _tmp=0
    [ -n "$_cache" ] || _cache=0
    _prev_root="$(_resource_snapshot_value disk_root_used 2>/dev/null || true)"
    _prev_tmp="$(_resource_snapshot_value disk_tmp_used 2>/dev/null || true)"
    _prev_cache="$(_resource_snapshot_value cache_private 2>/dev/null || true)"
    _emit_signed_delta_bytes "disk-root-delta-bytes" "$_root" "$_prev_root"
    _emit_signed_delta_bytes "disk-tmp-delta-bytes" "$_tmp" "$_prev_tmp"
    _emit_signed_delta_bytes "docker-cache-delta-bytes" "$_cache" "$_prev_cache"
    write_resource_snapshot "$_root" "$_tmp" "$_cache"
}
