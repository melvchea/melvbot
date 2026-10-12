#!/bin/sh
set -u

# systemd invokes this with a bare PATH that excludes ~/.local/bin, where uv
# lives; without this, optional uv-based bumps silently no-op every run.
PATH="/home/melvbot/.local/bin:$PATH"
export PATH

# Live systemd unit may lack Environment= (sudo -n cannot install units).
DOCKER_CONFIG="${DOCKER_CONFIG:-/home/melvbot/.docker}"
export DOCKER_CONFIG

MELVBOT_WORKSPACE="${MELVBOT_WORKSPACE:-/home/melvbot/melvbot-workspace}"
MELVBOT_REPO="${MELVBOT_REPO:-/home/melvbot/melvbot-storage/telegram-container}"
MELVBOT_DATA="${MELVBOT_DATA:-$MELVBOT_WORKSPACE/melvbot-data}"
COMPOSE_FILE="${COMPOSE_FILE:-$MELVBOT_REPO/docker-compose.yml}"
STATE_DIR="${STATE_DIR:-$MELVBOT_DATA/config/state}"
MAINT_REPORT_FILE="${MAINT_REPORT_FILE:-$STATE_DIR/maint-report.txt}"
MAINT_REPORT_CHANGES="${MAINT_REPORT_CHANGES:-$STATE_DIR/maint-report-changes.txt}"
MAINT_REPORT_ARCHIVE_DIR="${MAINT_REPORT_ARCHIVE_DIR:-$STATE_DIR/maint-reports}"
MAINT_REPORT_RETENTION_DAYS="${MAINT_REPORT_RETENTION_DAYS:-90}"
APT_STATUS_FILE="${APT_STATUS_FILE:-$STATE_DIR/apt-host-status.txt}"
APT_UPGRADED_FILE="${APT_UPGRADED_FILE:-$STATE_DIR/apt-upgraded.txt}"
# Wall-clock seconds the apt update step took. A real fetch against several
# remote repos takes multiple seconds; a wrapper that short-circuits (e.g. a
# stale-check that skips the real update) finishes in well under one second.
# post-maint-functional-tests.sh reads this to catch that failure mode, which
# apt's own exit code cannot: a skipped update still exits 0.
APT_UPDATE_DURATION_FILE="${APT_UPDATE_DURATION_FILE:-$STATE_DIR/apt-update-duration.txt}"
# Watermark for dpkg.log collection: previous run's collect-finished time.
# Without this, daytime apt-daily-upgrade (outside the 3am window) never
# appears in the Telegram report even though packages did upgrade.
APT_UPGRADED_SINCE_FILE="${APT_UPGRADED_SINCE_FILE:-$STATE_DIR/apt-upgraded-since.txt}"
APT_HELD_FILE="${APT_HELD_FILE:-$STATE_DIR/apt-held.txt}"
DPKG_LOG="${DPKG_LOG:-/var/log/dpkg.log}"
APT_HISTORY_LOG="${APT_HISTORY_LOG:-/var/log/apt/history.log}"
LOG="${LOG:-/var/log/melvbot-daily-maint.log}"
# Age filter for buildx prune. 168h = 7 days. The 8 GiB cap below still drops older records once the cache is over the cap.
BUILDER_PRUNE_UNTIL="${BUILDER_PRUNE_UNTIL:-168h}"
# 8 GiB. Same integer is passed to Docker --max-used-space and used in comparisons.
BUILDER_PRUNE_MAX_USED_BYTES="${BUILDER_PRUNE_MAX_USED_BYTES:-8589934592}"
# Decimal SI display (e.g. 6.214GB) rounds at about 0.001GB = 1e6 bytes.
BUILDER_CACHE_ROUNDING_TOLERANCE_BYTES="${BUILDER_CACHE_ROUNDING_TOLERANCE_BYTES:-1000000}"
CONTAINER_PRUNE_UNTIL="${CONTAINER_PRUNE_UNTIL:-24h}"
JOURNAL_VACUUM_SIZE="${JOURNAL_VACUUM_SIZE:-32M}"
REBOOT_DELAY_MIN="${REBOOT_DELAY_MIN:-5}"
# All candidates, security included, wait 23h: one 3am cycle, with an hour of
# slack if the timer fires early.
APT_MIN_AGE_SEC="${APT_MIN_AGE_SEC:-82800}"
APT_FIRST_SEEN_FILE="${APT_FIRST_SEEN_FILE:-$STATE_DIR/apt-candidate-first-seen.tsv}"
APT_AGE_GATE_CONF="${APT_AGE_GATE_CONF:-/etc/apt/apt.conf.d/99-melvbot-age-gate.conf}"
APT_AGE_GATE_PIN="${APT_AGE_GATE_PIN:-/etc/apt/preferences.d/99-melvbot-age-gate}"
APT_GATE_HOLD_FILE="${APT_GATE_HOLD_FILE:-$STATE_DIR/apt-gate-holds.txt}"
APT_WITHDRAWN_FILE="${APT_WITHDRAWN_FILE:-$STATE_DIR/apt-withdrawn.txt}"
MAINT_REPORT_JOB_ID="${MAINT_REPORT_JOB_ID:-8c208d765865}"
MAINT_REPORT_TIMEOUT_SEC="${MAINT_REPORT_TIMEOUT_SEC:-600}"
FAIL_DETAIL_MAX_CHARS="${FAIL_DETAIL_MAX_CHARS:-240}"
STATS_CONTAINER_MELVBOT="${STATS_CONTAINER_MELVBOT:-melvbot}"
MELVBOT_COMPOSE_BIN="${MELVBOT_COMPOSE_BIN:-/home/melvbot/.local/bin/melvbot-compose}"
HEALTH_RETRIES="${HEALTH_RETRIES:-12}"
HEALTH_INTERVAL_SEC="${HEALTH_INTERVAL_SEC:-5}"
HOST_UV_CACHE_DIR="${HOST_UV_CACHE_DIR:-/home/melvbot/.cache/uv}"
HOST_PIP_CACHE_DIR="${HOST_PIP_CACHE_DIR:-/home/melvbot/.cache/pip}"
LOGROTATE_SRC="${LOGROTATE_SRC:-$MELVBOT_REPO/deploy/logrotate-melvbot.conf}"
LOGROTATE_DST="${LOGROTATE_DST:-/etc/logrotate.d/melvbot}"
SYSCTL_RAM_SRC="${SYSCTL_RAM_SRC:-$MELVBOT_REPO/deploy/sysctl.d/99-melvbot-ram.conf}"
SYSCTL_RAM_DST="${SYSCTL_RAM_DST:-/etc/sysctl.d/99-melvbot-ram.conf}"
SYSCTL_SWAP_SRC="${SYSCTL_SWAP_SRC:-$MELVBOT_REPO/deploy/sysctl.d/99-swappiness.conf}"
SYSCTL_SWAP_DST="${SYSCTL_SWAP_DST:-/etc/sysctl.d/99-swappiness.conf}"
JOURNALD_RAM_SRC="${JOURNALD_RAM_SRC:-$MELVBOT_REPO/deploy/journald.conf.d/melvbot.conf}"
JOURNALD_RAM_DST="${JOURNALD_RAM_DST:-/etc/systemd/journald.conf.d/melvbot.conf}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
TIMER_SYNC_SERVICE="${TIMER_SYNC_SERVICE:-melvbot-timer-sync.service}"
TIMER_SYNC_PATH="${TIMER_SYNC_PATH:-melvbot-timer-sync.path}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
MEM_SAMPLE_SERVICE="${MEM_SAMPLE_SERVICE:-melvbot-mem-sample.service}"
MEM_SAMPLE_TIMER="${MEM_SAMPLE_TIMER:-melvbot-mem-sample.timer}"
MEM_SAMPLE_SCRIPT="${MEM_SAMPLE_SCRIPT:-$MELVBOT_REPO/scripts/sample-host-mem.sh}"

