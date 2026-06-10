#!/usr/bin/env bash
# butchr health watchdog — restart butchr if its /health endpoint is unreachable
# or reports a degraded/stale dispatcher tick.
#
# Designed to run from butchr-health.timer every ~30s, but safe to run by hand.
# Dependency-free: just curl + bash (no jq). It restarts the service via
# `systemctl --user restart`, which also clears any crash-loop StartLimit so a
# service that systemd gave up on is revived.
#
# Env knobs:
#   BUTCHR_HEALTH_URL      health endpoint        (default http://127.0.0.1:47800/health)
#   BUTCHR_SERVICE         user unit to restart   (default butchr.service)
#   BUTCHR_HEALTH_TIMEOUT  curl timeout, seconds  (default 5)
set -u

URL="${BUTCHR_HEALTH_URL:-http://127.0.0.1:47800/health}"
SERVICE="${BUTCHR_SERVICE:-butchr.service}"
CURL_TIMEOUT="${BUTCHR_HEALTH_TIMEOUT:-5}"

log() { echo "[health-watchdog] $*" >&2; }

restart() {
  log "restarting ${SERVICE}: $1"
  systemctl --user restart "$SERVICE"
  exit 0
}

# One shot: body, then a trailing line with the HTTP status code. On a connection
# failure curl exits non-zero (and -f makes a 5xx itself a non-zero exit too, but
# we still parse the code below for a precise reason).
resp="$(curl -sS --max-time "$CURL_TIMEOUT" -w $'\n%{http_code}' "$URL" 2>/dev/null)"
rc=$?
if [[ $rc -ne 0 ]]; then
  restart "endpoint unreachable (curl exit ${rc}) at ${URL}"
fi

code="${resp##*$'\n'}"
body="${resp%$'\n'*}"

# 503 = degraded (DB unreachable or dispatcher tick wedged); treat anything that
# is not a 2xx as a reason to restart.
if [[ ! "$code" =~ ^2[0-9][0-9]$ ]]; then
  restart "HTTP ${code} (degraded)"
fi

# Belt-and-suspenders: even on a 200, compare the dispatcher tick age to its own
# stale threshold, in case the server reports healthy while the loop is drifting.
# Pure-shell JSON peek; if either field is absent (e.g. ageMs is null before the
# first tick) we simply skip this check.
age="$(printf '%s' "$body" | grep -oE '"ageMs":[0-9]+' | head -1 | grep -oE '[0-9]+$')"
stale="$(printf '%s' "$body" | grep -oE '"staleAfterMs":[0-9]+' | head -1 | grep -oE '[0-9]+$')"
if [[ -n "$age" && -n "$stale" && "$age" -gt "$stale" ]]; then
  restart "dispatcher tick stale (ageMs=${age} > staleAfterMs=${stale})"
fi

log "ok (HTTP ${code})"
