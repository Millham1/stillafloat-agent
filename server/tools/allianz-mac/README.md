# Allianz worker (Mark's Mac)

**What it does.** Every minute it asks each Still Afloat site "is an Allianz quote waiting?". When one is, it opens Allianz's agent
website in the Mac's Chrome (out of sight), gets the plans and prices for that trip, and sends them back to the site. The sites never
sign in to Allianz themselves: Allianz lets Mark's own computer in and turns the servers away (found 2026-11-14, three failed
sign-ins from the dev box; the same sign-in worked from the Mac).

**It only works while the Mac is on and awake.** A request made while it is off waits, and is answered when it is back.

## How a quote flows
1. Mark saves a booking's costs on the dashboard (or presses "Ask Allianz again"). The site stores the request as `pending`
   (`POST /api/groups/:id/interests/:iid/protection-quote`). It does not open Allianz.
2. The worker reads `GET /api/allianz/requests` (Mark's token), asks Allianz with `fetchAllianzTripQuote` (lib/allianz-quote.ts),
   and posts the answer to `POST /api/allianz/requests/:id/result`.
3. The booking's Travel protection tab shows the plans; Mark ticks the ones to offer.
`ALLIANZ_RUNS_ON=box` on a server makes that server ask Allianz itself (the old way; only useful on a machine Allianz lets in).

## Install or refresh (on the Mac)
    sh server/tools/allianz-mac/install.sh
Run it again whenever `lib/allianz-quote.ts` or `allianz-mac-worker.ts` changes: the Mac runs the built copy, not the repo.

## Private settings (once, by hand; never in the repo)
`~/.config/saf/allianz-worker.env`, mode 600:

    ALLIANZ_WORKER_SITES='https://dev.stillafloatcruising.com|<dev dashboard token>,https://stillafloatcruising.com|<prod dashboard token>'
    ALLIANZ_AGENT_USER='<Allianz agent sign-in email>'
    ALLIANZ_AGENT_PASSWORD='<Allianz agent password>'

The values are the same ones in each box's `/opt/stillafloat/shared.env` (`AGENT_APPROVAL_TOKEN`, `ALLIANZ_AGENT_USER`,
`ALLIANZ_AGENT_PASSWORD`). A site is only served once its address and token are on the `ALLIANZ_WORKER_SITES` line:
**add prod when this is promoted, or prod's Allianz requests will wait forever.**

## Looking after it
- What it did: `~/Library/Logs/saf-allianz-mac.log` (it writes a line only when a request was waiting).
- One pass by hand: `sh "~/Desktop/Claude Local/saf-ops-tools/allianz-mac/run.sh"`
- Stop: `launchctl bootout gui/$(id -u)/com.stillafloat.allianz-mac` · Start: run install.sh again.
- A booking stuck on "Waiting for your Mac": the Mac is off or asleep, the settings file is missing that site, or Allianz changed
  its screens (the log says where it stopped; `ALLIANZ_DEBUG_DIR=<folder>` in the settings keeps a picture of the screen).