# MAINT_DRY_RUN=1: log the step list without running anything that changes the host (only the
# so nothing changes); the real log, state and report files stay untouched.
if [ "${MAINT_DRY_RUN:-}" = 1 ]; then
    LOG="${MAINT_DRY_RUN_LOG:-/tmp/melvbot-maint-dryrun.log}"
fi

# shellcheck source=post-maint-functional-tests.sh
. "$(dirname "$0")/post-maint-functional-tests.sh"
# shellcheck source=daily-maint-grow-root.sh
. "$(dirname "$0")/daily-maint-grow-root.sh"
# shellcheck source=daily-maint-docker-prune.sh
. "$(dirname "$0")/daily-maint-docker-prune.sh"
# shellcheck source=daily-maint-resource-report.sh
. "$(dirname "$0")/daily-maint-resource-report.sh"
# shellcheck source=daily-maint-google-auth.sh
. "$(dirname "$0")/daily-maint-google-auth.sh"
# shellcheck source=daily-maint-assistant.sh
. "$(dirname "$0")/daily-maint-assistant.sh"
# shellcheck source=daily-maint-stale-workspace.sh
. "$(dirname "$0")/daily-maint-stale-workspace.sh"
# shellcheck source=daily-maint-claude-sdk.sh
. "$(dirname "$0")/daily-maint-claude-sdk.sh"
# shellcheck source=daily-maint-backup.sh
. "$(dirname "$0")/daily-maint-backup.sh"

STEP_FAILURES=""
STEP_FAILURE_DETAILS=""
STEP_WARNINGS=""
APT_HELD_BACK_COUNT=0
APT_AGE_GATE_HELD=""
APT_AGE_GATE_ELIGIBLE=""
DOCKER_BUILD_CACHE=""

log() {
    _msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$_msg"
    echo "$_msg" >> "$LOG"
}

mark_ok() {
    _msg="[$(date '+%Y-%m-%d %H:%M:%S')] OK: $1"
    echo "$_msg"
    echo "$_msg" >> "$LOG"
}

mark_fail() {
    _msg="[$(date '+%Y-%m-%d %H:%M:%S')] FAIL: $1"
    echo "$_msg"
    echo "$_msg" >> "$LOG"
    STEP_FAILURES="${STEP_FAILURES}${1} "
}

mark_warn() {
    _msg="[$(date '+%Y-%m-%d %H:%M:%S')] WARN: $1 (non-fatal)"
    echo "$_msg"
    echo "$_msg" >> "$LOG"
    STEP_WARNINGS="${STEP_WARNINGS:+${STEP_WARNINGS% }, }${1} "
}

has_failures() {
    [ -n "$STEP_FAILURES" ]
}

has_warnings() {
    [ -n "$STEP_WARNINGS" ]
}

_sanitize_fail_detail() {
    _collapsed="$(printf '%s' "$1" | tr '\n\r\t' ' ' | tr -s ' ')"
    # OAuth reauth URLs must reach the Telegram report; 240 chars clips them.
    case "$_collapsed" in
        *https://*|*http://*)
            printf '%s' "$_collapsed"
            ;;
        *)
            printf '%s' "$_collapsed" | cut -c1-"$FAIL_DETAIL_MAX_CHARS"
            ;;
    esac
}

