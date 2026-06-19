# Website Defect Tracker

Issues reported by Mark as they're discovered. Add new items at the top of each section.

---

## Open

| # | Page | Description | Priority | Reported |
|---|------|-------------|----------|----------|
| 3 | Dashboard / API | **PII exposure.** `TokenGate` is client-only and accepts ANY value (no server validation) → dashboard isn't really gated. Worse, admin/PII API endpoints have no auth — `GET /api/subscribers` returns subscriber names+emails unauthenticated (verified via curl). Fix: (a) require a validated token/session on admin+PII endpoints server-side (subscribers, affiliate writes, favorites writes, commentary writes, send-newsletter, agent-action), (b) gate the dashboard host (real token check and/or nginx auth/IP-allowlist), (c) consider moving the dashboard off a guessable public subdomain. Mark: fix AFTER current functional bugs. | High (security) | 2026-06-19 |
| 1 | News agent | Confirm which code is actually deployed & serving the live editorial emails (host, process, git branch, scheduler) before cutting over to the new `stillafloat-newsagent` repo. Live email matches monorepo `server/`; deploy source unconfirmed. | High | 2026-06-11 |

---

## In Progress

| # | Page | Description | Notes |
|---|------|-------------|-------|

---

## Fixed

| # | Page | Description | Fixed In |
|---|------|-------------|----------|
| 4 | Dashboard | **Writes returned 401 Unauthorized.** Affiliate, Favorites, Newsletter, and Dashboard (YouTube-feature) pages issued POST/PATCH/DELETE without the `x-affiliate-token` header, while the backend's `checkToken()` requires it (`AGENT_APPROVAL_TOKEN`). Affiliate & Favorites broke immediately (those routes enforce the token); Newsletter & Dashboard were latent (their routes don't enforce it yet, but would break the moment the security lockdown adds it). Fix: attach `...authHeaders()` to every write, matching `commentary.tsx` (the only page that was already correct). Confirmed via non-mutating probe: with token → 404 (auth passes), without → 401. Full audit: all 11 routes/reads, CORS (wide-open), and stored-token match verified clean. | dev→main (pending), 2026-06-19 |
| 2 | Dashboard | Subscribers/Affiliate/Favorites/Newsletter pages failed to load (404/parse errors) — they called relative `/api/...` (hitting the dashboard's own static host → index.html) instead of the configured PROD API origin. Fixed by prefixing relative `/api` with `VITE_API_BASE_URL` in `dashboard/src/main.tsx` (fetch shim). Verified live: all routes (/, /queue, /approved, /feeds, /alerts, /affiliate, /favorites, /commentary, /subscribers, /newsletter) load real data, no errors. Note: existing browsers with the pre-deploy service worker self-heal on next reload (SW is network-first + skipWaiting). | `7102e3a` (dev→main), prod deploy 27849434247, 2026-06-19 |

---

## Notes
- Website static files live in `artifacts/api-server/public/`
- Preview the site via the "View Website" link in the editorial dashboard header
- In dev, the website is accessible at `/website/` from the Still Afloat Editorial Agent preview
