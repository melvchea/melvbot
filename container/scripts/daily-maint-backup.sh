#!/bin/sh
# Sourced by daily-maint-melvbot.sh. Nightly backup of melvbot state: online
# copies of every sqlite db plus small state files, as a dated tar.gz. Secrets
# (melvbot.env, google-home, microsoft-home, xdg-cache, gate) are never copied.
# Expects MELVBOT_DATA, MAINT_REPORT_CHANGES, log(), record_fail_detail().

BACKUP_DIR="${BACKUP_DIR:-$MELVBOT_DATA/backups/daily}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_OWNER="${BACKUP_OWNER:-melvbot:melvbot}"

_backup_fail() {
    record_fail_detail "data backup" "$1"
    [ -z "${_stage:-}" ] || rm -rf "$_stage"
    return 1
}

run_data_backup() {
    [ -d "$MELVBOT_DATA" ] || return 0
    _stamp="$(TZ=Asia/Singapore date +%F)"
    _stage="$(mktemp -d)" || { record_fail_detail "data backup" "mktemp failed"; return 1; }
    _list="$_stage/files.list"
    _root="$_stage/root"
    mkdir -p "$_root" "$BACKUP_DIR"

    # find over config/ and runtime/ minus secrets, caches, locks and old backups.
    _backup_find() {
        (cd "$MELVBOT_DATA" && find config runtime \
            \( -path config/melvbot.env -o -path config/google-home \
               -o -path config/microsoft-home -o -path runtime/xdg-cache \
               -o -path runtime/gate \) -prune -o \
            -type f ! -name '*.lock' ! -name '*.bak-*' "$@" -print)
    }

    # Online-consistent copy of each db (WAL safe), then integrity check.
    _backup_find \( -name '*.sqlite3' -o -name '*.db' \) | while IFS= read -r _db; do
        mkdir -p "$_root/$(dirname "$_db")"
        python3 -c '
import sqlite3, sys
src = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True, timeout=30)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
r = dst.execute("PRAGMA integrity_check").fetchone()[0]
dst.close()
src.close()
if r != "ok":
    print("integrity_check: " + r)
    sys.exit(1)
' "$MELVBOT_DATA/$_db" "$_root/$_db" >> "$LOG" 2>&1 || {
            log "backup: failed db ${_db}"
            echo "$_db" >> "$_stage/db-failed"
        }
    done
    if [ -s "$_stage/db-failed" ]; then
        _backup_fail "db copy/integrity failed: $(tr '\n' ' ' < "$_stage/db-failed")"
        return 1
    fi

    # Small state files: config/*.json, config/state/**, runtime/*.json, runtime/melvbot.toml.
    _backup_find ! -name '*.sqlite3' ! -name '*.db' ! -name '*.sqlite3-*' ! -name '*.db-*' \
        | grep -E '^(config/[^/]+\.json|config/state/|runtime/[^/]+\.json|runtime/melvbot\.toml$)' > "$_list" || true
    if [ -s "$_list" ]; then
        (cd "$MELVBOT_DATA" && tar -cf - -T "$_list") | tar -xf - -C "$_root" \
            || { _backup_fail "state file copy failed"; return 1; }
    fi

    _out="$BACKUP_DIR/${_stamp}.tar.gz"
    _tmp="${_out}.tmp"
    (umask 077 && tar -czf "$_tmp" -C "$_root" .) \
        || { rm -f "$_tmp"; _backup_fail "tar failed"; return 1; }
    if ! tar -tzf "$_tmp" >/dev/null 2>&1; then
        rm -f "$_tmp"
        _backup_fail "tar verify failed"
        return 1
    fi
    chmod 0600 "$_tmp"
    chown "$BACKUP_OWNER" "$_tmp" 2>/dev/null || true
    mv -f "$_tmp" "$_out"
    rm -rf "$_stage"

    # Retention: newest BACKUP_KEEP.
    ls -1 "$BACKUP_DIR"/*.tar.gz 2>/dev/null | sort -r | tail -n +"$((BACKUP_KEEP + 1))" \
        | while IFS= read -r _old; do rm -f "$_old"; done

    _n="$(ls -1 "$BACKUP_DIR"/*.tar.gz 2>/dev/null | wc -l | tr -d ' ')"
    _size="$(du -h "$_out" | awk '{print $1}')"
    log "data backup: ${_out} ${_size} (${_n} kept)"
    echo "data-backup: ${_size}, ${_n} kept" >> "$MAINT_REPORT_CHANGES"
}