record_fail_detail() {
    _label="$1"
    _detail="$2"
    _safe="$(_sanitize_fail_detail "$_detail")"
    [ -n "$_safe" ] || return 0
    STEP_FAILURE_DETAILS="${STEP_FAILURE_DETAILS}${_label}: ${_safe}
"
}

finish_summary() {
    if has_warnings; then
        log "warnings: (${STEP_WARNINGS% })"
    fi
    if has_failures; then
        log "summary: FAIL (${STEP_FAILURES% })"
        return 1
    fi
    log "summary: OK"
    return 0
}

track() {
    _label="$1"
    shift
    log "$_label..."
    if [ "${MAINT_DRY_RUN:-}" = 1 ] && [ "$_label" != "claude sdk update" ]; then
        log "[dry-run] skipped: $_label"
        mark_ok "$_label"
        return 0
    fi
    _warnings_before="$STEP_WARNINGS"
    if "$@"; then
        if [ "$STEP_WARNINGS" = "$_warnings_before" ]; then
            mark_ok "$_label"
        fi
    else
        mark_fail "$_label"
    fi
}

track_optional() {
    _label="$1"
    shift
    log "$_label..."
    if [ "${MAINT_DRY_RUN:-}" = 1 ] && [ "$_label" != "claude sdk update" ]; then
        log "[dry-run] skipped: $_label"
        mark_ok "$_label"
        return 0
    fi
    _warnings_before="$STEP_WARNINGS"
    if "$@"; then
        if [ "$STEP_WARNINGS" = "$_warnings_before" ]; then
            mark_ok "$_label"
        fi
    else
        mark_warn "$_label"
    fi
}

record_change() {
    _pkg="$1"
    _from="$2"
    _to="$3"
    echo "${_pkg}: ${_from} -> ${_to}" >> "$MAINT_REPORT_CHANGES"
}

run_apt_update() {
    _t0="$(date +%s)"
    if [ -x /usr/local/bin/apt-update-wrapper ]; then
        /usr/local/bin/apt-update-wrapper
    else
        DEBIAN_FRONTEND=noninteractive apt-get update -y -q
    fi
    _rc=$?
    mkdir -p "$STATE_DIR"
    echo "$(( $(date +%s) - _t0 ))" > "$APT_UPDATE_DURATION_FILE"
    return "$_rc"
}

# Split upgradable candidates (security included) into those past the 23h window
# and those still inside it. Refreshes the first-seen ledger.
# Sets APT_AGE_GATE_HELD, APT_AGE_GATE_ELIGIBLE, and
# APT_AGE_GATE_PINS. Must not be called from a command substitution.
apt_age_gate_partition() {
    mkdir -p "$STATE_DIR"
    _now="$(date +%s)"
    APT_AGE_GATE_HELD=""
    APT_AGE_GATE_ELIGIBLE=""
    APT_AGE_GATE_PINS=""
    _operator_holds="$(apt-mark showhold 2>/dev/null)"
    _tmp_upgradable="$(mktemp)"
    _tmp_state="$(mktemp)"
    _old_seen="$(mktemp)"
    : > "$_tmp_state"
    if [ -f "$APT_FIRST_SEEN_FILE" ]; then
        cp -f "$APT_FIRST_SEEN_FILE" "$_old_seen"
    fi
    apt list --upgradable 2>/dev/null | tail -n +2 > "$_tmp_upgradable" || true
    while IFS= read -r _line; do
        [ -n "$_line" ] || continue
        _pkg="${_line%%/*}"
        _ver="$(echo "$_line" | awk '{print $2}')"
        [ -n "$_pkg" ] && [ -n "$_ver" ] || continue
        _first_seen=""
        if [ -s "$_old_seen" ]; then
            _row="$(grep -F "$(printf '%s\t%s\t' "$_pkg" "$_ver")" \
                "$_old_seen" 2>/dev/null | head -1)"
            _first_seen="$(echo "$_row" | cut -f3)"
        fi
        [ -n "$_first_seen" ] || _first_seen="$_now"
        printf '%s\t%s\t%s\n' "$_pkg" "$_ver" "$_first_seen" >> "$_tmp_state"
        _age=$((_now - _first_seen))
        # An operator hold is a deliberate freeze. apt will refuse the upgrade
        # regardless; counting it as eligible would claim work that never happens.
        if printf '%s\n' "$_operator_holds" | grep -qx "$_pkg"; then
            APT_AGE_GATE_HELD="${APT_AGE_GATE_HELD}${APT_AGE_GATE_HELD:+ }$_pkg"
            continue
        fi
        if [ "$_age" -ge "$APT_MIN_AGE_SEC" ]; then
            APT_AGE_GATE_ELIGIBLE="${APT_AGE_GATE_ELIGIBLE}${APT_AGE_GATE_ELIGIBLE:+ }$_pkg"
            continue
        fi
        # Pin only this too-new version.
        APT_AGE_GATE_PINS="${APT_AGE_GATE_PINS}${APT_AGE_GATE_PINS:+
}${_pkg}	${_ver}"
        APT_AGE_GATE_HELD="${APT_AGE_GATE_HELD}${APT_AGE_GATE_HELD:+ }$_pkg"
    done < "$_tmp_upgradable"
    rm -f "$_tmp_upgradable"
    # A candidate that disappeared before we installed it was pulled from the
    # index (yanked or replaced). Apt will not offer it, so we do not install
    # it. A replacement version is a new ledger row and waits another 23h.
    : > "$APT_WITHDRAWN_FILE"
    if [ -s "$_old_seen" ]; then
        while IFS="$(printf '\t')" read -r _opkg _over _ofirst; do
            [ -n "$_opkg" ] && [ -n "$_over" ] || continue
            if grep -F "$(printf '%s\t%s\t' "$_opkg" "$_over")" "$_tmp_state" >/dev/null 2>&1; then
                continue
            fi
            _inst="$(apt-cache policy "$_opkg" 2>/dev/null \
                | awk '/^  Installed:/ { print $2; exit }')"
            if [ "$_inst" = "$_over" ]; then
                continue
            fi
            printf '%s %s -> withdrawn\n' "$_opkg" "$_over" >> "$APT_WITHDRAWN_FILE"
        done < "$_old_seen"
    fi
    rm -f "$_old_seen"
    mv "$_tmp_state" "$APT_FIRST_SEEN_FILE"
}

