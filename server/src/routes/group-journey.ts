import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { requireToken } from "../lib/http-auth";
import { getSupabase } from "../lib/persistence";
import { deriveHubToken, hashLinkToken, hubKey } from "../lib/group-secure";
import { looksLikeCardNumber } from "../lib/group-file";
import { journeyDeps } from "../lib/group-journey-wire";
import {
  journeySimEnabled, journeyView, preview, sendChangeNotice, setApproval, simulate, noticeRecipients, sampleTraveler, SIM_PREFIX,
} from "../lib/group-journey-run";
import {
  ALL_KINDS, APPROVABLE_KINDS, DETAIL_FIELDS, JOURNEY_TEMPLATE_VERSION, summarizePlan, videoSourcesFor, type ChangeNotice, type MilestoneKind,
} from "../lib/group-journey";
import { HUB_SITE, journeyAnswers, personName, plain, type Row } from "../lib/group-journey-facts";
import { loadJourneyInput } from "../lib/group-journey-store";
import type { Lang } from "../lib/group-journey-strings";

// The group journey, Mark's side (migration 0053). Every route needs his token; the dry run needs the box to ask for it.
//
//   GET    /api/groups/:id/journey                       the plan: each message kind with its approval and counts, each traveler's items,
//                                                         the recent journey emails, what travelers told us, and whether this box can simulate
//   PUT    /api/groups/:id/journey/approve               { kinds: [...], approved: true|false|null, as_default?: true } approve, withdraw, or (null) follow the site default again
//   GET    /api/groups/:id/journey/preview/:kind         ?lang=en|es&traveler_id=  one message rendered for a sample traveler (html, text, sections)
//   POST   /api/groups/:id/travelers/:tid/cruise-link   the traveler's private cruise-page link (derived from the traveler, so it is the same link every time)
//   POST   /api/groups/:id/journey/change-notice         { text, text_es?, fields: [{label, before, after}] }  ?preview=1 shows it, otherwise sends it
//   POST   /api/groups/:id/journey/simulate              { traveler_id, to_email, lang?, kinds? } DEV ONLY (GROUP_JOURNEY_SIM=1): the whole sequence now
//   DELETE /api/groups/:id/journey/simulate              ?traveler_id=  DEV ONLY: remove the simulated messages from the log
//
// The rules live in lib/group-journey*.ts (unit-tested with their I/O injected); this file validates, calls them and shapes the answers.
// Mounted before routes/groups.ts: its /groups/:id/:child/:rowId would otherwise answer the DELETE.

const router: IRouter = Router();

function fail(req: Request, res: Response, err: unknown, what: string) {
  req.log.error({ err }, what);
  return res.status(500).json({ success: false, error: (err as Error).message });
}

/** On a box that does not simulate (prod, or any box without the flag) the dry run answers like a page that does not exist. */
function simGate(_req: Request, res: Response, next: NextFunction) {
  if (!journeySimEnabled()) return res.status(404).json({ success: false, error: "Not found" });
  return next();
}

const langQ = (v: unknown): Lang | undefined => (v === "es" ? "es" : v === "en" ? "en" : undefined);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const asKind = (v: unknown): MilestoneKind | null => (typeof v === "string" && (ALL_KINDS as string[]).includes(v) ? (v as MilestoneKind) : null);

