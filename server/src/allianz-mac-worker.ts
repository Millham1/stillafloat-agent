// allianz-mac-worker.ts — runs on Mark's Mac, never on a box (Mark 2026-11-14: "you need to code this into the process, to use my local to
// connect to Allianz. we will need it for future quotes"). Allianz lets his own computer in and turns the boxes away, so the sites only QUEUE a
// request (routes/group-details.ts, GET /api/allianz/requests) and this worker does the asking: one pass reads each site's waiting list, asks
// Allianz in the Mac's own Chrome with the same lookup the site used to run (lib/allianz-quote.ts), and sends each answer back
// (POST /api/allianz/requests/:id/result). launchd starts a pass every minute; a pass that is still running is not started twice.
// Settings (a private file on the Mac, read by run.sh): ALLIANZ_WORKER_SITES = "https://site|token,https://other|token",
// ALLIANZ_AGENT_USER, ALLIANZ_AGENT_PASSWORD, CHROME_PATH (defaults to Google Chrome on a Mac).
import { existsSync } from "node:fs";
import { fetchAllianzTripQuote, type TripQuoteInput, type TripQuoteOutcome } from "./lib/allianz-quote";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const say = (line: string): void => { console.log(`${new Date().toISOString()} ${line}`); };

export interface WorkerSite { url: string; token: string }
/** "https://site|token,https://other|token" → the sites to check. An entry without an address and a token is dropped. */
export function sitesFrom(raw: string | undefined): WorkerSite[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => { const i = s.lastIndexOf("|"); return i < 0 ? { url: "", token: "" } : { url: s.slice(0, i).replace(/\/+$/, ""), token: s.slice(i + 1) }; })
    .filter((s) => /^https?:\/\/[^|\s]+$/.test(s.url) && !!s.token);
}

type Ask = (input: TripQuoteInput) => Promise<TripQuoteOutcome>;
/** One pass over one site: every waiting request is asked and answered. Returns how many answers the site took. */
export async function passOver(site: WorkerSite, ask: Ask, http: typeof fetch = fetch): Promise<number> {
  const headers = { "x-affiliate-token": site.token, "content-type": "application/json" };
  const res = await http(`${site.url}/api/allianz/requests`, { headers });
  if (!res.ok) { say(`${site.url}: the waiting list did not answer (${res.status})`); return 0; }
  const body = (await res.json()) as { requests?: Array<{ id: string; requested_at: string; input: TripQuoteInput }> };
  let done = 0;
  for (const r of body.requests ?? []) {
    say(`${site.url}: asking Allianz for request ${r.id} (trip $${r.input.total_trip_cost}, ${r.input.ages.length} traveler(s), ${r.input.state})`);
    const out = await ask(r.input).catch((e: unknown): TripQuoteOutcome => ({ status: "unavailable", reason: (e instanceof Error ? e.message : String(e)).slice(0, 300) }));
    const back = await http(`${site.url}/api/allianz/requests/${r.id}/result`, { method: "POST", headers, body: JSON.stringify({ requested_at: r.requested_at, ...out }) });
    say(`${site.url}: request ${r.id}: ${out.status === "ready" ? `${out.plans.length} plans` : `could not be priced: ${out.reason}`} (the site answered ${back.status})`);
    if (back.ok) done++;
  }
  return done;
}

async function main(): Promise<void> {
  const sites = sitesFrom(process.env["ALLIANZ_WORKER_SITES"]);
  const chromePath = process.env["CHROME_PATH"] || (existsSync(MAC_CHROME) ? MAC_CHROME : undefined);
  const env = { chromePath, user: process.env["ALLIANZ_AGENT_USER"], password: process.env["ALLIANZ_AGENT_PASSWORD"] };
  if (!sites.length) { say("no site to check (ALLIANZ_WORKER_SITES is empty)"); process.exitCode = 1; return; }
  for (const site of sites) await passOver(site, (input) => fetchAllianzTripQuote(input, env)).catch((e: unknown) => say(`${site.url}: ${e instanceof Error ? e.message : String(e)}`));
}
if (process.argv[1] && /allianz-mac-worker\.m?js$/.test(process.argv[1])) void main();
