# Website Defect Tracker

Issues reported by Mark as they're discovered. Add new items at the top of each section.

---

## Open

| # | Page | Description | Priority | Reported |
|---|------|-------------|----------|----------|
| 3 | Dashboard / API | **PII exposure.** `TokenGate` is client-only and accepts ANY value (no server validation) → dashboard isn't really gated. Worse, admin/PII API endpoints have no auth — `GET /api/subscribers` returns subscriber names+emails unauthenticated (verified via curl). Fix: (a) require a validated token/session on admin+PII endpoints server-side (subscribers, affiliate writes, favorites writes, commentary writes, send-newsletter, agent-action), (b) gate the dashboard host (real token check and/or nginx auth/IP-allowlist), (c) consider moving the dashboard off a guessable public subdomain. Mark: fix AFTER current functional bugs. | High (security) | 2026-06-19 |
| 2 | Dashboard | Subscribers/Affiliate/Favorites/Newsletter/Dashboard pages failed to load (404/parse errors) — they called relative `/api/...` (hitting the dashboard's own static host → index.html) instead of the configured PROD API origin. The split left these pages off the shared API client. Fix: prefix relative `/api` with `VITE_API_BASE_URL` in `dashboard/src/main.tsx`. | High | 2026-06-19 |
| 1 | News agent | Confirm which code is actually deployed & serving the live editorial emails (host, process, git branch, scheduler) before cutting over to the new `stillafloat-newsagent` repo. Live email matches monorepo `server/`; deploy source unconfirmed. | High | 2026-06-11 |

---

## In Progress

| # | Page | Description | Notes |
|---|------|-------------|-------|

---

## Fixed

| # | Page | Description | Fixed In |
|---|------|-------------|----------|

---

## Notes
- Website static files live in `artifacts/api-server/public/`
- Preview the site via the "View Website" link in the editorial dashboard header
- In dev, the website is accessible at `/website/` from the Still Afloat Editorial Agent preview
