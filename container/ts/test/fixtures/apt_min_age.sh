#!/bin/bash
# Prints the hold-back seconds apt_min_age_for picks for sample upgradable lines.
# $1: path to daily-maint-melvbot.sh (only the constants and the function are loaded).
eval "$(sed -n '/^APT_MIN_AGE_SEC=/,/^APT_MIN_AGE_CRITICAL_SEC=/p;/^apt_min_age_for()/,/^}/p' "$1")"
apt_min_age_for curl "curl/noble-security 1 amd64"
apt_min_age_for curl "curl/noble-updates 1 amd64"
apt_min_age_for linux-image-6.8 "linux-image-6.8/noble-security 1 amd64"
apt_min_age_for docker-ce "docker-ce/noble stable 1 amd64"
