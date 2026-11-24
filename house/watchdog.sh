#!/usr/bin/env bash
# House runner watchdog (run every minute by picked-off-house-watchdog.timer). Restarts the runner's
# unit when its /healthz shows no finished round in a pool for more than MAX_AGE_SEC, or when
# /healthz has not answered on FAILS_BEFORE_RESTART consecutive runs. Does nothing while the unit is
# stopped on purpose or still starting. Also repeats a low-balance alarm from /healthz.
#   env: UNIT=picked-off-house HEALTH_URL=http://127.0.0.1:8788/healthz MAX_AGE_SEC=180
#        GRACE_SEC=240 FAILS_BEFORE_RESTART=3 WATCHDOG_STATE=/run/picked-off-watchdog
set -u
UNIT=${UNIT:-picked-off-house}
URL=${HEALTH_URL:-http://127.0.0.1:8788/healthz}
MAX_AGE=${MAX_AGE_SEC:-180}
GRACE=${GRACE_SEC:-240}
FAILS_MAX=${FAILS_BEFORE_RESTART:-3}
STATE=${WATCHDOG_STATE:-/run/picked-off-watchdog}
mkdir -p "$STATE"
say() { echo "picked-off-watchdog: $*"; }

systemctl is-active --quiet "$UNIT" || { rm -f "$STATE/fails"; exit 0; }
# seconds since the unit (re)started
enter=$(systemctl show -p ActiveEnterTimestampMonotonic --value "$UNIT")
now=$(awk '{printf "%d", $1 * 1000000}' /proc/uptime)
up=$(( (now - ${enter:-0}) / 1000000 ))
body=$(curl -s -m 10 "$URL")
if [ -n "$body" ] && [ "$(echo "$body" | jq -r '.recording' 2>/dev/null)" = "false" ]; then
  say "LOW HOUSE BALANCE: $(echo "$body" | jq -r '.balanceSol') SOL < $(echo "$body" | jq -r '.minBalanceSol') SOL, records stopped"
fi
[ "$up" -lt "$GRACE" ] && exit 0
if [ -z "$body" ] || ! echo "$body" | jq -e . >/dev/null 2>&1; then
  n=$(( $(cat "$STATE/fails" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$STATE/fails"
  say "healthz did not answer ($n/$FAILS_MAX)"
  if [ "$n" -ge "$FAILS_MAX" ]; then
    say "RESTART $UNIT: healthz silent on $n runs"
    rm -f "$STATE/fails"
    systemctl restart "$UNIT"
  fi
  exit 0
fi
rm -f "$STATE/fails"

# a pool with no finished round for > MAX_AGE (null = none since the start, which is > GRACE ago)
stale=$(echo "$body" | jq -r --argjson max "$MAX_AGE" '[.pools[] | select(.lastRoundAgeSec == null or .lastRoundAgeSec > $max) | "\(.pool):\(.lastRoundAgeSec)"] | join(",")')
if [ -n "$stale" ]; then
  say "RESTART $UNIT: no round progress for > ${MAX_AGE}s in pool(s) $stale (uptime ${up}s)"
  systemctl restart "$UNIT"
fi
exit 0
