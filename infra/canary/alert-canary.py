#!/usr/bin/env python3
"""alert-canary.py — the watchdog that lives on the OTHER box.

Why this exists (2026-08-26 → 2026-08-31 outage):
  A single stray tap unsubscribed the last device from Web Push. Every agent
  nudge for five days went to zero devices and vanished. The in-process health
  check DID notice, every six hours, and wrote "ZERO subscribed devices" to a log
  file — then raised nothing, because its first alert was still pending. Mark
  found out by noticing the silence himself.

  Two structural faults, neither fixable from inside prod:
    1. A process cannot report its own death. If saf-full-server or the whole box
       goes down, nothing on that box can tell anyone.
    2. A notification channel cannot report its own silence. Alerting about dead
       Web Push over Web Push is a circular dependency.

  So the canary runs on the DEV box (a physically separate machine) and reports
  over ntfy (a transport with no shared failure mode with Web Push, delivered to
  a native phone app). Independent machine, independent transport.

Design notes:
  - It NEVER holds prod's dashboard token or VAPID keys. Its only prod credential
    is CANARY_TOKEN, a single-purpose read-only secret that buys one integer.
  - Hysteresis: FAIL_STREAK consecutive bad polls before crying wolf, so a deploy
    restart or a 20-second network blip is not an alarm.
  - Re-alerts once per REPEAT_HOURS while a fault persists, and sends one
    "recovered" note when it clears. A canary that only chirps once is exactly
    the bug this replaces; a canary that chirps every 10 minutes gets muted, which
    is the same bug wearing a different hat.
  - State lives in a small JSON file, so a canary restart does not re-alarm.

Config (env, from /opt/stillafloat/shared.env):
  PROD_HEALTH_URL   default https://stillafloatcruising.com/api/healthz
  CANARY_TOKEN      shared secret for the gated alerts endpoint (required)
  NTFY_URL          default https://ntfy.sh
  NTFY_TOPIC        the private random topic (required)
  NTFY_TOKEN        optional bearer, if the topic is access-controlled
"""

import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

STATE_PATH = os.environ.get("CANARY_STATE", "/var/lib/saf-canary/state.json")
TIMEOUT = 20
FAIL_STREAK = 2          # consecutive bad polls before alerting
REPEAT_HOURS = 24        # re-alert cadence while a fault persists

PROD_HEALTH_URL = os.environ.get("PROD_HEALTH_URL", "https://stillafloatcruising.com/api/healthz")
CANARY_TOKEN = os.environ.get("CANARY_TOKEN", "")
NTFY_URL = os.environ.get("NTFY_URL", "https://ntfy.sh").rstrip("/")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")
NTFY_TOKEN = os.environ.get("NTFY_TOKEN", "")

DASHBOARD = os.environ.get("DASHBOARD_URL", "https://dashboard.stillafloatcruising.com")


