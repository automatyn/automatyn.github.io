#!/usr/bin/env bash
# Aggressive outreach autopilot.
#
# Repeatedly: enrich → personalise → send-e1, until daily cap is hit or we run out.
# Designed to be resumable (lock files protect against double-runs).
#
# Usage: ./aggressive-loop.sh [iterations]
#   iterations defaults to 6 (each iteration: 200 enrich + 100 personalise + e1 cap)

set -uo pipefail
cd "$(dirname "$0")"

ITERATIONS="${1:-6}"
LOG="/tmp/aggressive-loop.log"
echo "[$(date -u +%H:%M:%SZ)] aggressive-loop start, iterations=$ITERATIONS" | tee -a "$LOG"

for i in $(seq 1 "$ITERATIONS"); do
  echo "[$(date -u +%H:%M:%SZ)] === iteration $i/$ITERATIONS ===" | tee -a "$LOG"

  # 1. Enrich next 100 leads (mix of static + Playwright)
  echo "[$(date -u +%H:%M:%SZ)] enrich 100..." | tee -a "$LOG"
  timeout 900 node enrich-emails.js 100 2>&1 | tee -a "$LOG" | grep -E "^✓|^Done|Tier" | tail -10

  # 2. Auto-personalise everything still waiting (no cap; cheap operation)
  echo "[$(date -u +%H:%M:%SZ)] auto-personalise..." | tee -a "$LOG"
  timeout 600 node personalise.js auto 200 2>&1 | tee -a "$LOG" | grep -E "^Done" | tail -2

  # 3. Send e1 up to remaining daily cap. The sender's lock prevents collision
  #    with any other sender e1 the user might invoke manually.
  echo "[$(date -u +%H:%M:%SZ)] send e1 batch..." | tee -a "$LOG"
  timeout 1800 node sender.js e1 25 2>&1 | tee -a "$LOG" | tail -10

  # If sender hit the cap, exit early
  if grep -q "Daily cap reached" "$LOG"; then
    echo "[$(date -u +%H:%M:%SZ)] daily cap reached, stopping loop" | tee -a "$LOG"
    break
  fi

  # Brief pause between iterations
  sleep 5
done

echo "[$(date -u +%H:%M:%SZ)] aggressive-loop done" | tee -a "$LOG"