router.get("/groups/:id/journey", requireToken, async (req: Request, res: Response) => {
  try {
    const deps = journeyDeps();
    const got = await journeyView(deps, String(req.params["id"]));
    if (!got) return res.status(404).json({ success: false, error: "Group not found" });
    const { input, view } = got;
    const milestones = summarizePlan(view.plan, input.group).map((m) => ({ ...m, approval: view.approvals.find((a) => a.kind === m.kind)! }));
    const names = new Map(input.travelers.map((t) => [t.id, personName(t)]));
    const told = input.travelers.map((t) => {
      const a = journeyAnswers(t);
      const answers: Record<string, string> = {};
      for (const f of DETAIL_FIELDS) { const v = f.name === "emergency_name" ? t.emergency_name : f.name === "emergency_phone" ? t.emergency_phone : a[f.name]; if (typeof v === "string" && v) answers[f.name] = v; }
      return { traveler_id: t.id, name: names.get(t.id) || "Unnamed traveler", answers, updated_at: typeof a["updated_at"] === "string" ? a["updated_at"] : null };
    }).filter((x) => Object.keys(x.answers).length);
    const messages = (input.messages ?? [])
      .filter((m) => (ALL_KINDS as string[]).includes(String(m.template)) && (m.traveler_id || m.template === "change-notice"))
      .slice(0, 80)
      .map((m) => ({
        id: m.id, template: m.template, traveler_id: m.traveler_id ?? null, traveler: m.traveler_id ? names.get(m.traveler_id) ?? null : null, to_email: m.to_email ?? null,
        subject: m.subject ?? null, status: m.status, sent_at: m.sent_at ?? null, created_at: m.created_at, error: m.error ?? null, sim: String(m.dedupe_key ?? "").startsWith(SIM_PREFIX),
      }));
    return res.json({
      success: true,
      template_version: JOURNEY_TEMPLATE_VERSION,
      sim_enabled: journeySimEnabled(),
      link_key_set: !!deps.linkKey,
      test_list_set: !!deps.allow?.trim(),
      live: view.plan.live, live_reason: view.plan.liveReason,
      today: view.plan.today, sail_date: view.plan.sailDate, days_to_sail: view.plan.daysToSail,
      video_sources: videoSourcesFor(input.group.journey, view.defaults),
      milestones,
      travelers: view.plan.travelers.map((t) => ({
        id: t.id, name: t.name, lang: t.lang, has_email: t.hasEmail,
        items: t.items.map((i) => ({ kind: i.kind, date: i.date, status: i.status, reason: i.reason, blocked: i.blocked })),
      })),
      messages, told,
    });
  } catch (err) {
    return fail(req, res, err, "journey read failed");
  }
});

router.post("/groups/:id/travelers/:tid/cruise-link", requireToken, async (req: Request, res: Response) => {
  try {
    const tid = String(req.params["tid"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (getSupabase() as any).from("group_travelers").select("id").eq("id", tid).eq("group_id", String(req.params["id"])).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ success: false, error: "Traveler not found" });
    const key = hubKey();
    if (!key) return res.status(409).json({ success: false, error: "This box has no link key (GROUP_LINK_KEY or GROUP_PII_KEY), so it cannot make a cruise-page link." });
    const token = deriveHubToken(tid, key);
    // The link works from this moment: the hash that finds the traveler is stored with it (the token itself never is).
    await journeyDeps().store.setHubHash(tid, hashLinkToken(token));
    return res.status(201).json({ success: true, url: `${HUB_SITE()}/my-cruise.html?t=${token}` });
  } catch (err) {
    return fail(req, res, err, "cruise link failed");
  }
});

router.put("/groups/:id/journey/approve", requireToken, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Row;
    const kinds: unknown = body["kinds"];
    if (!Array.isArray(kinds) || !kinds.length || kinds.length > 20 || kinds.some((k) => typeof k !== "string" || !(APPROVABLE_KINDS as string[]).includes(k))) {
      return res.status(400).json({ success: false, error: `kinds must be a list of: ${APPROVABLE_KINDS.join(", ")}` });
    }
    if (typeof body["approved"] !== "boolean" && body["approved"] !== null) return res.status(400).json({ success: false, error: "approved must be true, false or null (null = follow the site default again)" });
    const out = await setApproval(journeyDeps(), String(req.params["id"]), kinds as string[], body["approved"] as boolean | null, body["as_default"] === true);
    if (!out) return res.status(404).json({ success: false, error: "Group not found" });
    return res.json({ success: true, version: JOURNEY_TEMPLATE_VERSION, kinds, approved: body["approved"], as_default: body["as_default"] === true });
  } catch (err) {
    return fail(req, res, err, "journey approval failed");
  }
});

router.get("/groups/:id/journey/preview/:kind", requireToken, async (req: Request, res: Response) => {
  try {
    const kind = asKind(req.params["kind"]);
    if (!kind || kind === "change-notice") return res.status(404).json({ success: false, error: "Unknown message kind" });
    const deps = journeyDeps();
    const input = await deps.store.load(String(req.params["id"]));
    if (!input) return res.status(404).json({ success: false, error: "Group not found" });
    const out = await preview(deps, input, kind, { travelerId: typeof req.query["traveler_id"] === "string" ? req.query["traveler_id"] : null, lang: langQ(req.query["lang"]) });
    if (!out.ok) return res.status(400).json({ success: false, error: out.error });
    return res.json({ success: true, ...out });
  } catch (err) {
    return fail(req, res, err, "journey preview failed");
  }
});

