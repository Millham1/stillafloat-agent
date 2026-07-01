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
4. **The only shared dependency is `.env`.** Secrets live in ONE file —
   `/opt/stillafloat/shared.env` (override path via `SHARED_ENV_PATH`) — that
   every service loads at boot (local `.env` for service-specific config wins,
   then the shared file fills secrets; an already-set var is never overwritten).
   All three services now read it, including the monorepo backend (`server/src/env.ts`).
   No service imports another's code.
5. **Git is the source of truth. The box only receives deploys.** Code flows
   git -> deploy. Nothing is edited directly on the server, ever. (This rule
   exists because direct-on-server edits caused the live code to drift onto a
   commit no branch tracked.)

## Components
- **Static frontend** — hand-authored HTML/CSS/JS in `server/public`, **inside the
  `stillafloat-agent` monorepo (NOT a separate repo).** nginx serves these files
  **directly** from `/root/saf-full/server/public`; only `/api/*` and a few agent
  paths are proxied. Consequence: backend Express middleware (compression, HSTS,
  response headers) does **not** reach static HTML/CSS/JS — static-asset concerns
  are handled at the nginx edge (see **Edge (nginx)** below).
  - ⚠️ **Intent vs. reality:** Mark's stated direction is to split the frontend
    into its **own repo/deploy**, separate from the backend. That is an open,
    wanted goal — currently **unmet**; the frontend has lived in the monorepo
    since the Vercel-era migration. Don't mistake the current co-location for the
    target. (The old standalone `stillafloatcruising.com` repo is abandoned.)
- **Website backend** (`:3002`) — Express; the interactive website API. Feature
  routes: affiliate, commentary, contact, favorites, feeds, subscribe,
  translate-article, weather, youtube, health. Each its own class/module.
  The `youtube` module scans **@StillAfloatcruising2026** on boot + every 6h and
  serves the homepage's "latest upload" section via `/api/youtube-featured`
  (gated by `DISABLE_YOUTUBE_SCAN`; independent of the editorial digest).
  Serves `/api` responses with `compression` (gzip/br) + an HSTS header
  (`server/src/app.ts`, added 2026-06-30). Binds `0.0.0.0:3002` (**IPv4 only** —
  see the 127.0.0.1 note under Edge). `/api/weather` fans out ~24 open-meteo
  fetches with retry + `allSettled` + last-good cache so one upstream hiccup can't
  blank the homepage.
- **News / editorial agent** (`:3003`) — standalone service (`stillafloat-newsagent`
  repo): scan -> AI commentary -> daily digest (email + Telegram) -> inline
  `/review` approve loop -> self-scheduler (08:00 ET).
- **Ops manager** (`:5000`) — standalone service (`saf-ops-manager` repo): Gmail
  triage, calendar conflict handling, reschedule/decline Gmail drafts, Telegram
  alerts.
- **Dashboard** — admin UI for reviewing editorial and managing commentary;
  talks to the backend and news-agent APIs.

## Edge (nginx) — repo-managed since 2026-06-30
nginx is the TLS terminator + router in front of everything. **It is now version
controlled** — do NOT hand-edit it on the box. `infra/deploy-nginx.sh` runs at the
end of every deploy and installs the config with backup → `nginx -t` → HTTP smoke
test → **auto-revert on failure**. Sources in `infra/nginx/`:
- `site.prod.conf` / `site.dev.conf` — the main vhost (installed as
  `sites-enabled/default`). Prod vs dev is chosen by presence of the main TLS cert.
- `saf-perf.conf` — installed to `conf.d/` (http context): `gzip_types` for
  CSS/JS/SVG/JSON + an HSTS `add_header`. (nginx.conf has `gzip on` but
  `gzip_types` was unset, so only `text/html` was compressed until this.)
- `dashboard.stillafloatcruising.com.conf` + `saf-dashboard.htpasswd` — the
  dashboard subdomain (separate cert, basic-auth gated).