def load_env_file(path="/opt/stillafloat/shared.env"):
    """Read shared.env without echoing it. Existing env wins."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                if k and k not in os.environ:
                    os.environ[k] = v.strip().strip('"').strip("'")
    except OSError:
        pass


def now():
    return datetime.now(timezone.utc)


def read_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def write_state(state):
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        with open(STATE_PATH, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
    except OSError as exc:
        print(f"canary: could not persist state: {exc}", file=sys.stderr)


def notify(title, body, priority="high", tags="rotating_light"):
    """Publish to ntfy. Never raises — a canary that dies on its own alert is useless."""
    if not NTFY_TOPIC:
        print("canary: NTFY_TOPIC unset — cannot alert", file=sys.stderr)
        return False
    req = urllib.request.Request(
        f"{NTFY_URL}/{NTFY_TOPIC}",
        data=body.encode("utf-8"),
        method="POST",
        headers={
            "Title": title[:120],
            "Priority": priority,
            "Tags": tags,
            "Click": DASHBOARD,
        },
    )
    if NTFY_TOKEN:
        req.add_header("Authorization", f"Bearer {NTFY_TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return 200 <= resp.status < 300
    except Exception as exc:  # noqa: BLE001 - deliberately total
        print(f"canary: ntfy publish failed: {exc}", file=sys.stderr)
        return False


def probe(channel_check_seen=False):
    """Return (state, detail, channel_ok). state in {ok, degraded, down}.

    `channel_check_seen` records whether /healthz/alerts has EVER answered
    properly. Unknown API paths fall through to the SPA, which returns 200 and
    HTML — indistinguishable by status code from a broken endpoint. So:
      - never seen it work  -> the prod promote carrying it simply has not landed;
                               report liveness only, do not cry wolf.
      - seen it work before -> HTML now means it REGRESSED. That is a fault, and
                               silently dropping the check would recreate exactly
                               the blind spot this canary exists to remove.
    """
    base = PROD_HEALTH_URL.rstrip("/")
    ctx = ssl.create_default_context()

    # 1. Is prod answering at all?
    try:
        with urllib.request.urlopen(base, timeout=TIMEOUT, context=ctx) as resp:
            if resp.status != 200:
                return "down", f"health endpoint returned HTTP {resp.status}", channel_check_seen
    except Exception as exc:  # noqa: BLE001
        return "down", f"prod unreachable: {exc}", channel_check_seen

    # 2. Can it still reach Mark? (gated — a bare device count is exactly what an
    #    attacker would like to know, so it is not public)
    if not CANARY_TOKEN:
        return "ok", "reachable (alert-channel check skipped: no CANARY_TOKEN)", channel_check_seen

    def pending_or_fault(reason):
        if channel_check_seen:
            return "degraded", f"alert-channel check REGRESSED — {reason}", True
        return "ok", f"reachable; alert-channel check not deployed yet ({reason})", False

    req = urllib.request.Request(f"{base}/alerts", headers={"x-canary-token": CANARY_TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as resp:
            raw = resp.read().decode("utf-8")
        data = json.loads(raw)
        if not isinstance(data, dict) or "devices" not in data:
            return pending_or_fault("response is not the expected JSON")
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            # A 401 proves the endpoint EXISTS and rejected us — always a fault.
            return "degraded", "canary token rejected by prod — the canary itself is misconfigured", True
        return pending_or_fault(f"HTTP {exc.code}")
    except ValueError:
        return pending_or_fault("served HTML, not JSON")
    except Exception as exc:  # noqa: BLE001
        return "degraded", f"alert-health unreadable: {exc}", channel_check_seen

    devices = data.get("devices")
    if not data.get("vapid"):
        return "degraded", "VAPID keys are not configured — push cannot be sent at all", True
    if not isinstance(devices, int):
        return "degraded", "alert-health returned no device count", True
    if devices < 1:
        return "degraded", "ZERO devices subscribed — every alert is going nowhere", True
    return "ok", f"{devices} device(s) subscribed", True


def main():
    load_env_file()
    # Re-read after loading the env file.
    globals().update(
        PROD_HEALTH_URL=os.environ.get("PROD_HEALTH_URL", PROD_HEALTH_URL),
        CANARY_TOKEN=os.environ.get("CANARY_TOKEN", CANARY_TOKEN),
        NTFY_URL=os.environ.get("NTFY_URL", NTFY_URL).rstrip("/"),
        NTFY_TOPIC=os.environ.get("NTFY_TOPIC", NTFY_TOPIC),
        NTFY_TOKEN=os.environ.get("NTFY_TOKEN", NTFY_TOKEN),
    )

    state = read_state()
    streak = int(state.get("fail_streak", 0))
    was_faulted = bool(state.get("faulted", False))
    last_alert = state.get("last_alert_at")

    channel_seen = bool(state.get("channel_check_seen", False))
    status, detail, channel_seen = probe(channel_seen)
    stamp = now().isoformat()
    print(f"canary {stamp} status={status} detail={detail}")

    if status == "ok":
        if was_faulted:
            notify(
                "✅ Alerts are working again",
                f"Prod is healthy and {detail}.\n\nRecovered at {stamp}.",
                priority="default",
                tags="white_check_mark",
            )
        write_state({
            "fail_streak": 0,
            "faulted": False,
            "last_status": status,
            "channel_check_seen": channel_seen,
            "checked_at": stamp,
        })
        return 0

    streak += 1
    should_alert = False
    if streak >= FAIL_STREAK:
        if not was_faulted:
            should_alert = True          # first confirmed fault
        elif last_alert:
            try:
                due = datetime.fromisoformat(last_alert) + timedelta(hours=REPEAT_HOURS)
                should_alert = now() >= due
            except ValueError:
                should_alert = True
        else:
            should_alert = True

    if should_alert:
        if status == "down":
            title = "🚨 Still Afloat prod is DOWN"
            body = (f"{detail}\n\nThe site and every agent are unreachable, so nothing on that box "
                    f"can tell you — this came from the dev box.\n\nChecked {stamp}.")
        else:
            title = "🔕 Your phone alerts are dead"
            body = (f"{detail}\n\nOpen the dashboard → Alerts and turn notifications back on, "
                    f"then send a test.\n\nChecked {stamp}.")
        sent = notify(title, body)
        last_alert = stamp if sent else last_alert

    write_state({
        "fail_streak": streak,
        "faulted": streak >= FAIL_STREAK,
        "last_status": status,
        "last_detail": detail,
        "last_alert_at": last_alert,
        "channel_check_seen": channel_seen,
        "checked_at": stamp,
    })
    return 1


if __name__ == "__main__":
    sys.exit(main())
