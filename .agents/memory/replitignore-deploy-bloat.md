---
name: .replitignore patterns for this project
description: What to exclude from the container image to prevent 3GB+ Repl layer and health check timeout failures.
---

## The rule
`.replitignore` must use `**/attached_assets` (not `attached_assets`) to exclude all chat-attached screenshot directories — they exist at multiple nesting levels (e.g. `ep1-video/attached_assets`).

Also exclude `ep1-video/` entirely — it is a 2.5GB video production artifact with no runtime value.

## Why
Every container build packs the entire workspace into a "Repl layer". Before this fix the layer was ~3GB, causing Cloud Run's startup health check to time out because the image took 97+ seconds to push and pull. Adding the correct exclusions drops the layer to ~50MB.

## How to apply
Always use `**/pattern` for any directory that might appear nested. Verify with:
```
du -sh /home/runner/workspace/*/ | sort -rh | head -20
```
before every deploy cycle if builds start failing at "Creating Autoscale service".

## Current .replitignore (good state)
```
.local
**/node_modules
**/attached_assets
ep1-video
```
