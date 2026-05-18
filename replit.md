# Still Afloat Editorial Agent

An AI-powered editorial intelligence platform for Still Afloat cruise and travel news — ingests live headlines, runs AI curation, and provides an editorial command center for approving stories to the website.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/still-afloat run dev` — run the frontend dashboard
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 (`artifacts/api-server`)
- Frontend: React + Vite (`artifacts/still-afloat`)
- Persistence: Supabase (`platform_state` table with JSON blobs)
- AI: OpenAI GPT-4o-mini for editorial curation
- Email: Resend for editorial digest delivery
- News ingestion: GNews API + 14 confirmed-live RSS feeds

## Where things live

- `artifacts/api-server/src/routes/editorial.ts` — editorial queue, agent-action, scan-news endpoints
- `artifacts/api-server/src/routes/feeds.ts` — homepage-feed, news-feed, story-details, alerts, system-status
- `artifacts/api-server/src/lib/persistence.ts` — Supabase read/write helpers
- `artifacts/api-server/src/lib/editorial-agent.ts` — OpenAI editorial curation
- `artifacts/api-server/src/lib/live-sources.ts` — GNews + RSS ingestion (14 live feeds)
- `artifacts/api-server/src/lib/story-normalizer.ts` — story deduplication and normalization
- `artifacts/still-afloat/src/pages/` — dashboard, queue, approved, feeds, alerts pages
- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth for all API contracts)

## Architecture decisions

- Supabase is used for persistence (not the built-in Postgres DB) — stores all editorial state as JSON blobs in a `platform_state` table with an `id` key and `payload` JSON column.
- The editorial pipeline is stateless from the Express server's perspective — all state is in Supabase via `PATHS` keys.
- The `/api/agent-action` endpoint uses GET (not POST) because it was originally designed as a Vercel email link action.
- The frontend dashboard talks to the same API server that the website consumes — it's a management UI on top of the publishing feeds.
- No Postgres/Drizzle is used — the DB lib exists in the scaffold but is not wired up for this project.

## Product

- **Dashboard**: System status, subsystem health, "Trigger Fast Scan" button
- **Editorial Queue**: AI-curated candidate stories with approve/reject/pin/defer actions
- **Approved Stories**: Published stories visible on the homepage feed
- **Live Feeds**: Raw JSON feeds the website consumes (homepage, news, story details, alerts, weather)
- **Operational Alerts**: High/critical impact stories surfaced as alerts

## Website (stillafloatcruising.com)

The consumer-facing website is **served directly from the API server** — all static HTML/CSS/JS/image files live in `artifacts/api-server/public/`. No separate Vercel deployment needed for the website.

The original GitHub repo (`Millham1/stillafloatcruising.com`) is the source of record for the static files, but the live version is now served by this Replit deployment.

### How it works:
- Express serves static files from `artifacts/api-server/public/` for all non-`/api/*` paths
- `AGENT_BASE_URL` is set to `''` (empty string) in all website JS — all API calls are same-origin relative URLs
- The weather API (`GET /api/weather`) is ported from the old Vercel serverless function into `src/routes/weather.ts`

### Key website endpoints (all same server):
| Endpoint | Used by | Returns |
|---|---|---|
| `GET /api/homepage-feed` | `js/news.js` | `{ stories }` — featured stories for Cruise Report section |
| `GET /api/news-feed` | `js/news.js` | `{ stories }` — full news list for `news.html` |
| `GET /api/story-details?id=` | `story.html` | Full story with CliffsNotes summary + source link |
| `GET /api/system-status` | `js/platform-status.js` | Pipeline health status |
| `GET /api/weather?place=` | `js/weather.js` | Cruise port/destination forecast from Open-Meteo |
| `GET /api/editorial-queue` | `editorial-queue.html` | Editorial queue viewer |

### To go fully live (cancel Vercel):
1. Click **Publish** in Replit → get a `*.replit.app` URL
2. In your domain registrar, point `stillafloatcruising.com` DNS to Replit
3. Add the custom domain in Replit deployment settings
4. Cancel Vercel

### Weather system context (from SAF_WEATHER_REQUIREMENTS.md):
- Weather is **operational travel intelligence**, not a widget or weather app
- Guiding question: "How does weather affect travelers, cruisers, ports, flights, and itineraries?"
- Visual direction: cinematic, glass/translucent, premium — NOT boxy or cartoonish
- Priority 1: cruise port intelligence (embarkation + destination ports)
- Priority 2: storm / hurricane intelligence (tropical systems, itinerary impacts)
- Priority 3: travel disruption intelligence (airport delays, flooding, heat, severe weather)
- Future: AI weather agent, itinerary impact scoring, embarkation alerts, AI traveler advisories
- Mobile: quick operational awareness, low clutter, swipe-friendly
- Full spec: `SAF_WEATHER_REQUIREMENTS.md` at project root

### Brand context (from SAF_CONTEXT.md):
- Owner: Mark Millham — retired IT Senior Manager, veteran, former liveaboard sailor, North Carolina
- Tone: Practical, experienced, tropical premium, funny without being cheesy
- Tagline: "Cruise smarter. Laugh more. Stay Afloat."
- Colors: Navy #07183f, Ocean Blue #0077b6, Seafoam #5dff9a, Sun Gold #ffca4f
- Fonts: Baloo 2 (body), Bree Serif (headings), Pacifico (accent)
- Visual direction: Jimmy Buffett × Kenny Chesney × tropical premium resort

## User preferences

- Push code changes to GitHub (`Millham1/stillafloat-agent`) — needs GitHub PAT for write access
- Website repo is public: `Millham1/stillafloatcruising.com` — readable without token

## Gotchas

- `SUPABASE_ANON_KEY` is required — the server will throw at startup if it's missing
- Agent approval actions are GET requests with `?action=X&id=Y&token=Z` query params
- `AGENT_APPROVAL_TOKEN` is optional — if unset, all actions are authorized
- The `pnpm dev` at workspace root has no dev script — run individual artifacts via `--filter`
- Fonts and theming: CSS custom properties in `artifacts/still-afloat/src/index.css`
- The old `api/cruise-news.js` Vercel function used NewsAPI — replaced by GNews+RSS in this repo
- Git commit/push is blocked in the main agent shell — use Replit checkpoints or a project task

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Supabase URL is hardcoded as a fallback in `persistence.ts` — override with `SUPABASE_URL` env var
