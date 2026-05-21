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

## Content policy

- **No alcohol promotion** — the site does not promote or feature alcoholic beverages. Do not generate or use images containing cocktails, beer, wine, or liquor. The current `cruise-fun-card.png` has a tropical cocktail that must be replaced — regenerate with a non-alcoholic alternative (e.g. tropical juice, mocktail, smoothie, or a pool float scene).

## Gotchas

- `SUPABASE_ANON_KEY` is required — the server will throw at startup if it's missing
- Agent approval actions are GET requests with `?action=X&id=Y&token=Z` query params
- `AGENT_APPROVAL_TOKEN` is optional — if unset, all actions are authorized
- The `pnpm dev` at workspace root has no dev script — run individual artifacts via `--filter`
- Fonts and theming: CSS custom properties in `artifacts/still-afloat/src/index.css`
- The old `api/cruise-news.js` Vercel function used NewsAPI — replaced by GNews+RSS in this repo
- Git commit/push is blocked in the main agent shell — use Replit checkpoints or a project task

## Saved assets

- `artifacts/api-server/public/assets/images/seagull-v3-wings-fries-lightbulb.png` — saved seagull render: wings spread wide, fries flying, Einstein feathers, glasses, lightbulb, cruise ship railing background. Use this as the reference for future seagull regenerations. When regenerating `great-ideas-card.png`, always save the outgoing version with a new versioned name first (e.g. `seagull-v4-...png`) before overwriting.

## Episode 1 video editing

**Rule: never rebuild a segment that hasn't changed. Load from `attached_assets/video_segments/` at session start.**

### Session setup (always run first):
```bash
mkdir -p /tmp/ep1-v3
cp attached_assets/video_segments/*.mp4 /tmp/ep1-v3/
```

### Saved segments (`attached_assets/video_segments/`):
| File | Duration | Description | Status |
|---|---|---|---|
| `beach_reveal_v3.mp4` | 17.7s | v4 intro: beach reveal → crab enters from afar, grows face-camera → scurries off right → logo + Mark | **CURRENT** |
| `black_pause5.mp4` | 5.0s | Pure black pause between intro and storm | **CURRENT** |
| `part_storm_questions.mp4` | 25.0s | Storm questions Q1–Q4 scene-synced to MOV footage (Q4 = "What if I choose wrong?") | source |
| `part_storm_questions_q4ext.mp4` | 28.0s | part_storm_questions + 3s freeze on Q4 (extends Q4 from ~3s to ~6s) | **CURRENT** |
| `storm_outro_xfade_v3.mp4` | 33.0s | part_storm_questions_q4ext + beach_outro xfade (offset=26, d=1.5) + 0.5s fade-in | **CURRENT** |
| `beach_outro.mp4` | 7.0s | Beach sunrise "Your First Steps!" outro | **CURRENT** |

### Current final output:
- `attached_assets/output/episode1_v8.mp4` — 54.2s, full audio mix
- **RULE**: Source video is ALWAYS `episode1_v4.mp4` — never use beach_reveal_v3/v4 for the intro (wrong crab)
- Built as 3 slices from episode1_v4.mp4, reassembled with minimal changes

### v8 structure (source of truth):
| Piece | v4 source range | Changes |
|---|---|---|
| `v8_intro.mp4` | t=0 → 22.7s | None — exact slice |
| `v8_storm_main.mp4` | t=22.7 → 43.5s | 0.5s fade-in from black (softer transition) |
| `v8_q4_end.mp4` | t=43.5 → end | tpad=start_mode=clone:start_duration=3 (Q4 extended 3s) |

### v8 audio mix:
- **Still Afloat Intro** (Still_Afloat_Intro_1779309407911.mp3): t=0, afade-out st=16.5:d=1.5, vol=1.0
- **Ominous** (Black_Gale_Passage.mp3): adelay=17700ms, afade-in d=0.8 (fast attack), afade-out st=10:d=5.0, vol=0.75
- **Storm** (MOV audio atrim=start=8): adelay=22700ms, afade-out st=24:d=2.5, vol=0.45
- **Salt** (Salt_On_My_Boots.mp3): adelay=48500ms, afade-in d=1.5, afade-out st=4:d=1.7, vol=0.85
- Total video: 54.2s

### What to rebuild vs. load (v8):
- Changing crab/intro → slice episode1_v4.mp4 t=0–22.7 only (or rebuild v4 first)
- Changing storm fade-in only → re-slice v8_storm_main from v4 with new fade
- Extending Q4 more/less → re-slice v8_q4_end from v4 with new tpad duration
- Changing audio only → skip all segment rebuilds, just re-run the combined ffmpeg command with updated audio params

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Supabase URL is hardcoded as a fallback in `persistence.ts` — override with `SUPABASE_URL` env var
