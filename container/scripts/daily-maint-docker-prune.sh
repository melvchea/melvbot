#!/bin/sh
# Sourced by daily-maint-melvbot.sh. Docker image/container/builder prune
# and decimal-SI helpers. Expects LOG, log(), mark_warn(), BUILDER_PRUNE_UNTIL,
# BUILDER_PRUNE_MAX_USED_BYTES, BUILDER_CACHE_ROUNDING_TOLERANCE_BYTES,
# CONTAINER_PRUNE_UNTIL. Sets DOCKER_BUILD_CACHE.

run_docker_cleanup() {
    command -v docker >/dev/null 2>&1 || return 0
    docker image prune -a -f >> "$LOG" 2>&1
}

# Convert Docker decimal SI display (6.214GB, 4.096kB, 0B, "7.248GB (100%)")
# to an integer byte count. Rejects binary units (GiB) so we do not guess.
_si_to_bytes() {
    _token="$(printf '%s' "$1" | awk '{print $1}')"
    [ -n "$_token" ] || return 1
    printf '%s\n' "$_token" | awk '
        BEGIN { ok = 0 }
        {
            if ($0 !~ /^[0-9]+(\.[0-9]+)?([kMGTP]B|B)$/) exit 1
            n = $0
            sub(/([kMGTP]B|B)$/, "", n)
            u = $0
            sub(/^[0-9]+(\.[0-9]+)?/, "", u)
            mul = 1
            if (u == "kB") mul = 1000
            else if (u == "MB") mul = 1000 * 1000
            else if (u == "GB") mul = 1000 * 1000 * 1000
            else if (u == "TB") mul = 1000 * 1000 * 1000 * 1000
            else if (u == "PB") mul = 1000 * 1000 * 1000 * 1000 * 1000
            printf "%.0f\n", n * mul
            ok = 1
            exit 0
        }
        END { if (!ok) exit 1 }
    '
}

# Inverse of _si_to_bytes: integer bytes → decimal-SI token. Largest
# applicable unit from the _si_to_bytes table; at most 3 fractional
# decimals with trailing fractional zeroes removed.
_bytes_to_si() {
    printf '%s\n' "$1" | awk '
        {
            b = $0 + 0
            if (b == 0) { print "0B"; exit 0 }
            u = "B"
            mul = 1
            if (b >= 1000 * 1000 * 1000 * 1000 * 1000) {
                u = "PB"
                mul = 1000 * 1000 * 1000 * 1000 * 1000
            } else if (b >= 1000 * 1000 * 1000 * 1000) {
                u = "TB"
                mul = 1000 * 1000 * 1000 * 1000
            } else if (b >= 1000 * 1000 * 1000) {
                u = "GB"
                mul = 1000 * 1000 * 1000
            } else if (b >= 1000 * 1000) {
                u = "MB"
                mul = 1000 * 1000
            } else if (b >= 1000) {
                u = "kB"
                mul = 1000
            }
            s = sprintf("%.3f", b / mul)
            sub(/0+$/, "", s)
            sub(/\.$/, "", s)
            print s u
        }
    '
}

# Sum newline-separated Docker SI size tokens to integer bytes.
_sum_si_bytes() {
    _acc=0
    [ -n "$1" ] || {
        printf '%s\n' "0"
        return 0
    }
    while IFS= read -r _sz; do
        [ -n "$_sz" ] || continue
        _bytes="$(_si_to_bytes "$_sz")" || return 1
        _acc=$((_acc + _bytes))
    done <<EOF
$1
EOF
    printf '%s\n' "$_acc"
}

# Sets DOCKER_BUILD_CACHE to total/private/shared/cap from `buildx du`
# on the default builder (docker driver, containerd image store).
# Returns 1 when that du cannot be parsed.
# With first arg "warn" (post-prune call only), WARN when non-shared
# (Shared == false) total exceeds the cap plus
# rounding tolerance and private reclaimable bytes exceed that private
# excess plus tolerance. BuildKit applies MaxUsedSpace to non-shared
# records only; shared image-backed cache must not WARN.
_observe_builder_cache() {
    _du_out="$(docker buildx du --builder default --format '{{json .}}' 2>/dev/null)" || return 1
    _private=0
    _private_reclaimable=0
    _shared=0
    if [ -n "$_du_out" ]; then
        _private_sizes="$(printf '%s\n' "$_du_out" | jq -sr \
            '.[] | select(.Shared == false) | .Size' \
            2>/dev/null)" || return 1
        _private="$(_sum_si_bytes "$_private_sizes")" || return 1
        _shared_sizes="$(printf '%s\n' "$_du_out" | jq -sr \
            '.[] | select(.Shared == true) | .Size' \
            2>/dev/null)" || return 1
        _shared="$(_sum_si_bytes "$_shared_sizes")" || return 1
        _recl_sizes="$(printf '%s\n' "$_du_out" | jq -sr \
            '.[] | select(.Reclaimable == true and .Shared == false) | .Size' \
            2>/dev/null)" || return 1
        _private_reclaimable="$(_sum_si_bytes "$_recl_sizes")" || return 1
    fi
    _cap="$BUILDER_PRUNE_MAX_USED_BYTES"
    _tol="$BUILDER_CACHE_ROUNDING_TOLERANCE_BYTES"
    _total=$((_private + _shared))
    DOCKER_BUILD_CACHE="$(_bytes_to_si "$_total")/$(_bytes_to_si "$_private")/$(_bytes_to_si "$_shared")/${_cap}"
    log "docker-build-cache: $DOCKER_BUILD_CACHE"
    if [ "${1:-}" = "warn" ] && [ "$_private" -gt $((_cap + _tol)) ]; then
        _excess=$((_private - _cap))
        if [ "$_private_reclaimable" -gt $((_excess + _tol)) ]; then
            mark_warn "docker build cache above cap"
        fi
    fi
    return 0
}

run_builder_prune() {
    command -v docker >/dev/null 2>&1 || return 0
    docker buildx prune -f --builder default --filter "until=$BUILDER_PRUNE_UNTIL" >> "$LOG" 2>&1 || true
    docker buildx prune -f --builder default --max-used-space "$BUILDER_PRUNE_MAX_USED_BYTES" >> "$LOG" 2>&1 || true
    if ! _observe_builder_cache warn; then
        DOCKER_BUILD_CACHE="unavailable"
        log "docker-build-cache: $DOCKER_BUILD_CACHE"
        mark_warn "docker build cache observability"
    fi
    return 0
}

run_container_prune() {
    command -v docker >/dev/null 2>&1 || return 0
    docker container prune -f --filter "until=$CONTAINER_PRUNE_UNTIL" >> "$LOG" 2>&1
}