apt_age_gate_count() {
    _count=0
    for _pkg in $1; do
        [ -n "$_pkg" ] || continue
        _count=$((_count + 1))
    done
    printf '%s' "$_count"
}

# Pin the too-new version only; a package hold would outlive a killed run.
apt_age_gate_write_pin() {
    [ -n "$APT_AGE_GATE_PINS" ] || return 0
    _pin_tmp="$(mktemp)"
    printf '%s\n' "$APT_AGE_GATE_PINS" | while IFS="$(printf '\t')" read -r _pkg _ver; do
        [ -n "$_pkg" ] && [ -n "$_ver" ] || continue
        printf 'Package: %s\nPin: version %s\nPin-Priority: -1\n\n' "$_pkg" "$_ver"
    done > "$_pin_tmp"
    install -m 644 "$_pin_tmp" "$APT_AGE_GATE_PIN"
    rm -f "$_pin_tmp"
}

# Earlier nights held the whole package with apt-mark. A killed run can leave
# those holds behind. Release only the ones this job recorded.
apt_gate_unhold() {
    [ -s "$APT_GATE_HOLD_FILE" ] || return 0
    while IFS= read -r _pkg; do
        [ -n "$_pkg" ] || continue
        apt-mark unhold "$_pkg" >> "$LOG" 2>&1 || true
    done < "$APT_GATE_HOLD_FILE"
    : > "$APT_GATE_HOLD_FILE"
}

apt_gate_cleanup() {
    rm -f "$APT_AGE_GATE_CONF" "$APT_AGE_GATE_PIN"
    apt_gate_unhold
}

# unattended-upgrades does not install -updates or third-party origins.
# Upgrade those explicitly once they have cleared the 23h gate. Version pins
# keep younger candidates out. "upgrade" rather than
# "install --only-upgrade" keeps apt's own safeguards: anything that would
# need a removal, and anything Ubuntu is still phasing, is kept back.
run_apt_gate_upgrade() {
    [ -n "$APT_AGE_GATE_ELIGIBLE" ] || return 0
    log "apt age-gate upgrading ($(apt_age_gate_count "$APT_AGE_GATE_ELIGIBLE")): $APT_AGE_GATE_ELIGIBLE"
    DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -q --with-new-pkgs \
        -o Dpkg::Options::=--force-confdef \
        -o Dpkg::Options::=--force-confold >> "$LOG" 2>&1
}

# Append dpkg "upgrade" lines since $2 from file $1 (plain) into $3.
_collect_dpkg_upgrade_file() {
    _src="$1"
    _since="$2"
    _out="$3"
    [ -f "$_src" ] || return 0
    # dpkg.log: "2026-07-25 01:51:43 upgrade pkg:arch old new"
    awk -v since="$_since" '
        $3 == "upgrade" {
            ts = $1 " " $2
            if (ts < since) next
            pkg = $4
            sub(/:.*$/, "", pkg)
            printf "%s %s -> %s\n", pkg, $5, $6
        }
    ' "$_src" >> "$_out"
}

# Same as above, but the source is gzip-compressed (logrotate without delaycompress).
_collect_dpkg_upgrade_gz() {
    _src="$1"
    _since="$2"
    _out="$3"
    [ -f "$_src" ] || return 0
    gzip -dc "$_src" 2>/dev/null | awk -v since="$_since" '
        $3 == "upgrade" {
            ts = $1 " " $2
            if (ts < since) next
            pkg = $4
            sub(/:.*$/, "", pkg)
            printf "%s %s -> %s\n", pkg, $5, $6
        }
    ' >> "$_out"
}

# apt history.log is the authoritative "what apt upgraded" record and survives
# some dpkg.log rotation gaps. Start-Date uses two spaces before the time.
_collect_apt_history_file() {
    _src="$1"
    _since="$2"
    _out="$3"
    [ -f "$_src" ] || return 0
    awk -v since="$_since" '
        /^Start-Date:/ {
            ts = $2 " " $3
            active = (ts >= since)
            next
        }
        /^End-Date:/ { active = 0; next }
        active && /^Upgrade:/ {
            line = $0
            sub(/^Upgrade:[[:space:]]*/, "", line)
            while (match(line, /[a-zA-Z0-9][a-zA-Z0-9+._-]+:[a-zA-Z0-9]+ \([^)]+\)/)) {
                item = substr(line, RSTART, RLENGTH)
                line = substr(line, RSTART + RLENGTH)
                pkg = item
                sub(/:.*$/, "", pkg)
                vers = item
                sub(/^[^(]+\(/, "", vers)
                sub(/\)$/, "", vers)
                split(vers, v, ", ")
                if (v[1] != "" && v[2] != "")
                    printf "%s %s -> %s\n", pkg, v[1], v[2]
            }
        }
    ' "$_src" >> "$_out"
}

