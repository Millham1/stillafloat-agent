#!/bin/bash
# install-canary.sh — put the alert canary on the DEV box and give PROD the
# matching read-only token. Run from the Mac (it has SSH to both boxes).
#
# Secrets are generated and written over SSH; NOTHING is echoed. CANARY_TOKEN is
# internal-only (prod <-> dev) and buys exactly one integer: the device count.
#
# The timer is NOT enabled unless a transport is configured, because a canary
# that cannot reach anyone is worse than none — it looks like coverage.
#
# Usage:  bash install-canary.sh [--arm]
#   (no flag) install + configure, leave the timer stopped
#   --arm     also enable/start the timer (requires NTFY_TOPIC already set on dev)

set -euo pipefail

PROD=root@5.161.52.102
DEV=saf-dev
HERE="$(cd "$(dirname "$0")" && pwd)"
ARM=0
[ "${1:-}" = "--arm" ] && ARM=1

echo "==> Ensuring CANARY_TOKEN exists on prod (generated there, never printed)"
ssh "$PROD" 'ENV=/opt/stillafloat/shared.env
  if ! grep -q "^CANARY_TOKEN=" "$ENV" 2>/dev/null; then
    T=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n")
    printf "CANARY_TOKEN=%s\n" "$T" >> "$ENV"
    echo "   prod: CANARY_TOKEN created"
  else
    echo "   prod: CANARY_TOKEN already present (kept)"
  fi'

echo "==> Copying the same token to dev (value moves host-to-host, never to screen)"
TOKEN_B64=$(ssh "$PROD" 'grep -m1 "^CANARY_TOKEN=" /opt/stillafloat/shared.env | cut -d= -f2- | tr -d "\"" | tr -d "\n" | base64')
ssh "$DEV" "ENV=/opt/stillafloat/shared.env
  T=\$(printf '%s' '$TOKEN_B64' | base64 --decode)
  touch \"\$ENV\"
  sed -i '/^CANARY_TOKEN=/d' \"\$ENV\"
  printf 'CANARY_TOKEN=%s\n' \"\$T\" >> \"\$ENV\"
  grep -q '^PROD_HEALTH_URL=' \"\$ENV\" || printf 'PROD_HEALTH_URL=%s\n' 'https://stillafloatcruising.com/api/healthz' >> \"\$ENV\"
  grep -q '^NTFY_URL=' \"\$ENV\" || printf 'NTFY_URL=%s\n' 'https://ntfy.sh' >> \"\$ENV\"
  echo '   dev: CANARY_TOKEN + defaults written'"

echo "==> Installing the canary on dev"
scp -q "$HERE/alert-canary.py"    "$DEV:/opt/stillafloat/alert-canary.py"
scp -q "$HERE/saf-canary.service" "$DEV:/etc/systemd/system/saf-canary.service"
scp -q "$HERE/saf-canary.timer"   "$DEV:/etc/systemd/system/saf-canary.timer"
ssh "$DEV" 'chmod 0755 /opt/stillafloat/alert-canary.py && mkdir -p /var/lib/saf-canary && systemctl daemon-reload && echo "   dev: units installed"'

echo "==> Dry run (one probe, no timer)"
ssh "$DEV" 'CANARY_STATE=/tmp/canary-dryrun.json /usr/bin/python3 /opt/stillafloat/alert-canary.py || true'

if [ "$ARM" -eq 1 ]; then
  if ssh "$DEV" 'grep -q "^NTFY_TOPIC=." /opt/stillafloat/shared.env'; then
    ssh "$DEV" 'systemctl enable --now saf-canary.timer && systemctl list-timers saf-canary.timer --no-pager | head -3'
    echo "==> ARMED — the canary now watches prod every 10 minutes."
  else
    echo "==> REFUSING to arm: NTFY_TOPIC is not set on dev." >&2
    echo "    A canary with no way to reach anyone is worse than none: it looks like coverage." >&2
    exit 2
  fi
else
  echo "==> Installed but NOT armed. Re-run with --arm once a transport is set."
fi
