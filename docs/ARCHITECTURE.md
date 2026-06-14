# Still Afloat — Technical Architecture (TAD)

This is the **target architecture**. The system is a set of independent
services that share exactly one thing: a single `.env`. No code crosses a
service boundary.

```
                         Visitor
                        /        \
            Static frontend     Dashboard
            (HTML · JS)         (review · commentary)
                        \        /
                          nginx
                  (TLS · routing · static)
                /           |           \
     Backend :3002   News agent :3003   Ops manager :5000
     (modular classes) (editorial loop) (email · calendar)
                \           |           /
        ───────── Shared .env (only cross-service dependency) ─────────
```

## Principles
1. **Frontend is static.** HTML/JS served by nginx from `server/public`.
2. **Backend serves the interactive features** of the frontend, and is one
   process — but **internally modular**: each feature is its own class
   (weather, subscribe, commentary, contact, affiliate, favorites, feeds,
   translate, youtube). Changes are drop-in; one feature never rewrites another.
3. **Autonomous agents are separate services** with their own ports and
   lifecycles — never routes buried in the backend. Today: the news/editorial
   agent and the ops manager.
4. **The only shared dependency is `.env`.** Keys live in one place; no service
   imports another's code.
5. **Git is the source of truth. The box only receives deploys.** Code flows
   git -> deploy. Nothing is edited directly on the server, ever. (This rule
   exists because direct-on-server edits caused the live code to drift onto a
   commit no branch tracked.)

## Components
- **Static frontend** — `server/public`, served by nginx.
- **Website backend** (`:3002`) — Express; the interactive website API. Feature
  routes: affiliate, commentary, contact, favorites, feeds, subscribe,
  translate-article, weather, youtube, health. Each its own class/module.
- **News / editorial agent** (`:3003`) — standalone service (`stillafloat-newsagent`
  repo): scan -> AI commentary -> daily digest (email + Telegram) -> inline
  `/review` approve loop -> self-scheduler (08:00 ET).
- **Ops manager** (`:5000`) — standalone service (`saf-ops-manager` repo): Gmail
  triage, calendar conflict handling, reschedule/decline Gmail drafts, Telegram
  alerts.
- **Dashboard** — admin UI for reviewing editorial and managing commentary;
  talks to the backend and news-agent APIs.

## Repo / branch map
- `stillafloat-agent` — the live TypeScript monorepo (website backend + dashboard).
  - `main` = canonical production code.
  - `dev` = working branch (dev-first; merge to main after tests).
  - `legacy-js-main`, `legacy-js-develop` = archived dead Vercel-era JS (do not use).
- `stillafloat-newsagent` — the news/editorial agent (`main` / `dev`).
- `saf-ops-manager` — the ops manager (`main` / `dev`).

## Hosts
- Production VPS: `5.161.52.102` (ubuntu-8gb-ash-2).
- Dev VPS: `178.156.154.144` (saf-dev).

## Open gap (in progress)
Editorial currently still lives **inside** the backend (and is duplicated). The
cutover moves editorial fully onto the news agent (`:3003`) and disables the
backend's 8 AM scheduler, leaving the backend website-only — closing the last
gap between this target and the running system.