_collect_apt_history_gz() {
    _src="$1"
    _since="$2"
    _out="$3"
    [ -f "$_src" ] || return 0
    gzip -dc "$_src" 2>/dev/null | awk -v since="$_since" '
        /^Start-Date:/ {
            ts = $2 " " $3
            active = (ts >= since)
            next
        }
        /^End-Date:/ { active = 0; next }
        active && /^Upgrade:/ {
            line = $0
            sub(/^Upgrade:[[:space:]]*/, "", line)
            while (match(line, /[a-zA-Z0-9][a-zA-Z0-9+._-]+:[a-zA-Z0-9]+ \([^)]+\)/)) {
                item = substr(line, RSTART, RLENGTH)
                line = substr(line, RSTART + RLENGTH)
                pkg = item
                sub(/:.*$/, "", pkg)
                vers = item
                sub(/^[^(]+\(/, "", vers)
                sub(/\)$/, "", vers)
                split(vers, v, ", ")
                if (v[1] != "" && v[2] != "")
                    printf "%s %s -> %s\n", pkg, v[1], v[2]
            }
        }
    ' >> "$_out"
}

# Record packages upgraded since $1 (YYYY-MM-DD HH:MM:SS).
# Prefer dpkg.log (+ rotations / .gz) and apt history.log so daytime
# apt-daily-upgrade still appears after logrotate.
collect_apt_upgraded_packages() {
    _since="$1"
    mkdir -p "$STATE_DIR"
    : > "$APT_UPGRADED_FILE"
    [ -n "$_since" ] || return 0
    _tmp="$(mktemp)"
    # Oldest rotation first, then live — dedupe keeps the first hit per pkg.
    _collect_dpkg_upgrade_gz "$DPKG_LOG.2.gz" "$_since" "$_tmp"
    _collect_dpkg_upgrade_gz "$DPKG_LOG.1.gz" "$_since" "$_tmp"
    _collect_dpkg_upgrade_file "$DPKG_LOG.1" "$_since" "$_tmp"
    _collect_dpkg_upgrade_file "$DPKG_LOG" "$_since" "$_tmp"
    _collect_apt_history_gz "$APT_HISTORY_LOG.2.gz" "$_since" "$_tmp"
    _collect_apt_history_gz "$APT_HISTORY_LOG.1.gz" "$_since" "$_tmp"
    _collect_apt_history_file "$APT_HISTORY_LOG.1" "$_since" "$_tmp"
    _collect_apt_history_file "$APT_HISTORY_LOG" "$_since" "$_tmp"
    # First field is the package name; keep one line per package.
    awk '!seen[$1]++' "$_tmp" > "$APT_UPGRADED_FILE"
    rm -f "$_tmp"
}

write_apt_held_packages() {
    _blacklist="$1"
    mkdir -p "$STATE_DIR"
    : > "$APT_HELD_FILE"
    for _pkg in $_blacklist; do
        [ -n "$_pkg" ] || continue
        _installed=""
        _candidate=""
        _policy="$(apt-cache policy "$_pkg" 2>/dev/null)" || true
        if [ -n "$_policy" ]; then
            _installed="$(printf '%s\n' "$_policy" | awk '/^  Installed:/ { print $2; exit }')"
            _candidate="$(printf '%s\n' "$_policy" | awk '/^  Candidate:/ { print $2; exit }')"
        fi
        if [ -n "$_installed" ] && [ -n "$_candidate" ] \
            && [ "$_installed" != "(none)" ] && [ "$_candidate" != "(none)" ]; then
            printf '%s %s -> %s\n' "$_pkg" "$_installed" "$_candidate" >> "$APT_HELD_FILE"
        else
            printf '%s\n' "$_pkg" >> "$APT_HELD_FILE"
        fi
    done
}

run_apt_upgrade() {
    # A run killed mid-upgrade (systemd stop, reboot) leaves its holds behind,
    # and a stale hold freezes that package for good. Drop ours before deciding
    # what to gate this time.
    apt_gate_unhold
    apt_age_gate_partition
    APT_HELD_BACK_COUNT="$(apt_age_gate_count "$APT_AGE_GATE_HELD")"
    write_apt_held_packages "$APT_AGE_GATE_HELD"
    if [ -n "$APT_AGE_GATE_HELD" ]; then
        log "apt age-gate held back (${APT_HELD_BACK_COUNT}): $APT_AGE_GATE_HELD"
    fi
    if [ -s "$APT_WITHDRAWN_FILE" ]; then
        log "apt withdrawn ($(wc -l < "$APT_WITHDRAWN_FILE" | tr -d ' ')): $(tr '\n' ' ' < "$APT_WITHDRAWN_FILE")"
    fi
    trap apt_gate_cleanup EXIT HUP INT TERM
    apt_age_gate_write_pin
    # Collect since the previous run's watermark so daytime apt-daily-upgrade
    # (and anything else that touched dpkg between 3am cycles) is reported.
    # First run / missing watermark: this window only — avoid dumping the
    # whole dpkg history into Telegram on a fresh host.
    _upgrade_started="$(date '+%Y-%m-%d %H:%M:%S')"
    _collect_since="$_upgrade_started"
    if [ -s "$APT_UPGRADED_SINCE_FILE" ]; then
        _collect_since="$(tr -d '\n' < "$APT_UPGRADED_SINCE_FILE")"
    fi
    _upgrade_rc=0
    if [ -x /usr/local/bin/apt-upgrade-wrapper ]; then
        /usr/local/bin/apt-upgrade-wrapper || _upgrade_rc=$?
    else
        DEBIAN_FRONTEND=noninteractive unattended-upgrade -v --debug || _upgrade_rc=$?
    fi
    # One package apt cannot move must not fail the cycle every night and block
    # the reboot step behind it.
    run_apt_gate_upgrade || mark_warn "apt age-gate upgrade incomplete"
    apt_gate_cleanup
    trap - EXIT HUP INT TERM
    collect_apt_upgraded_packages "$_collect_since"
    # Advance after collect so the next night does not re-list tonight's pkgs.
    date '+%Y-%m-%d %H:%M:%S' > "$APT_UPGRADED_SINCE_FILE"
    return "$_upgrade_rc"
}

