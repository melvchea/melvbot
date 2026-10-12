#!/bin/sh
# Sourced by daily-maint-melvbot.sh. 3am allowlisted stale workspace cleanup:
# leftover sqlite copies and pytest scratch dirs. Expects MELVBOT_WORKSPACE, MELVBOT_REPO,
# MELVBOT_DATA, LOG, log(). Missing tmp/data dirs are success.

_stale_rm_sqlite_triplet() {
    _base="$1"
    [ -n "$_base" ] || return 0
    rm -f "$_base" "${_base}-wal" "${_base}-shm"
}

_stale_rm_glob_sqlite() {
    _root="$1"
    _pat="$2"
    [ -d "$_root" ] || return 0
    find "$_root" -maxdepth 1 -type f \( \
        -name "$_pat" -o \
        -name "${_pat}-wal" -o \
        -name "${_pat}-shm" \
    \) -exec rm -f {} +
}

_stale_cleanup_sqlite() {
    if [ -d "$MELVBOT_DATA" ]; then
        _stale_rm_sqlite_triplet "$MELVBOT_DATA/runtime/cron_jobs.db"
        _stale_rm_sqlite_triplet "$MELVBOT_DATA/runtime/gate/run/cron_jobs.db"
        _stale_rm_glob_sqlite "$MELVBOT_DATA/ledgers/backups" \
            "ledgers-*.sqlite3"
    fi
    log "stale sqlite: allowlisted leftovers removed"
}

_stale_cleanup_pytest() {
    _tmp="$MELVBOT_WORKSPACE/.melvbot-tmp"
    if [ -d "$_tmp" ]; then
        find "$_tmp" -maxdepth 1 -type d \( \
            -name 'pytest-*' -o \
            -name 'pytest-of-*' -o \
            -name 'melvbot-cron-units-*' -o \
            -name 'tmp*' \
        \) ! -path "$_tmp" -exec rm -rf {} +
    fi
    for _cache in \
        "$MELVBOT_WORKSPACE/.pytest_cache" \
        "$MELVBOT_REPO/.pytest_cache" \
        "$MELVBOT_WORKSPACE/.melvbot-tmp/wt-head/.pytest_cache"
    do
        [ -e "$_cache" ] || continue
        rm -rf "$_cache"
    done
    log "stale pytest: allowlisted leftovers removed"
}

run_stale_workspace_cleanup() {
    _stale_cleanup_sqlite
    _stale_cleanup_pytest
    return 0
}
