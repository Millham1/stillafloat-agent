---
name: Production deployment — container size and run command
description: Two fixes required for successful Cloud Run deployment of the API server
---

## Fix 1: Exclude node_modules from the Repl layer
`.replitignore` must contain `**/node_modules`. Without it, 467 MB of node_modules from 9 workspace packages is included in every container image. Cloud Run cannot pull and start a ~500 MB container within the startup probe window, causing the health check to time out ("Creating Autoscale service" hangs ~2 min then fails).

The production server bundle (`server/dist/index.mjs`) is fully self-contained via esbuild. The dashboard is pre-built static files. Only ~43 MB of runtime files are actually needed.

**Why:** pnpm workspaces accumulate large node_modules across many packages. esbuild bundles everything, so node_modules is a build artifact, not a runtime dependency.

**How to apply:** Keep `**/node_modules` in `.replitignore` whenever the project uses esbuild/vite to produce self-contained production artifacts.

---

## Fix 2: Absolute path in run command
`server/.replit-artifact/artifact.toml` must use an absolute path:

```toml
[services.production.run]
args = ["node", "--enable-source-maps", "/home/runner/workspace/server/dist/index.mjs"]
```

**Why:** The Cloud Run container's CWD when pid1 starts the process is NOT `/home/runner/workspace`. Relative paths fail silently. Confirmed: the server starts fine from any CWD with the absolute path.

**How to apply:** Do NOT use `pnpm --filter ...` or any relative path in the production run command.