# Skip the whole age-gate/unattended-upgrade pass when apt has nothing to upgrade. Still advance
# the dpkg watermark so daytime upgrades are reported.
run_apt_upgrade_if_needed() {
    if [ "$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst')" = 0 ]; then
        log "apt upgrade: nothing upgradable, skipped"
        apt_gate_unhold
        write_apt_held_packages ""
        _since="$(date '+%Y-%m-%d %H:%M:%S')"
        [ -s "$APT_UPGRADED_SINCE_FILE" ] && _since="$(tr -d '\n' < "$APT_UPGRADED_SINCE_FILE")"
        collect_apt_upgraded_packages "$_since"
        date '+%Y-%m-%d %H:%M:%S' > "$APT_UPGRADED_SINCE_FILE"
        return 0
    fi
    run_apt_upgrade
}

run_apt_autoremove_if_needed() {
    if [ "$(apt-get -s autoremove 2>/dev/null | grep -c '^Remv')" = 0 ]; then
        log "apt autoremove: nothing to remove, skipped"
        return 0
    fi
    DEBIAN_FRONTEND=noninteractive apt-get autoremove -y -q
}

# Host logrotate.service reads /etc/logrotate.d/melvbot. Keep it in sync with
# deploy/ so a stale "create ... melvbot melvbot" snippet cannot fail the unit.
run_sync_logrotate() {
    [ -f "$LOGROTATE_SRC" ] || return 1
    if [ -f "$LOGROTATE_DST" ] && cmp -s "$LOGROTATE_SRC" "$LOGROTATE_DST"; then
        return 0
    fi
    install -m 644 "$LOGROTATE_SRC" "$LOGROTATE_DST"
}

_install_if_changed() {
    _src="$1"
    _dst="$2"
    [ -f "$_src" ] || return 1
    if [ -f "$_dst" ] && cmp -s "$_src" "$_dst"; then
        return 1
    fi
    install -D -m 644 "$_src" "$_dst"
    return 0
}

run_sync_ram_host_config() {
    _sysctl_changed=0
    _journald_changed=0
    _install_if_changed "$SYSCTL_RAM_SRC" "$SYSCTL_RAM_DST" && _sysctl_changed=1
    _install_if_changed "$SYSCTL_SWAP_SRC" "$SYSCTL_SWAP_DST" && _sysctl_changed=1
    if [ "$_sysctl_changed" -eq 1 ]; then
        sysctl --system >> "$LOG" 2>&1
    fi
    _install_if_changed "$JOURNALD_RAM_SRC" "$JOURNALD_RAM_DST" && _journald_changed=1
    if [ "$_journald_changed" -eq 1 ]; then
        "$SYSTEMCTL" restart systemd-journald
    fi
}

# Same oneshot as melvbot-timer-sync.path. Daily backup if a DB write's
# PathModified was missed; not a second installer and not a 3am timer.
run_sync_cron_timers() {
    "$SYSTEMCTL" start "$TIMER_SYNC_SERVICE"
}

check_timer_sync_path_enabled() {
    "$SYSTEMCTL" is-enabled "$TIMER_SYNC_PATH" >/dev/null
}

# Copy deploy units if missing or stale, then enable the 5-minute RAM sampler.
# Do not call install-daily-maint-units.sh here: it rewrites daily-maint.service
# while this oneshot is running.
run_sync_mem_sample_timer() {
    _src_dir="$MELVBOT_REPO/deploy"
    mkdir -p "$SYSTEMD_DIR" || return 1
    for _unit in "$MEM_SAMPLE_SERVICE" "$MEM_SAMPLE_TIMER"; do
        _src="$_src_dir/$_unit"
        _dst="$SYSTEMD_DIR/$_unit"
        [ -f "$_src" ] || return 1
        if [ -f "$_dst" ] && cmp -s "$_src" "$_dst"; then
            continue
        fi
        install -m 644 "$_src" "$_dst" || return 1
    done
    "$SYSTEMCTL" daemon-reload || return 1
    "$SYSTEMCTL" enable --now "$MEM_SAMPLE_TIMER"
}

check_mem_sample_timer_enabled() {
    "$SYSTEMCTL" is-enabled "$MEM_SAMPLE_TIMER" >/dev/null
}

run_sample_host_mem() {
    sh "$MEM_SAMPLE_SCRIPT"
}

run_prune_cron_slots() {
    command -v docker >/dev/null 2>&1 || return 0
    docker exec melvbot melvbot cron prune-slots
}

run_prune_host_package_caches() {
    if command -v uv >/dev/null 2>&1 && [ -d "$HOST_UV_CACHE_DIR" ]; then
        UV_CACHE_DIR="$HOST_UV_CACHE_DIR" uv cache prune >> "$LOG" 2>&1 || true
    fi
    if command -v pip3 >/dev/null 2>&1 && [ -d "$HOST_PIP_CACHE_DIR" ]; then
        PIP_CACHE_DIR="$HOST_PIP_CACHE_DIR" pip3 cache purge >> "$LOG" 2>&1 || true
    elif command -v pip >/dev/null 2>&1 && [ -d "$HOST_PIP_CACHE_DIR" ]; then
        PIP_CACHE_DIR="$HOST_PIP_CACHE_DIR" pip cache purge >> "$LOG" 2>&1 || true
    fi
}

