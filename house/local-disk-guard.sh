#!/usr/bin/env bash
# Local-stack disk guard: every 30 s checks free space on / and on the base ledger's disk; below the
# limit it stops the house runner (SIGTERM through its pid file) and then the local stack (SIGINT to
# its process group), so a full disk never takes other work on the machine down with it.
#   house/local-disk-guard.sh [ledger dir] &      (env: MIN_ROOT_MB=1536 MIN_LEDGER_MB=3072)
set -u
STATE=${HOUSE_STATE:-$HOME/.local/state/picked-off}
LEDGER=${1:-}
MIN_ROOT_MB=${MIN_ROOT_MB:-1536}
MIN_LEDGER_MB=${MIN_LEDGER_MB:-3072}
free_mb() { df -Pm "$1" | awk 'NR==2 {print $4}'; }
echo $$ > "$STATE/local-disk-guard.pid"
while true; do
  root=$(free_mb /)
  led=$([ -n "$LEDGER" ] && free_mb "$LEDGER" || echo 999999)
  if [ "$root" -lt "$MIN_ROOT_MB" ] || [ "$led" -lt "$MIN_LEDGER_MB" ]; then
    echo "$(date -u +%FT%TZ) disk low (/: ${root} MB, ledger disk: ${led} MB): stopping the runner and the local stack"
    [ -f "$STATE/house-local.pid" ] && kill -TERM "$(cat "$STATE/house-local.pid")"
    sleep 5
    [ -f "$STATE/local-stack.pgid" ] && kill -INT -- "-$(cat "$STATE/local-stack.pgid")"
    exit 0
  fi
  sleep 30
done
