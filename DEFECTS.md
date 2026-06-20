# Website Defect Tracker

Issues reported by Mark as they're discovered. Add new items at the top of each section.

---

## Open

| # | Page | Description | Priority | Reported |
|---|------|-------------|----------|----------|
| 1 | News agent | Confirm which code is actually deployed & serving the live editorial emails (host, process, git branch, scheduler) before cutting over to the new `stillafloat-newsagent` repo. Live email matches monorepo `server/`; deploy source unconfirmed. | High | 2026-06-11 |

---

## In Progress

| # | Page | Description | Notes |
|---|------|-------------|-------|

---

## Fixed

| # | Page | Description | Fixed In |
|---|------|-------------|----------|
| 3 | Dashboard / API | **PII exposure — CLOSED (two layers).** Layer 1 (server auth): added shared `http-auth.ts` (`tokenOk`/`requireToken`, accepts token via `x-affiliate-token`, `Authorization: Bearer`, or `?token`) and enforced it on every admin/PII route across **both** services — monorepo (`subscribers`, `send-newsletter`, `youtube-feature`, `approved-stories-list`, affiliate/favorites/commentary writes) AND the news-agent (`editorial-queue`, `agent-action`, `scan-news`). Stopped `editorial-queue` echoing `AGENT_APPROVAL_TOKEN`. Dashboard registers `setAuthTokenGetter` + sends `authHeaders` on admin reads; TokenGate validates via new `/api/auth-check`. Verified: all protected endpoints 401 without token, 200 with; token no longer in any response; public site + email approval flow intact. Layer 2 (edge gate): nginx HTTP Basic Auth on `dashboard.stillafloatcruising.com` (`auth_basic`, htpasswd via deploy-nginx.sh). Verified 401 without creds / 200 with. (mTLS was attempted first but macOS client-cert/keychain handling was too painful — switched to Basic Auth.) | monorepo `6eeb8a8`+`ebba9b1`+`58d615c`, news-agent `d6d7c64`, 2026-06-19 |
| 4 | Dashboard | **Writes returned 401 Unauthorized.** Affiliate, Favorites, Newsletter, and Dashboard (YouTube-feature) pages issued POST/PATCH/DELETE without the `x-affiliate-token` header, while the backend's `checkToken()` requires it (`AGENT_APPROVAL_TOKEN`). Affiliate & Favorites broke immediately (those routes enforce the token); Newsletter & Dashboard were latent (their routes don't enforce it yet, but would break the moment the security lockdown adds it). Fix: attach `...authHeaders()` to every write, matching `commentary.tsx` (the only page that was already correct). Confirmed via non-mutating probe: with token → 404 (auth passes), without → 401. Full audit: all 11 routes/reads, CORS (wide-open), and stored-token match verified clean. Verified live end-to-end: created + deleted a test affiliate item through the deployed page (was 401, now 200). | `1697cf3` (dev→main), prod deploy 27850500618, 2026-06-19 |
| 2 | Dashboard | Subscribers/Affiliate/Favorites/Newsletter pages failed to load (404/parse errors) — they called relative `/api/...` (hitting the dashboard's own static host → index.html) instead of the configured PROD API origin. Fixed by prefixing relative `/api` with `VITE_API_BASE_URL` in `dashboard/src/main.tsx` (fetch shim). Verified live: all routes (/, /queue, /approved, /feeds, /alerts, /affiliate, /favorites, /commentary, /subscribers, /newsletter) load real data, no errors. Note: existing browsers with the pre-deploy service worker self-heal on next reload (SW is network-first + skipWaiting). | `7102e3a` (dev→main), prod deploy 27849434247, 2026-06-19 |

---

## Notes
- Website static files live in `artifacts/api-server/public/`
- Preview the site via the "View Website" link in the editorial dashboard header
- In dev, the website is accessible at `/website/` from the Still Afloat Editorial Agent preview