run_journal_vacuum() {
    journalctl --vacuum-size="$JOURNAL_VACUUM_SIZE" >> "$LOG" 2>&1
}

# Sunday only. Pull newer base layers, rebuild, and recreate the container
# only when the tagged image ID actually changed.
run_weekly_melvbot_rebuild() {
    _old="$(docker image inspect -f '{{.Id}}' melvbot-ts:latest 2>/dev/null || true)"
    docker compose -f "$COMPOSE_FILE" build --pull melvbot >> "$LOG" 2>&1 || return 1
    _new="$(docker image inspect -f '{{.Id}}' melvbot-ts:latest)" || return 1
    if [ "$_old" = "$_new" ]; then
        return 0
    fi
    log "melvbot image changed ${_old} -> ${_new}, recreating container"
    [ -n "$_old" ] && docker tag "$_old" melvbot-ts:prev
    docker compose -f "$COMPOSE_FILE" up -d --force-recreate melvbot >> "$LOG" 2>&1 || return 1
    # Same stability rule as ddeploy: running with no restarts on 2 checks within 30s, else back to the old image.
    _ok=0
    for _i in $(seq 15); do
        _st="$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' melvbot 2>/dev/null || true)"
        if [ "$_st" = "true 0" ]; then _ok=$((_ok + 1)); [ "$_ok" -ge 2 ] && return 0; else _ok=0; fi
        sleep 2
    done
    log "melvbot not stable after the weekly rebuild, rolling back to ${_old}"
    [ -n "$_old" ] || return 1
    docker tag melvbot-ts:prev melvbot-ts:latest \
        && docker compose -f "$COMPOSE_FILE" up -d --no-build --force-recreate melvbot >> "$LOG" 2>&1
    return 1
}

run_apt_status() {
    mkdir -p "$STATE_DIR"
    _zero=0
    # "0 upgraded, 0 newly installed, 0 to remove and N not upgraded." — installing
    # nothing upgrades nothing, so pending upgrades are the trailing "N not upgraded".
    _pending="$(apt-get --dry-run install 2>/dev/null \
        | awk '/ not upgraded/{print $(NF - 2); exit}')"
    [ -n "$_pending" ] || _pending=1
    if [ "$_pending" -eq "$_zero" ] 2>/dev/null; then
        _updates="updates:done"
    else
        _updates="updates:pending"
    fi
    if [ -f /var/run/reboot-required ]; then
        _reboot="reboot:needed"
    else
        _reboot="reboot:nil"
    fi
    # apt-upgraded.txt is the only source: rewritten each run from dpkg.log /
    # apt history.log since the previous collect watermark (daytime
    # apt-daily-upgrade included, including after logrotate). Empty means
    # nothing upgraded since last night. The dry-run count above is pending
    # work, not work done.
    _upgrades="0"
    if [ -s "$APT_UPGRADED_FILE" ]; then
        _upgrades="$(wc -l < "$APT_UPGRADED_FILE" | tr -d ' ')"
    fi
    _held="${APT_HELD_BACK_COUNT:-0}"
    if [ -s "$APT_HELD_FILE" ]; then
        _held="$(wc -l < "$APT_HELD_FILE" | tr -d ' ')"
    fi
    {
        echo "$_updates"
        echo "upgrades:${_upgrades}"
        echo "held-back:${_held}"
        echo "$_reboot"
        echo "upgraded-packages:"
        if [ -s "$APT_UPGRADED_FILE" ]; then
            cat "$APT_UPGRADED_FILE"
        else
            echo "none"
        fi
        echo "held-packages:"
        if [ -s "$APT_HELD_FILE" ]; then
            cat "$APT_HELD_FILE"
        else
            echo "none"
        fi
        echo "withdrawn-packages:"
        if [ -s "$APT_WITHDRAWN_FILE" ]; then
            cat "$APT_WITHDRAWN_FILE"
        else
            echo "none"
        fi
    } > "$APT_STATUS_FILE"
}

run_docker_stats() {
    command -v docker >/dev/null 2>&1 || return 0
    docker stats --no-stream --format \
        '{{.Name}} mem={{.MemUsage}} cpu={{.CPUPerc}}' \
        "$STATS_CONTAINER_MELVBOT" >> "$LOG" 2>&1
}

archive_maint_report() {
    mkdir -p "$MAINT_REPORT_ARCHIVE_DIR"
    _stamp="$(date +%Y-%m-%d)"
    cp -f "$MAINT_REPORT_FILE" "$MAINT_REPORT_ARCHIVE_DIR/maint-report-${_stamp}.txt"
    find "$MAINT_REPORT_ARCHIVE_DIR" -type f -name 'maint-report-*.txt' \
        -mtime "+$MAINT_REPORT_RETENTION_DAYS" -delete 2>/dev/null || true
}

