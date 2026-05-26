---
name: Cloud Run node_modules required
description: Excluding **/node_modules from .replitignore broke Cloud Run deploys for this project; working builds had node_modules present in the container.
---

## The rule
Do NOT add `**/node_modules` to `.replitignore` for this project. The Cloud Run container requires node_modules to be present even though the server bundle is built with esbuild.

**Why:** The last successful deploy (79a031d7, May 24 2026) had `.replitignore` containing only `.local`/`**/.local`. The folder restructure on May 25 (artifacts/api-server/ → server/) simultaneously added `**/node_modules` to `.replitignore`. Every build since has failed identically at "Creating Autoscale service" with a ~72s timeout and no runtime logs — consistent with the process crashing before any output.

**How to apply:** Keep `.replitignore` to only:
```
.local
**/.local
```
The `ep1-video` and `**/attached_assets` exclusions are safe (large media, not runtime deps). But `**/node_modules` and `**/*.map` must NOT be excluded.
