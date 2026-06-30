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

# ── Performance + security headers (runs on ANY host with nginx) ──────────────
# Installs conf.d/saf-perf.conf (gzip_types for CSS/JS/SVG/JSON + HSTS). Done
# BEFORE the dashboard-cert early-exit so it applies on dev and prod alike.
# Self-verifying: nginx -t gates the reload; auto-reverts on failure. Independent
# of the dashboard block below so a perf-conf issue can never wedge the site.
PERF_SRC="$(cd "$(dirname "$0")" && pwd)/nginx/saf-perf.conf"
PERF_DEST="/etc/nginx/conf.d/saf-perf.conf"
if [ -f "$PERF_SRC" ]; then
  mkdir -p "$BK_DIR"
  PERF_BK="$BK_DIR/saf-perf.$TS.bak"
  [ -f "$PERF_DEST" ] && cp "$PERF_DEST" "$PERF_BK"
  cp "$PERF_SRC" "$PERF_DEST"
  echo "installed: $PERF_DEST"
  if nginx -t; then
    systemctl reload nginx && echo "perf conf RELOADED OK"
  else
    echo "nginx -t FAILED after perf conf — reverting"
    if [ -f "$PERF_BK" ]; then cp "$PERF_BK" "$PERF_DEST"; else rm -f "$PERF_DEST"; fi
    nginx -t >/dev/null 2>&1 && systemctl reload nginx && echo "perf conf reverted" || echo "WARN: revert invalid"
  fi
else
  echo "WARN: $PERF_SRC missing — skipping perf conf"
fi

# ── Main site vhost (runs on ANY host with nginx) ─────────────────────────────
# Repo-owned replacement for the box's sites-enabled/default. Prod vs dev is
# chosen by the presence of the main TLS cert. Both variants proxy /api to
# 127.0.0.1 (NOT localhost) so nginx never tries the IPv6 ::1 address the app
# doesn't listen on (the cause of intermittent "connect() failed (111)" 503s).
# Self-verifying: nginx -t + an HTTP smoke test gate the change; auto-reverts
# from a backup on any failure.
MAIN_CERT="/etc/letsencrypt/live/stillafloatcruising.com/fullchain.pem"
DEFAULT="/etc/nginx/sites-enabled/default"
NGINX_DIR="$(cd "$(dirname "$0")" && pwd)/nginx"
if [ -f "$MAIN_CERT" ]; then
  SITE_SRC="$NGINX_DIR/site.prod.conf"
  mkdir -p /var/www/letsencrypt/.well-known/acme-challenge   # webroot for ACME renewal
else
  SITE_SRC="$NGINX_DIR/site.dev.conf"
fi
if [ -f "$SITE_SRC" ]; then
  mkdir -p "$BK_DIR"
  SITE_BK="$BK_DIR/default.site.$TS.bak"
  if [ -e "$DEFAULT" ] || [ -L "$DEFAULT" ]; then cp -L "$DEFAULT" "$SITE_BK" 2>/dev/null || true; fi
  rm -f "$DEFAULT"                 # drop any symlink (dev) or stale file
  cp "$SITE_SRC" "$DEFAULT"
  echo "installed main vhost: $DEFAULT (from $(basename "$SITE_SRC"))"
  revert_site() {
    echo "REVERTING main vhost"
    if [ -f "$SITE_BK" ]; then rm -f "$DEFAULT"; cp "$SITE_BK" "$DEFAULT"; fi
    nginx -t >/dev/null 2>&1 && systemctl reload nginx && echo "main vhost reverted" || echo "WARN: main vhost revert invalid"
  }
  if nginx -t; then
    systemctl reload nginx && echo "main vhost RELOADED OK"
    sleep 1
    HOME_CODE="$(curl -s -o /dev/null -w '%{http_code}' http://localhost/ || echo 000)"
    API_CODE="$(curl -s -o /dev/null -w '%{http_code}' http://localhost/api/public-config || echo 000)"
    echo "main vhost smoke: / => $HOME_CODE ; /api/public-config => $API_CODE"
    case "$HOME_CODE" in 2*|3*) : ;; *) echo "main vhost smoke FAILED"; revert_site ;; esac
  else
    echo "nginx -t FAILED after main vhost — reverting"; revert_site
  fi
else
  echo "WARN: $SITE_SRC missing — skipping main vhost"
fi

if [ ! -f "$CERT" ]; then
  echo "No dashboard TLS cert ($CERT) — not the prod dashboard host; skipping."; exit 0
fi
[ -f "$SRC" ] || { echo "ERR: source conf $SRC missing"; exit 1; }

# Install the Basic Auth password file (bcrypt/apr1 hash only — no plaintext).
# The dashboard conf references this path, so install it first or `nginx -t` fails.
HT_SRC="$(cd "$(dirname "$0")" && pwd)/nginx/saf-dashboard.htpasswd"
HT_DEST="/etc/nginx/saf-dashboard.htpasswd"
if [ -f "$HT_SRC" ]; then
  cp "$HT_SRC" "$HT_DEST"
  # World-readable so the nginx worker (www-data) can read it; the value is a
  # salted apr1 hash, not plaintext. 640 root:root caused nginx 500s (worker
  # couldn't read the file → auth_basic failed).
  chmod 644 "$HT_DEST"
  echo "installed htpasswd: $HT_DEST"
else
  echo "WARN: htpasswd $HT_SRC missing — auth_basic conf will fail nginx -t"
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

# 4. Smoke test — nginx must serve the dashboard host. With Basic Auth enabled,
#    an unauthenticated request returns 401, which proves the gate is active and
#    nginx is up — so 401 counts as success alongside 2xx/3xx.
sleep 1
CODE="$(curl -s -o /dev/null -w '%{http_code}' https://dashboard.stillafloatcruising.com/ || echo 000)"
echo "dashboard / : $CODE"
case "$CODE" in
  2*|3*|401) echo "DONE" ;;
  *) echo "dashboard smoke test failed ($CODE)"; revert; exit 1 ;;
esac
