#!/bin/sh
# Sourced by daily-maint-melvbot.sh. Defines post-maint checks.
# Standalone-testable: source after setting MELVBOT_DATA / STATE_DIR / etc., then call
# run_post_maint_functional_tests.
set -u

POST_MAINT_MIN_AVAIL_KB="${POST_MAINT_MIN_AVAIL_KB:-5242880}"
POST_MAINT_FAILURES=""
POST_MAINT_DETAIL_MAX_CHARS="${POST_MAINT_DETAIL_MAX_CHARS:-240}"
MELVBOT_COMPOSE_BIN="${MELVBOT_COMPOSE_BIN:-/home/melvbot/.local/bin/melvbot-compose}"
# A real apt-get update against several remote repos (archive, security,
# PPAs, vendor repos) never completes in under this many seconds -- TCP/TLS
# handshakes alone cost more. Below it, something (a stale-check wrapper, a
# broken sources.list, apt hitting a local cache only) is silently skipping
# the real fetch while still exiting 0, which is exactly the failure mode
# that let /usr/local/bin/apt-update-wrapper freeze this host's package
# index for months without a single FAIL in the nightly report.
APT_UPDATE_MIN_DURATION_SEC="${APT_UPDATE_MIN_DURATION_SEC:-2}"
APT_UPDATE_DURATION_FILE="${APT_UPDATE_DURATION_FILE:-${STATE_DIR:-}/apt-update-duration.txt}"

_post_maint_fail() {
    _id="$1"
    _detail="$2"
    POST_MAINT_FAILURES="${POST_MAINT_FAILURES}${_id} "
    log "POST_MAINT FAIL: ${_id} — ${_detail}"
}

_check_container() {
    _running="$(docker inspect -f '{{.State.Running}}' melvbot 2>/dev/null)" || {
        _post_maint_fail "container" "docker inspect failed"
        return
    }
    if [ "$_running" != "true" ]; then
        _post_maint_fail "container" "State.Running=${_running}"
    fi
}

_check_doctor() {
    _rc=0
    # Reuse this run's assistant-login probe (a superset of plain doctor) when fresh.
    _probe="${DOCTOR_PROBE_FILE:-${STATE_DIR:-}/doctor-probe.out}"
    if [ -s "$_probe" ] && [ -n "$(find "$_probe" -mmin -240 2>/dev/null)" ]; then
        _out="$(cat "$_probe")"
        if printf '%s\n' "$_out" | grep -qE ': error|: FAIL|^error:'; then
            _rc=1
        fi
        rm -f "$_probe"
    else
        _out="$(
            "$MELVBOT_COMPOSE_BIN" exec -T melvbot melvbot doctor 2>&1
        )" || _rc=$?
    fi
    if [ "$_rc" -eq 0 ]; then
        return 0
    fi
    _line="$(
        printf '%s\n' "$_out" | grep -E ': error|: FAIL|^error:' | head -n 1
    )"
    _line="$(printf '%s' "$_line" | tr '\n\r\t' ' ' | tr -s ' ')"
    _line="$(printf '%s' "$_line" | cut -c1-"$POST_MAINT_DETAIL_MAX_CHARS")"
    if [ -z "$_line" ]; then
        _line="melvbot doctor exited non-zero with no error detail"
    fi
    _post_maint_fail "doctor" "$_line"
    record_fail_detail "doctor" "$_line"
}

_check_apt_update_duration() {
    if [ ! -f "$APT_UPDATE_DURATION_FILE" ]; then
        _post_maint_fail "apt_update_duration" "missing ${APT_UPDATE_DURATION_FILE} (apt update step did not run?)"
        return
    fi
    _dur="$(tr -d '[:space:]' < "$APT_UPDATE_DURATION_FILE")"
    case "$_dur" in
        '' | *[!0-9]*)
            _post_maint_fail "apt_update_duration" "unreadable duration value: '${_dur}'"
            return
            ;;
    esac
    if [ "$_dur" -lt "$APT_UPDATE_MIN_DURATION_SEC" ]; then
        _post_maint_fail "apt_update_duration" \
            "apt update finished in ${_dur}s (< ${APT_UPDATE_MIN_DURATION_SEC}s) — looks skipped, not fetched"
    fi
}

_check_disk() {
    _avail_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
    if [ -z "$_avail_kb" ]; then
        _post_maint_fail "disk" "df -Pk / failed"
        return
    fi
    if [ "$_avail_kb" -lt "$POST_MAINT_MIN_AVAIL_KB" ]; then
        _post_maint_fail "disk" "avail ${_avail_kb}KB < ${POST_MAINT_MIN_AVAIL_KB}KB"
    fi
}

# Directory usage for /tmp, not df of the parent mount. df -h /tmp reports
# the whole root disk when /tmp is not its own filesystem.
_tmp_dir_used() {
    _used="$(du -sh /tmp 2>/dev/null | awk '{print $1}')"
    if [ -n "$_used" ]; then
        printf '%s' "$_used"
    else
        printf '%s' "unknown"
    fi
}

# Today's data backup must exist, be non-empty and under 26 h old.
_check_backup_fresh() {
    _dir="${BACKUP_DIR:-${MELVBOT_DATA:-}/backups/daily}"
    [ -d "$_dir" ] || return 0
    _f="$(ls -1t "$_dir"/*.tar.gz 2>/dev/null | head -n1)"
    if [ -z "$_f" ] || [ ! -s "$_f" ] || [ -z "$(find "$_f" -mmin -1560 2>/dev/null)" ]; then
        _post_maint_fail "backup" "no non-empty backup newer than 26h in ${_dir}"
    fi
}

# Warn below 15% free on / and /var/lib/docker.
_check_disk_pct() {
    for _m in / /var/lib/docker; do
        [ -d "$_m" ] || continue
        _used="$(df -P "$_m" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
        case "$_used" in ''|*[!0-9]*) continue ;; esac
        if [ "$_used" -gt 85 ]; then
            mark_warn "disk ${_m} ${_used}% used"
        fi
    done
}

run_post_maint_functional_tests() {
    POST_MAINT_FAILURES=""
    _check_container
    _check_doctor
    _check_backup_fresh
    _check_disk
    _check_disk_pct
    _check_apt_update_duration
    if [ -n "$POST_MAINT_FAILURES" ]; then
        return 1
    fi
    return 0
}
