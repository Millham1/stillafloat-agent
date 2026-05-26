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

**Why:** In the Cloud Run autoscale runtime container, the working directory (CWD) when pid1 starts the process is NOT `/home/runner/workspace`. Relative paths resolve against the wrong CWD and the process exits silently, causing the health check probe to time out with no runtime logs.

**How to apply:** Any time the server production run command is changed in `artifact.toml`, use the absolute path. Do NOT use `pnpm --filter @workspace/api-server run start` (same CWD issue) or any relative path.
