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
- News ingestion: GNews API
- API codegen: Orval (from OpenAPI spec)

## Where things live

- `artifacts/api-server/src/routes/editorial.ts` — editorial queue, agent-action, scan-news endpoints
- `artifacts/api-server/src/routes/feeds.ts` — homepage-feed, news-feed, story-details, alerts, system-status
- `artifacts/api-server/src/lib/persistence.ts` — Supabase read/write helpers
- `artifacts/api-server/src/lib/editorial-agent.ts` — OpenAI editorial curation
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

## User preferences

_Populate as you build._

## Gotchas

- `SUPABASE_ANON_KEY` is required — the server will throw at startup if it's missing
- Agent approval actions are GET requests with `?action=X&id=Y&token=Z` query params
- `AGENT_APPROVAL_TOKEN` is optional — if unset, all actions are authorized
- The `pnpm dev` at workspace root has no dev script — run individual artifacts via `--filter`
- Fonts and theming: CSS custom properties in `artifacts/still-afloat/src/index.css`

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Supabase URL is hardcoded as a fallback in `persistence.ts` — override with `SUPABASE_URL` env var
