#!/bin/bash
# e2e/sweep-on-box.sh <dev|prod> — run the whole-site sweep ON the box, from the box's own
# checkout (what the deploy just put there). Used by:
#   • .github/workflows/deploy.yml  — after every deploy-dev / deploy-production (a red job
#     means the site that just went live fails its own checks; GitHub emails the failure)
#   • .github/workflows/sweep-prod.yml — scheduled every 6 h against prod
# The Mac tool saf-ops-tools/site-e2e.sh runs the same checks the same way but ships them
# from the Mac and files the result where the release gate reads it. This script files its
# result under /root/saf-e2e on the box.
#
# Rules it enforces (not configurable, by design):
#   • waits up to 10 min for /api/healthz, then runs; an unreachable site is a FAIL, not a skip
#   • COOLDOWN: a full sweep sends refusal probes to endpoints limited to ~5/visitor/hour. If a
#     full sweep for this mode started under an hour ago (marker written by this script AND by
#     site-e2e.sh), wait out the remainder instead of making the site 429 the gate's own probes.
#   • exit code = the runner's: 0 only on PASS (fail=0, untestable=0, complete). Untestable is
#     not a pass (Mark 2026-10-04: empty ≠ pass).
set -u
MODE="${1:-}"
case "$MODE" in
  dev)  SITE=http://127.0.0.1;                NEWS=http://127.0.0.1:3003; OPS=http://127.0.0.1:5001;;
  prod) SITE=https://stillafloatcruising.com; NEWS=http://127.0.0.1:3003; OPS=http://127.0.0.1:5000;;
  *) echo "usage: sweep-on-box.sh <dev|prod>"; exit 2;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT=/root/saf-e2e; mkdir -p "$OUT"; chmod 700 "$OUT"
MARK="$OUT/last-full-$MODE.at"

# cooldown
if [ -f "$MARK" ]; then
  last="$(cat "$MARK" 2>/dev/null || echo 0)"; now="$(date +%s)"; left=$(( 3600 - (now - last) ))
  if [ "$left" -gt 0 ] && [ "$left" -le 3600 ]; then
    echo "cooldown: a full $MODE sweep started $(( (now - last) / 60 )) min ago; waiting $(( left / 60 + 1 )) min so the site's hourly per-visitor limits do not 429 the gate's own probes"
    sleep "$left"
  fi
fi

# wait for the site
for i in $(seq 1 60); do
  code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$SITE/api/healthz" || echo 000)"
  [ "$code" = 200 ] && break
  [ "$i" = 60 ] && { echo "SWEEP $MODE FAIL /api/healthz answered $code for 10 minutes after the deploy"; exit 1; }
  sleep 10
done

# let the box SETTLE: right after a restart the tracker has not re-subscribed yet, so storm-path
# ships read as "not followed" (first CI run, 2026-10-09 13:21Z: 2 false fails one minute after
# boot; both passed two minutes later). Wait until the server has been up 3 min and the tracker
# reports live ships (or 5 more minutes have passed — then the sweep says so itself).
UP="$(pm2 jlist 2>/dev/null | python3 -c 'import sys,json,time; d=json.load(sys.stdin); print(int(time.time()-next((p["pm2_env"]["pm_uptime"] for p in d if p["name"]=="saf-full-server"),0)/1000))' 2>/dev/null || echo 999)"
[ "$UP" -lt 180 ] && { echo "settling: saf-full-server has been up ${UP}s; waiting $((180-UP))s for the tracker to re-subscribe"; sleep $((180-UP)); }
for i in $(seq 1 30); do
  live="$(curl -s -m 10 "$SITE/api/wms/ships" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(sum(1 for s in d.get("ships",[]) if s.get("live")))' 2>/dev/null || echo 0)"
  [ "${live:-0}" -gt 0 ] && break
  sleep 10
done
TOK="$(grep -E '^AGENT_APPROVAL_TOKEN=' /opt/stillafloat/shared.env 2>/dev/null | head -1 | cut -d= -f2-)"
TOK="${TOK%\"}"; TOK="${TOK#\"}"; TOK="${TOK%\'}"; TOK="${TOK#\'}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; FILE="$OUT/$MODE-$STAMP.json"
date +%s > "$MARK"
cd "$HERE/.." && AGENT_APPROVAL_TOKEN="$TOK" node e2e/run.mjs --mode "$MODE" --site "$SITE" --news "$NEWS" --ops "$OPS" --json "$FILE"
rc=$?
ls -t "$OUT"/$MODE-*.json 2>/dev/null | tail -n +31 | xargs -r rm -f   # keep the last 30
# Record WHAT was swept, so this file can be the release-gate record (site-e2e.sh --adopt):
# the three repos' heads and trees as they were on this box, the pm2 states, the suite commit.
HEADS="$(for d in /root/saf-full /root/stillafloat-newsagent /opt/saf-ops-manager; do printf "%s:%s " "$(git -C $d rev-parse HEAD 2>/dev/null || echo none)" "$(git -C $d rev-parse "HEAD^{tree}" 2>/dev/null || echo none)"; done)"
PROCS="$(pm2 jlist 2>/dev/null | python3 -c 'import sys,json; print(",".join(p["name"]+"="+p["pm2_env"]["status"] for p in json.load(sys.stdin)))' 2>/dev/null)"
python3 - "$FILE" "$MODE" "$HEADS" "$PROCS" <<'PY'
import json, sys
f, mode, heads, procs = sys.argv[1:5]
r = json.load(open(f)); s = r["summary"]
ha, hn, ho = (heads.split() + ["none:none"] * 3)[:3]
def pair(x): sha, _, tree = x.partition(":"); return {"box_head": sha, "box_tree": tree}
r["gate"] = {"box": mode, "suite": ha.split(":")[0][:7], "committed_suite": True, "ran_on_box": True,
             "heads": {"agent": pair(ha), "news": pair(hn), "ops": pair(ho)}, "processes": procs,
             "complete": not s.get("partial", False)}
json.dump(r, open(f, "w"), indent=1)
print(f"SWEEP {mode} {s['result']} pass={s['pass']} fail={s['fail']} untestable={s['untestable']} known={s['waived']} suite={r['gate']['suite']} file={f}")
PY
cp "$FILE" "$OUT/latest-$MODE.json" 2>/dev/null
exit $rc
