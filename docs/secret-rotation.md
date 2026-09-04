# Rotating a secret that already exists in `shared.env`

**A plain `pm2 restart` does NOT change an already-set variable.** Learned the hard
way on 2026-09-04 rotating `AGENT_APPROVAL_TOKEN`: the file was rewritten on both
boxes, backups were made, all four services restarted cleanly, the script reported
success — and both boxes carried on accepting the old token.

## Why

`server/src/env.ts` is a deliberate **no-override** loader:

```ts
if (process.env[key] !== undefined) continue; // never override
```

pm2 preserves the environment a process was originally started with. So on restart
the old value is already in `process.env`, the loader skips the line, and the new
value in `shared.env` is ignored. This is correct behaviour for the loader's stated
precedence (process env > local `.env` > shared `.env`) — it just means:

- **A NEW variable** added to `shared.env` IS picked up by a plain restart.
- **A ROTATED variable** is NOT. It needs the process env replaced.

## How to actually apply a rotation

Replace the process env, reproducing the loader's precedence — shared first, then
the service's own `.env` last so local values win — and set the service's port
explicitly:

```sh
set -a
. /opt/stillafloat/shared.env
. /root/saf-full/server/.env        # local overrides shared, as the loader intends
set +a
export PORT=5000 BASE_PATH=/ OPS_MANAGER_URL=http://127.0.0.1:5001
unset NODE_ENV
cd /root/saf-full/server
pm2 restart saf-full-server --update-env
pm2 save
```

### The trap that follows from this

`--update-env` replaces the process env **from the calling shell**, which is why the
runbook bans it casually. Sourcing only `shared.env` is NOT enough:
`shared.env` contains `PORT=3003` (the newsagent's port). Restarting the monorepo
server with that env puts it on the wrong port and it stops serving — which is
exactly what happened on dev during this rotation, for about four minutes.

So: source shared, then source the service's own `.env`, then set the port
explicitly. Never `--update-env` from a bare shell.

## Verify, do not assume

A rotation is only done when the NEW value is accepted **and the OLD one is
refused**. The restart succeeding proves nothing — that is the whole lesson here.

```sh
curl -s -o /dev/null -w '%{http_code}\n' $URL -H "x-affiliate-token: $NEW"   # 200
curl -s -o /dev/null -w '%{http_code}\n' $URL -H "x-affiliate-token: $OLD"   # 401
```

Since 2026-09-04 auth **fails closed** (`lib/http-auth.ts`), so a box left without
the variable returns 401 rather than serving openly. That is the safe direction, but
it means a half-finished rotation locks you out instead of opening the doors — all
the more reason to verify both ends.
