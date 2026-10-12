#!/bin/sh
# Sourced by daily-maint-melvbot.sh. Nightly, age-gated upgrade of @anthropic-ai/claude-agent-sdk:
# act only when npm's latest is newer than the package-lock version AND was published at least
# CLAUDE_SDK_MIN_AGE_DAYS ago. Then npm install, type check, full tests, deploy and the post-maint
# checks; any failure restores package.json/package-lock.json, reinstalls, and redeploys if the
# deploy already ran. On success commits only the two package files to main and pushes (push
# failure = warning, no rollback).
# Expects LOG, MELVBOT_REPO, log(), record_change(), record_fail_detail(), mark_warn(),
# run_post_maint_functional_tests(). MAINT_DRY_RUN=1 only checks and logs.

CLAUDE_SDK_PKG="@anthropic-ai/claude-agent-sdk"
CLAUDE_SDK_URL="${CLAUDE_SDK_URL:-https://registry.npmjs.org/$CLAUDE_SDK_PKG}"
CLAUDE_SDK_MIN_AGE_DAYS="${CLAUDE_SDK_MIN_AGE_DAYS:-3}"
CLAUDE_SDK_TS_DIR="${CLAUDE_SDK_TS_DIR:-$MELVBOT_REPO/ts}"

_sdk_installed() {
    jq -r --arg p "node_modules/$CLAUDE_SDK_PKG" '.packages[$p].version // empty' "$CLAUDE_SDK_TS_DIR/package-lock.json"
}

_sdk_in_ts() { (cd "$CLAUDE_SDK_TS_DIR" && "$@" >>"$LOG" 2>&1); }

_sdk_restore() {
    cp "$1/package.json" "$1/package-lock.json" "$CLAUDE_SDK_TS_DIR/"
    _sdk_in_ts npm ci --cache "$1/npm"
}

run_claude_sdk_update() {
    command -v jq >/dev/null 2>&1 || { log "claude sdk: jq missing"; return 1; }
    _json="$(curl -fsS --max-time 20 "$CLAUDE_SDK_URL" 2>/dev/null)" || { log "claude sdk: registry fetch failed"; return 1; }
    _new="$(printf '%s' "$_json" | jq -r '.["dist-tags"].latest // empty')"
    _pub="$(printf '%s' "$_json" | jq -r --arg v "$_new" '.time[$v] // empty')"
    _old="$(_sdk_installed)"
    if [ -z "$_new" ] || [ -z "$_pub" ] || [ -z "$_old" ]; then
        log "claude sdk: could not determine versions (new=$_new old=$_old)"
        return 1
    fi
    if [ "$_new" = "$_old" ] || [ "$(printf '%s\n%s\n' "$_old" "$_new" | sort -V | tail -n1)" != "$_new" ]; then
        log "claude sdk: $_old is current"
        return 0
    fi
    _age=$(( ($(date +%s) - $(date -d "$_pub" +%s)) / 86400 ))
    if [ "$_age" -lt "$CLAUDE_SDK_MIN_AGE_DAYS" ]; then
        log "claude sdk: $_new is ${_age}d old (< ${CLAUDE_SDK_MIN_AGE_DAYS}d); holding $_old"
        return 0
    fi
    if [ "${MAINT_DRY_RUN:-}" = 1 ]; then
        log "claude sdk: [dry-run] would upgrade $_old -> $_new (${_age}d old)"
        return 0
    fi

    _tmp="$(mktemp -d)" || return 1
    cp "$CLAUDE_SDK_TS_DIR/package.json" "$CLAUDE_SDK_TS_DIR/package-lock.json" "$_tmp/"
    # Other pending edits in the package files: upgrade but leave them out of our commit.
    _dirty=0
    git -C "$MELVBOT_REPO" diff --quiet HEAD -- ts/package.json ts/package-lock.json || _dirty=1
    _deployed=0
    _step=install
    if _sdk_in_ts npm install "$CLAUDE_SDK_PKG@$_new" --save --cache "$_tmp/npm" \
        && _step=tcheck && _sdk_in_ts tcheck \
        && _step=ttest && _sdk_in_ts ttest \
        && _step=ddeploy && _deployed=1 && _sdk_in_ts ddeploy \
        && _step=post-maint && run_post_maint_functional_tests; then
        :
    else
        log "claude sdk: $_new failed at $_step; rolling back to $_old"
        _sdk_restore "$_tmp"
        [ "$_deployed" = 1 ] && _sdk_in_ts ddeploy
        record_fail_detail "claude sdk update" "$_new failed at $_step; rolled back to $_old"
        rm -rf "$_tmp"
        return 1
    fi
    rm -rf "$_tmp"
    record_change "claude-agent-sdk" "$_old" "$_new"
    if [ "$_dirty" = 1 ]; then
        log "claude sdk: upgraded $_old -> $_new; package files had other changes, not committing"
        return 0
    fi
    if git -C "$MELVBOT_REPO" commit -q -m "deps: claude-agent-sdk $_old -> $_new (nightly, age-gated)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- ts/package.json ts/package-lock.json >>"$LOG" 2>&1; then
        git -C "$MELVBOT_REPO" push -q origin main >>"$LOG" 2>&1 \
            || { log "claude sdk: push failed"; mark_warn "claude sdk push"; }
    else
        log "claude sdk: commit failed"
        mark_warn "claude sdk commit"
    fi
    return 0
}