/** The notice as Mark typed it, checked: bounded, no card numbers, at most 12 changed items. */
function readNotice(body: Row): { ok: true; notice: ChangeNotice } | { ok: false; error: string } {
  const text = typeof body["text"] === "string" ? body["text"].replace(/\r/g, "").trim() : "";
  if (!text) return { ok: false, error: "Write what changed: the notice needs some text." };
  if (text.length > 4000) return { ok: false, error: "That notice is too long (4,000 characters at most)." };
  const textEs = typeof body["text_es"] === "string" ? body["text_es"].replace(/\r/g, "").trim() : "";
  if (textEs.length > 4000) return { ok: false, error: "The Spanish text is too long (4,000 characters at most)." };
  const raw: unknown = body["fields"] ?? [];
  if (!Array.isArray(raw) || raw.length > 12) return { ok: false, error: "The changed items must be a list of at most 12." };
  const fields: ChangeNotice["fields"] = [];
  for (const f of raw) {
    const o = (f && typeof f === "object" ? f : {}) as Row;
    const label = plain(o["label"], 80), before = plain(o["before"], 200), after = plain(o["after"], 200);
    if (!label && !before && !after) continue;
    if (!label) return { ok: false, error: "Each changed item needs a name (what changed)." };
    fields.push({ label, before, after });
  }
  for (const s of [text, textEs, ...fields.flatMap((f) => [f.label, f.before, f.after])]) {
    if (looksLikeCardNumber(s)) return { ok: false, error: "That looks like a payment card number. Card numbers never go in an email from the file." };
  }
  return { ok: true, notice: { text, text_es: textEs || null, fields } };
}

router.post("/groups/:id/journey/change-notice", requireToken, async (req: Request, res: Response) => {
  try {
    const read = readNotice((req.body ?? {}) as Row);
    if (!read.ok) return res.status(400).json({ success: false, error: read.error });
    const deps = journeyDeps();
    const input = await deps.store.load(String(req.params["id"]));
    if (!input) return res.status(404).json({ success: false, error: "Group not found" });
    if (req.query["preview"] === "1" || req.query["preview"] === "true") {
      const out = await preview(deps, input, "change-notice", {
        travelerId: typeof req.query["traveler_id"] === "string" ? req.query["traveler_id"] : null, lang: langQ(req.query["lang"]), notice: read.notice,
      });
      if (!out.ok) return res.status(400).json({ success: false, error: out.error });
      const recipients = noticeRecipients(input, deps.allow);
      return res.json({ success: true, ...out, recipients, will_send: recipients.filter((r) => r.willSend).length });
    }
    const out = await sendChangeNotice(deps, input, read.notice);
    if ("error" in out) return res.status(409).json({ success: false, error: out.error });
    return res.status(201).json({ success: true, notice_id: out.noticeId, sent: out.sent, failed: out.failed, already_sent: out.alreadySent, recipients: out.recipients });
  } catch (err) {
    return fail(req, res, err, "change notice failed");
  }
});

router.post("/groups/:id/journey/simulate", simGate, requireToken, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Row;
    const to = typeof body["to_email"] === "string" ? body["to_email"].trim().toLowerCase() : "";
    if (!EMAIL.test(to)) return res.status(400).json({ success: false, error: "to_email must be a test address" });
    const deps = journeyDeps();
    const input = await loadJourneyInput(String(req.params["id"]));
    if (!input) return res.status(404).json({ success: false, error: "Group not found" });
    const traveler = typeof body["traveler_id"] === "string" ? input.travelers.find((t) => t.id === body["traveler_id"]) : sampleTraveler(input, null);
    if (!traveler) return res.status(404).json({ success: false, error: "Traveler not found" });
    const kinds = Array.isArray(body["kinds"]) ? (body["kinds"] as unknown[]).map(asKind).filter((k): k is MilestoneKind => !!k) : undefined;
    const out = await simulate(deps, input, { travelerId: traveler.id, toEmail: to, lang: langQ(body["lang"]), kinds });
    if ("error" in out) return res.status(409).json({ success: false, error: out.error });
    return res.status(201).json({
      success: true, traveler_id: traveler.id, to_email: to, count: out.length,
      sent: out.filter((x) => x.status === "sent").length,
      messages: out.map((x) => ({ kind: x.kind, subject: x.subject, sections: x.sections, text: x.text, status: x.status, reason: x.reason })),
    });
  } catch (err) {
    return fail(req, res, err, "journey simulation failed");
  }
});

router.delete("/groups/:id/journey/simulate", simGate, requireToken, async (req: Request, res: Response) => {
  try {
    const deps = journeyDeps();
    const tid = typeof req.query["traveler_id"] === "string" && req.query["traveler_id"] ? req.query["traveler_id"] : null;
    const removed = await deps.store.removeSim(String(req.params["id"]), tid);
    return res.json({ success: true, removed });
  } catch (err) {
    return fail(req, res, err, "journey simulation cleanup failed");
  }
});

export default router;
