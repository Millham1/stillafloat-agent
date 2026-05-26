---
name: Production run command — absolute path required
description: Why the server artifact must use an absolute path in artifact.toml's production run command
---

## Rule
Always use an absolute path for the server run command in `server/.replit-artifact/artifact.toml`:

```toml
[services.production.run]
args = ["node", "--enable-source-maps", "/home/runner/workspace/server/dist/index.mjs"]
```

**Why:** In the Cloud Run autoscale runtime container, the working directory (CWD) when pid1 starts the process is NOT `/home/runner/workspace`. Relative paths like `server/dist/index.mjs` resolve against the wrong CWD and the process exits silently (no stdout/stderr in accessible deployment logs because failed builds never produce runtime logs). This causes the health check to time out ("Creating Autoscale service" hangs for ~2 min then fails).

**How to apply:** Any time the server production run command is changed in `artifact.toml`, keep it as `node --enable-source-maps /home/runner/workspace/server/dist/index.mjs`. Do NOT use `pnpm --filter @workspace/api-server run start` (same CWD issue, plus pnpm may not be in PATH in the hosting layer). Do NOT use a relative path.

**History:** 4 consecutive failing builds (May 26 2026) all used relative paths. The last successful build (May 24 2026) had NO committed artifact.toml — it ran in legacy mode with a different (working) run mechanism.
