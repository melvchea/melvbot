#!/bin/sh
# Sourced by daily-maint-melvbot.sh. Google Calendar/Tasks health check for 3am
# maint. Uses the Node CLI (no Python venv). Expects LOG, log(),
# record_fail_detail.

GOOGLE_CHECK_CONTAINER="${GOOGLE_CHECK_CONTAINER:-melvbot}"

run_google_auth_check() {
    _cal="$(
        docker exec "$GOOGLE_CHECK_CONTAINER" \
            melvbot google calendar list --max 5 2>&1
    )" || true
    _tasks="$(
        docker exec "$GOOGLE_CHECK_CONTAINER" \
            melvbot google tasks list --max 5 2>&1
    )" || true
    printf '%s\n' "$_cal" >> "$LOG"
    printf '%s\n' "$_tasks" >> "$LOG"

    _cal_ok=0
    _tasks_ok=0
    printf '%s\n' "$_cal" | grep -q '^\[' && _cal_ok=1
    printf '%s\n' "$_tasks" | grep -q '^\[' && _tasks_ok=1
    if [ "$_cal_ok" -eq 1 ] && [ "$_tasks_ok" -eq 1 ]; then
        return 0
    fi

    _detail="calendar or tasks list failed"
    printf '%s\n' "$_cal" | grep -q '^error:' && _detail="$(printf '%s\n' "$_cal" | grep '^error:' | tail -n 1)"
    printf '%s\n' "$_tasks" | grep -q '^error:' && _detail="$(printf '%s\n' "$_tasks" | grep '^error:' | tail -n 1)"
    record_fail_detail "google calendar tasks" "$_detail"
    return 1
}