**Routing (prod):** static from `/root/saf-full/server/public`; `/api/`→`:3002`;
`/dashboard/`→alias; `/upload`→`:3001`; `/images/`→`/var/www/html/images`;
`/review`,`/api/scan-news`,`/api/agent-action`,`/api/editorial-queue`→`:3003`
(`snippets/editorial-3003.conf`, owned by the newsagent repo);
`/ideas/`,`/state/`,`/finance/`→`:5000` (`snippets/ideas-state.conf`); `:8080`
upload helper.

**⚠️ Upstreams MUST use `127.0.0.1`, never `localhost`.** The apps bind
`0.0.0.0` (IPv4 only); `localhost` also resolves to IPv6 `::1`, so nginx hitting
`::1` got `connect() failed (111: Connection refused)` → intermittent **503** on
every feed (was chronic — 51+/day — until fixed 2026-06-30).

**TLS:** Let's Encrypt. **Certbot authenticator = `webroot`** (`/var/www/letsencrypt`,
served via `^~ /.well-known/acme-challenge/` before the HTTP→HTTPS redirect) since
2026-06-30 — so renewal never edits the repo-owned vhost. (Was `nginx`
authenticator; that had to change for the repo to own the config.) Verify with
`certbot renew --dry-run`.

**Static-root traversal:** the `www-data` worker must traverse `/root` to reach
`server/public`, so `/root` is mode `701` (`chmod o+x /root`) on both boxes.

**Dev mirrors prod:** `site.dev.conf` (HTTP-only, `/api`→`127.0.0.1:5000`) makes
the dev box actually front the site, so edge/proxy changes are testable e2e on dev
before prod.

**⚠️ Deploy = brief public blip:** every deploy runs `pm2 restart` (~10–30s where
nginx→app is connection-refused → 503s) plus an nginx reload. **Batch changes into
one deploy;** don't push repeatedly while someone is watching the live site.

## Repo / branch map
- `stillafloat-agent` — the live TypeScript monorepo (website backend + dashboard).
  - `main` = canonical production code.
  - `dev` = working branch (dev-first; merge to main after tests).
  - `legacy-js-main`, `legacy-js-develop` = archived dead Vercel-era JS (do not use).
- `stillafloat-newsagent` — the news/editorial agent (`main` / `dev`).
- `saf-ops-manager` — the ops manager (`main` / `dev`).

## Hosts
- Production VPS: `5.161.52.102` (ubuntu-8gb-ash-2). App on `:3002`. `/root` = `701`.
- Dev VPS: `178.156.154.144` (saf-dev) — upgraded 2GB→8GB June 2026; runs all
  services under pm2, made reboot-safe via `pm2 startup` (a resize had stopped
  the processes). App on `:5000`. `/root` set to `701` on 2026-06-30 so nginx can
  serve the site (dev now mirrors prod's edge via `site.dev.conf`).
- Read-only SSH is available for inspection on both (`ssh root@<ip>`).

## Changelog
- **2026-06-30** — SEO remediation (Semrush: privacy/terms pages [fixes a broken
  internal link], robots.txt, sitemap.xml, llms.txt, missing H1s across EN+ES).
  nginx brought under version control (`infra/nginx/*` via `deploy-nginx.sh`);
  fixed chronic IPv6 `::1` 503s by forcing `127.0.0.1` upstreams; added
  `conf.d/saf-perf.conf` (gzip + HSTS); Certbot switched to the `webroot`
  authenticator; `/api/weather` made resilient to open-meteo flakiness; dev nginx
  made a true prod mirror. See the memory notes `stillafloat-seo-remediation` and
  `stillafloat-frontend-separation`.

## Editorial ownership (resolved)
The standalone news agent (`:3003`, `stillafloat-newsagent`) is the sole live
editorial service. The monorepo backend still contains the editorial code, but
its daily scan is now **retired by default** (opt back in with
`ENABLE_MONOREPO_DAILY_SCAN=1`) — so the backend no longer sends a second 8 AM
digest. The backend is effectively website-only.
