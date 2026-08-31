# The alert canary

A watchdog that runs on the **dev box** and watches **prod**, reporting over a
transport that has no shared failure mode with Web Push.

## Why it exists

On 2026-08-26 a single stray tap on "Turn off" (it sat at the same tap-target
size as "Send test", immediately beside it) removed the last subscribed device.
For **five days** every agent nudge — story approvals, storm alerts, the morning
brief — was delivered to zero devices and silently discarded.

The in-process health check *did* detect it, every six hours, twenty times. It
raised an alert exactly once, because its `source_ref` was a fixed string and the
first alert row stayed `pending`, so every later check deduped against it. The
rest went to a log file nobody reads. Mark found out by noticing the silence.

Two faults were structural, and neither can be fixed from inside prod:

1. **A process cannot report its own death.** If `saf-full-server` crashes or the
   box goes down, nothing on that box can tell anyone.
2. **A channel cannot report its own silence.** Alerting about dead Web Push over
   Web Push is a circular dependency.

Hence: **separate machine, separate transport.**

| | watches | runs on | alerts over |
|---|---|---|---|
| `push-health.ts` (in-process) | subscriber count | prod | Web Push → email |
| **this canary** | prod liveness + subscriber count | **dev box** | **ntfy → phone app** |

## What it checks, every 10 minutes

1. `GET /api/healthz` — is prod answering at all? Anything but 200 → **down**.
2. `GET /api/healthz/alerts` with `x-canary-token` → `{devices, vapid}`.
   Zero devices, missing VAPID, or an unreadable response → **degraded**.

`/api/healthz/alerts` is gated because "how many devices is the operator
reachable on right now" is precisely what an attacker would want to know. The
canary's only prod credential is `CANARY_TOKEN`, a single-purpose read-only
secret that buys one integer — it never holds the dashboard token or VAPID keys.

## What it does about it

- **Hysteresis:** `FAIL_STREAK = 2` consecutive bad polls before alerting, so a
  deploy restart or a brief network blip is not an alarm.
- **Re-alerts every 24h** while the fault persists. Alerting *once* is the exact
  bug this replaces; alerting every 10 minutes gets muted, which is the same bug
  wearing a different hat.
- **Sends one "recovered" note** when it clears, so silence always means healthy.
- State in `/var/lib/saf-canary/state.json`, so a restart does not re-alarm.

## Install (dev box)

```bash
scp infra/canary/alert-canary.py     saf-dev:/opt/stillafloat/alert-canary.py
scp infra/canary/saf-canary.service  saf-dev:/etc/systemd/system/
scp infra/canary/saf-canary.timer    saf-dev:/etc/systemd/system/
ssh saf-dev 'systemctl daemon-reload && systemctl enable --now saf-canary.timer'
```

Config lives in `/opt/stillafloat/shared.env` on the **dev** box:

| key | purpose |
|---|---|
| `CANARY_TOKEN` | must match prod's `CANARY_TOKEN` |
| `NTFY_TOPIC` | the private random topic the phone app subscribes to |
| `NTFY_URL` | defaults to `https://ntfy.sh` |
| `NTFY_TOKEN` | optional bearer, if the topic is access-controlled |
| `PROD_HEALTH_URL` | defaults to `https://stillafloatcruising.com/api/healthz` |

Check it: `systemctl list-timers saf-canary.timer` and
`journalctl -u saf-canary.service -n 20`.

## The topic is a secret

`NTFY_TOPIC` is a random 32-character string and it is the **only** thing
protecting the feed on the public ntfy.sh server: anyone holding the name can
read the alerts, and can publish fakes into it. Treat it like a password —
it is why no notification ever carries a credential (see the `view`-action note
in `notify.ts`; an earlier version embedded `AGENT_APPROVAL_TOKEN` in ntfy action
URLs, which would have put dashboard write access into every relayed message).

To harden further, both are config changes, not rewrites:
- point `NTFY_URL` at a self-hosted ntfy behind auth (needs DNS + a cert on the
  dev box, which it does not currently have), or
- reserve the topic on an ntfy.sh account and set `NTFY_TOKEN`.

## The hole this does NOT close

If **zero devices are subscribed**, nothing can push to the phone — that is
physics, not a bug. The canary's answer is to reach the phone over ntfy instead,
which is why the ntfy app is not optional. Without it, the last line of defence
is the daily email from `push-health`.