write_maint_report() {
    mkdir -p "$STATE_DIR"
    {
        echo "timestamp:$(date -Iseconds)"
        df -h / | awk 'NR==2 {printf "disk-root: %s total %s used\n", $2, $3}'
        echo "disk-tmp: $(_tmp_dir_used) used"
        if [ -n "$DOCKER_BUILD_CACHE" ]; then
            echo "docker-build-cache: $DOCKER_BUILD_CACHE"
        else
            echo "docker-build-cache: unavailable"
        fi
        emit_mem_report_fields
        emit_resource_delta_fields
        if [ -f "$APT_STATUS_FILE" ]; then
            # Apt status is snapshotted before we decide to reboot. If this
            # run will issue shutdown -r (reboot-required, no failures), the
            # Telegram line should say done, not needed.
            if [ -f /var/run/reboot-required ] && ! has_failures; then
                sed 's/^reboot:needed$/reboot:done/' "$APT_STATUS_FILE"
            else
                cat "$APT_STATUS_FILE"
            fi
        else
            echo "updates:unknown"
            echo "upgrades:unknown"
            echo "held-back:unknown"
            echo "reboot:unknown"
            echo "upgraded-packages:"
            echo "none"
            echo "held-packages:"
            echo "none"
            echo "withdrawn-packages:"
            echo "none"
        fi
        if has_failures; then
            echo "status:FAIL (${STEP_FAILURES% })"
        elif has_warnings; then
            echo "status:WARN (${STEP_WARNINGS% })"
        else
            echo "status:OK"
        fi
        if [ -n "${STEP_FAILURE_DETAILS:-}" ]; then
            echo "failure-details:"
            printf '%s' "$STEP_FAILURE_DETAILS"
        fi
        if [ -z "${POST_MAINT_FAILURES:-}" ]; then
            echo "health:OK"
        else
            echo "health:FAIL (${POST_MAINT_FAILURES})"
        fi
        echo "versions:"
        if [ -s "$MAINT_REPORT_CHANGES" ]; then
            cat "$MAINT_REPORT_CHANGES"
        else
            echo "no changes"
        fi
    } > "$MAINT_REPORT_FILE"
    archive_maint_report
}

# The Telegram report used to sit on its own 03:30 timer, so it read whatever
# maint-report.txt held at the time: yesterday's file whenever this run outlasted
# the 30-minute gap, and nothing at all on a night the reboot below landed first.
# Sending it from here ties it to the run it describes. Telegram only gets the
# formatted cron run-once message. On success, write the host sentinel so
# OnFailure stays suppressed even if the container could not. A failed send
# is logged and returns 1; track_optional keeps the cycle from being marked
# failed (that would skip a needed reboot).
run_maint_report_job() {
    command -v docker >/dev/null 2>&1 || return 0
    if timeout "$MAINT_REPORT_TIMEOUT_SEC" \
        /home/melvbot/.local/bin/melvbot-compose exec -T melvbot \
        melvbot cron run-once "$MAINT_REPORT_JOB_ID" >> "$LOG" 2>&1; then
        mkdir -p "$STATE_DIR"
        date -Iseconds > "$STATE_DIR/maint-alert-sent"
        return 0
    fi
    log "maint report job failed"
    return 1
}

if [ "${DAILY_MAINT_SOURCE_ONLY:-}" = "1" ]; then
    return 0 2>/dev/null || exit 0
fi

log "daily-maint-melvbot start"
mkdir -p "$STATE_DIR"
if [ "${MAINT_DRY_RUN:-}" != 1 ]; then
    : > "$MAINT_REPORT_CHANGES"
    : > "$APT_UPGRADED_FILE"
    : > "$APT_HELD_FILE"
    : > "$APT_WITHDRAWN_FILE"
fi
[ "${MAINT_DRY_RUN:-}" = 1 ] || rm -f "$STATE_DIR/maint-alert-sent"
track "apt update" run_apt_update
track "apt upgrade" run_apt_upgrade_if_needed
track "apt autoclean" sh -c 'DEBIAN_FRONTEND=noninteractive apt-get autoclean -y -q'
track "apt autoremove" run_apt_autoremove_if_needed
track_optional "grow root filesystem" run_grow_root_fs
track "stale workspace cleanup" run_stale_workspace_cleanup
track "data backup" run_data_backup
track "systemd-tmpfiles --clean" systemd-tmpfiles --clean
track "logrotate config" run_sync_logrotate
track "ram host config" run_sync_ram_host_config
track "sync cron timers" run_sync_cron_timers
track "timer-sync path enabled" check_timer_sync_path_enabled
track "sync mem-sample timer" run_sync_mem_sample_timer
track "mem-sample timer enabled" check_mem_sample_timer_enabled
track "prune cron slots" run_prune_cron_slots
track "docker image prune" run_docker_cleanup
track_optional "claude sdk update" run_claude_sdk_update
track_optional "google calendar tasks" run_google_auth_check
track "assistant login" run_assistant_login_check
track_optional "claude session prune" run_prune_claude_sessions
track "docker container prune" run_container_prune
track "docker builder prune" run_builder_prune
track_optional "host package caches" run_prune_host_package_caches
track "docker stats" run_docker_stats
track "journalctl vacuum" run_journal_vacuum
track "apt status file" run_apt_status
if [ "$(date +%u)" = 7 ]; then
    track "weekly melvbot rebuild" run_weekly_melvbot_rebuild
fi
track "post-maint functional tests" run_post_maint_functional_tests
track "host mem sample" run_sample_host_mem
if [ "${MAINT_DRY_RUN:-}" = 1 ]; then
    finish_summary
    exit $?
fi
write_maint_report
# Non-fatal on purpose: a report that fails to send must not mark the cycle
# failed, because that is what blocks a needed reboot below.
track_optional "maint report job" run_maint_report_job
if [ -f /var/run/reboot-required ]; then
    if has_failures; then
        log "reboot-required set but skipped due to maintenance failures — manual review needed"
    else
        log "reboot-required set — rebooting in ${REBOOT_DELAY_MIN}m"
        shutdown -r "+$REBOOT_DELAY_MIN"
    fi
fi
finish_summary
exit $?
