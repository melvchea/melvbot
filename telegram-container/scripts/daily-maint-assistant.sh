#!/bin/sh
# Sourced by daily-maint-melvbot.sh. Claude Agent SDK upkeep: a live login probe
# (subscription limit / expired token) and pruning of old session transcripts.
# Expects MELVBOT_DATA, LOG, log(), record_fail_detail().

ASSISTANT_CHECK_CONTAINER="${ASSISTANT_CHECK_CONTAINER:-melvbot}"
DOCTOR_PROBE_FILE="${DOCTOR_PROBE_FILE:-${STATE_DIR:-}/doctor-probe.out}"
CLAUDE_SESSION_RETENTION_DAYS="${CLAUDE_SESSION_RETENTION_DAYS:-7}"
CLAUDE_SESSION_DIR="${CLAUDE_SESSION_DIR:-$MELVBOT_DATA/runtime/.claude/projects}"

# One-token Haiku call through the same login the bot uses. A failure here
# means every Telegram turn is failing too.
run_assistant_login_check() {
    _out="$(docker exec "$ASSISTANT_CHECK_CONTAINER" melvbot doctor --probe 2>&1)" || true
    printf '%s\n' "$_out" >> "$LOG"
    # Reused by post-maint _check_doctor so doctor is not run twice.
    printf '%s\n' "$_out" > "$DOCTOR_PROBE_FILE" 2>/dev/null || true
    _line="$(printf '%s\n' "$_out" | grep -A1 -E '^assistant provider( probe)?: error' | tr '\n' ' ' | cut -c1-240)"
    if [ -z "$_line" ]; then
        printf '%s\n' "$_out" | grep -q '^assistant provider probe: ok' && return 0
        _line="no assistant probe result (container down?)"
    fi
    record_fail_detail "assistant login" "$_line"
    return 1
}

# Session transcripts older than the retention window can no longer be resumed
# (idle_reset_hours is far shorter), so they are safe to drop.
run_prune_claude_sessions() {
    [ -d "$CLAUDE_SESSION_DIR" ] || return 0
    _removed="$(find "$CLAUDE_SESSION_DIR" -type f -mtime +"$CLAUDE_SESSION_RETENTION_DAYS" -print -delete | wc -l)"
    find "$CLAUDE_SESSION_DIR" -mindepth 2 -type d -empty -delete 2>/dev/null || true
    log "claude sessions: removed ${_removed} transcripts older than ${CLAUDE_SESSION_RETENTION_DAYS}d"
}
