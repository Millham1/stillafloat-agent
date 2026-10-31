import { Router, type IRouter, type Request, type Response } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { subscriptionCount, getVapidPublicKey } from "../lib/push";
import { requireToken } from "../lib/http-auth";
import { jobHealthReport } from "../lib/job-health";
import { getSupabase } from "../lib/persistence";
import { countriesOf } from "../lib/entry-requirements";
import { itineraryPorts } from "../lib/travel-advisories";
import { CRUISE_TERRITORIES, VISA_REVIEW_DAYS, VISA_SOURCE, iso2Of, supabaseVisaStore } from "../lib/visa-requirements";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// ── Canary surface ────────────────────────────────────────────────────────────
// Read by the watchdog on the OTHER box. A canary that runs inside the process it
// watches cannot report that process dying, and the alert channel cannot report
// its own silence — on 2026-08-26 web push had zero devices for five days and the
// only thing that noticed wrote it to a log file.
//
// Gated by CANARY_TOKEN, a single-purpose read-only secret: the device count is
// exactly the fact an attacker would want ("is the operator receiving alerts right
// now?"), so it is not public, and the canary never needs the dashboard token.
router.get("/healthz/alerts", (req: Request, res: Response) => {
  const expected = process.env["CANARY_TOKEN"];
  const got = req.get("x-canary-token") || "";
  if (!expected || got.length !== expected.length || got !== expected) {
    res.status(401).json({ ok: false });
    return;
  }
  void (async () => {
    try {
      res.json({
        ok: true,
        devices: await subscriptionCount(),
        vapid: Boolean(getVapidPublicKey()),
        ts: new Date().toISOString(),
      });
    } catch {
      // Reachable but unable to read its own state is a FAULT, not a 200 — the
      // canary must be able to tell "healthy" from "cannot tell".
      res.status(503).json({ ok: false, error: "state unreadable" });
    }
  })();
});

// ── Job-health ledger ─────────────────────────────────────────────────────────
// Every scheduled job's last start / success / error / streak, plus the error counter (lib/job-health.ts,
// lib/error-ledger.ts). Token-gated: it names jobs, errors and timings. `ok` is false when any job is
// overdue; the release gate (e2e/checks/vitals.mjs) reads this on every sweep.
router.get("/healthz/jobs", requireToken, (_req: Request, res: Response) => {
  const report = jobHealthReport();
  res.set("Cache-Control", "no-store");
  res.status(report.ok ? 200 : 503).json({ success: true, ...report });
});

// ── The visa requirements table (Mark 2026-10-31) ─────────────────────────────
// How many destinations the table holds for a U.S. passport, when they were checked and when the quarterly review is due, and
// whether every country on an open group's itinerary has a row (the passport checklist reads the table). Token-gated like the
// job ledger; the release gate reads it on every sweep.
router.get("/healthz/visa-requirements", requireToken, async (_req: Request, res: Response) => {
  type Row = Record<string, unknown>;
  try {
    const rows = await supabaseVisaStore().all("US");
    const g = await getSupabase().from("groups").select("id, name, status, embark_port, itinerary").not("status", "in", "(cancelled,closed,sailed)");
    if (g.error) throw new Error(g.error.message);
    const countries = new Map<string, string[]>();
    for (const grp of (g.data ?? []) as Row[]) {
      for (const { country } of countriesOf(itineraryPorts(grp as Record<string, any>))) countries.set(country, [...(countries.get(country) ?? []), String(grp["name"] ?? grp["id"])]);
    }
    const missing = [...countries.keys()].filter((c) => { const code = iso2Of(c); return !code || !rows.some((r) => r.destination_iso2 === code); });
    const checked = rows.map((r) => r.checked_at).sort(), next = rows.map((r) => r.next_check_at).sort();
    const sources: Record<string, number> = {};
    for (const r of rows) sources[r.source] = (sources[r.source] ?? 0) + 1;
    res.set("Cache-Control", "no-store");
    res.json({
      success: true, passport: "US", source: VISA_SOURCE, review_days: VISA_REVIEW_DAYS, rows: rows.length, sources,
      // Mark 2026-10-31 ("Yes, add one"): Orizn fills the territories the dataset lacks, with a key of Mark's on the box
      orizn_key: !!process.env["ORIZN_API_KEY"],
      checked_at: checked[checked.length - 1] ?? null, oldest_checked_at: checked[0] ?? null, next_check_at: next[0] ?? null,
      coverage: { countries: [...countries.keys()].sort(), missing, territories_missing: CRUISE_TERRITORIES.filter((c) => !rows.some((r) => r.destination_iso2 === c)) },
      sample: rows.filter((r) => ["BS", "MX", "KY", "JM"].includes(r.destination_iso2)).map((r) => ({ destination_iso2: r.destination_iso2, destination_name: r.destination_name, requirement: r.requirement, stay_days: r.stay_days, checked_at: r.checked_at })),
    });
  } catch (err) {
    res.set("Cache-Control", "no-store");
    res.status(503).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
