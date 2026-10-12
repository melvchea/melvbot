#!/bin/sh
# Sourced by daily-maint-melvbot.sh. Grow / to fill a resized disk (e.g. 100G
# partition on a 200G vda). Expects LOG, log(), and a root shell.

run_grow_root_fs() {
    command -v findmnt >/dev/null 2>&1 || return 0
    command -v lsblk >/dev/null 2>&1 || return 0
    _root="$(findmnt -n -o SOURCE /)"
    [ -n "$_root" ] || return 0
    _pk="$(lsblk -nro PKNAME "$_root" 2>/dev/null | tr -d '[:space:]')"
    _part="$(lsblk -nro PARTN "$_root" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$_pk" ] && [ -n "$_part" ] || return 0
    # lsblk -n still pads PARTN; reject anything that is not all digits.
    case "$_part" in
        ''|*[!0-9]*) return 0 ;;
    esac
    _disk="/dev/${_pk}"
    if ! command -v growpart >/dev/null 2>&1; then
        if command -v apt-get >/dev/null 2>&1; then
            DEBIAN_FRONTEND=noninteractive apt-get install -y -q cloud-guest-utils \
                >> "$LOG" 2>&1 || return 1
        fi
    fi
    command -v growpart >/dev/null 2>&1 || {
        log "growpart missing; ${_disk}${_part} not grown"
        return 1
    }
    _out="$(growpart "$_disk" "$_part" 2>&1)" || true
    printf '%s\n' "$_out" >> "$LOG"
    case "$_out" in
        *NOCHANGE*) return 0 ;;
        *CHANGED*) ;;
        *)
            log "growpart failed on ${_disk} partition ${_part}"
            return 1
            ;;
    esac
    _fstype="$(findmnt -n -o FSTYPE /)"
    case "$_fstype" in
        xfs)
            command -v xfs_growfs >/dev/null 2>&1 || return 1
            xfs_growfs / >> "$LOG" 2>&1
            ;;
        ext4|ext3)
            command -v resize2fs >/dev/null 2>&1 || return 1
            resize2fs "$_root" >> "$LOG" 2>&1
            ;;
        *)
            log "unsupported fstype ${_fstype} for grow"
            return 1
            ;;
    esac
}
