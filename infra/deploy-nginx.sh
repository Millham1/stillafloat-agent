#!/usr/bin/env bash
# Still Afloat (monorepo) — deploy the dashboard subdomain nginx config.
# SOURCE OF TRUTH: this file in GitHub (stillafloat-agent, infra/deploy-nginx.sh).
# The box only RECEIVES this; never hand-edit nginx on the server.
# Idempotent, self-verifying, auto-reverting. Safe to run repeatedly.
#
# Environment-aware: only manages the dashboard server block on a host that has
# the dashboard TLS cert (prod). On dev (no cert / no subdomain) it no-ops.
set -euo pipefail

CERT="/etc/letsencrypt/live/dashboard.stillafloatcruising.com/fullchain.pem"
SITE="/etc/nginx/sites-enabled/default"
DEST="/etc/nginx/sites-enabled/saf-dashboard.conf"
SRC="$(cd "$(dirname "$0")" && pwd)/nginx/dashboard.stillafloatcruising.com.conf"
BK_DIR="/root/nginx-backups"
TS="$(date +%Y%m%d-%H%M%S)"

if ! command -v nginx >/dev/null 2>&1; then
  echo "nginx not installed — skipping dashboard nginx config"; exit 0
fi
if [ ! -f "$CERT" ]; then
  echo "No dashboard TLS cert ($CERT) — not the prod dashboard host; skipping."; exit 0
fi
[ -f "$SRC" ] || { echo "ERR: source conf $SRC missing"; exit 1; }

# Install the mTLS CA (public cert only — the CA private key never touches the
# server or the repo). The dashboard conf references this path for client-cert
# verification, so install it first or `nginx -t` will fail.
CA_SRC="$(cd "$(dirname "$0")" && pwd)/nginx/saf-dashboard-ca.crt"
CA_DEST="/etc/nginx/saf-dashboard-ca.crt"
if [ -f "$CA_SRC" ]; then
  cp "$CA_SRC" "$CA_DEST"
  echo "installed CA: $CA_DEST"
else
  echo "WARN: CA cert $CA_SRC missing — mTLS conf will fail nginx -t"
fi

mkdir -p "$BK_DIR"
DEFAULT_BK="$BK_DIR/default.$TS.bak"
DEST_BK="$BK_DIR/saf-dashboard.$TS.bak"
[ -f "$SITE" ] && cp "$SITE" "$DEFAULT_BK" && echo "backup: $DEFAULT_BK"
[ -f "$DEST" ] && cp "$DEST" "$DEST_BK"

# 1. Install the version-controlled dashboard server block as its own file.
cp "$SRC" "$DEST"
echo "installed: $DEST"

# 2. Remove any inline dashboard server block(s) from the monolithic default so
#    server_name isn't duplicated. Brace-counted; only blocks that mention the
#    dashboard host are dropped — every other server block is left untouched.
if [ -f "$SITE" ] && grep -q "dashboard.stillafloatcruising.com" "$SITE"; then
  TMP="$(mktemp)"
  awk '
    !inblock && $0 ~ /^[[:space:]]*server[[:space:]]*\{/ { inblock=1; buf=""; marker=0; depth=0 }
    inblock {
      buf = buf $0 "\n"
      if ($0 ~ /dashboard\.stillafloatcruising\.com/) marker=1
      t=$0; o=gsub(/\{/,"",t); c=gsub(/\}/,"",t); depth += o - c
      if (depth<=0) { if (!marker) printf "%s", buf; inblock=0 }
      next
    }
    { print }
  ' "$SITE" > "$TMP"
  cp "$TMP" "$SITE"; rm -f "$TMP"
  echo "removed inline dashboard block(s) from $SITE"
fi

revert() {
  echo "REVERTING nginx config"
  [ -f "$DEFAULT_BK" ] && cp "$DEFAULT_BK" "$SITE"
  if [ -f "$DEST_BK" ]; then cp "$DEST_BK" "$DEST"; else rm -f "$DEST"; fi
  nginx -t >/dev/null 2>&1 && systemctl reload nginx && echo "reverted to valid config" || echo "WARN: revert still invalid"
}

# 3. Validate; reload only if valid.
if ! nginx -t; then echo "nginx -t FAILED"; revert; exit 1; fi
systemctl reload nginx
echo "RELOADED OK"

# 4. Smoke test — the dashboard must serve. Revert if it doesn't.
sleep 1
CODE="$(curl -s -o /dev/null -w '%{http_code}' https://dashboard.stillafloatcruising.com/ || echo 000)"
echo "dashboard / : $CODE"
case "$CODE" in
  2*|3*) echo "DONE" ;;
  *) echo "dashboard smoke test failed ($CODE)"; revert; exit 1 ;;
esac
