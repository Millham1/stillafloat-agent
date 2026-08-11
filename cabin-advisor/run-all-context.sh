#!/usr/bin/env bash
# Layer 2 batch: research context zones for EVERY captured class.
#
# Oasis (wonder-of-the-seas) runs FIRST on purpose — it is the only class with
# hand-researched cabins to check against, so it verifies the prompt grounding
# before the rest of the money is spent. See DESIGN.md section 4.
#
# Usage: ANTHROPIC_API_KEY=... ./run-all-context.sh
set -uo pipefail
cd "$(dirname "$0")"

mkdir -p context logs
LOG="logs/context-batch-$(date +%Y%m%d-%H%M%S).log"

slugs=$(ls data/cabins/*-full.json | xargs -n1 basename | sed 's/-full\.json$//')
ordered=$(printf '%s\n' "wonder-of-the-seas"; printf '%s\n' "$slugs" | grep -v '^wonder-of-the-seas$')
total=$(printf '%s\n' "$ordered" | wc -l | tr -d ' ')

echo "Layer 2 context research — $total classes" | tee -a "$LOG"
i=0; ok=0; failed=""
for slug in $ordered; do
  i=$((i+1))
  printf '[%2d/%d] %-34s ' "$i" "$total" "$slug" | tee -a "$LOG"
  if out=$(node research-class-context.mjs "$slug" 2>&1); then
    zones=$(echo "$out" | grep -oE '^[0-9]+ zones' | head -1)
    cov=$(echo "$out" | grep -oE 'covering [0-9]+/[0-9]+ cabins \([0-9]+%\)' | head -1)
    echo "ok  $zones  $cov" | tee -a "$LOG"
    ok=$((ok+1))
  else
    echo "FAILED: $(echo "$out" | tail -1)" | tee -a "$LOG"
    failed="$failed $slug"
  fi
  sleep 2   # be polite to the API
done

echo "" | tee -a "$LOG"
echo "Done: $ok/$total succeeded." | tee -a "$LOG"
[ -n "$failed" ] && echo "Failed:$failed" | tee -a "$LOG"
echo "Context files: $(ls context/*.json 2>/dev/null | wc -l | tr -d ' ')" | tee -a "$LOG"
