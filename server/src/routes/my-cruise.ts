import { Router, type IRouter, type Request, type Response } from "express";
import { clientIp } from "../lib/client-ip";
import { logger } from "../lib/logger";
import { hourlyLimiter } from "../lib/hourly-limit";
import { loadByToken } from "../lib/group-forms";
import { looksLikeCardNumber } from "../lib/group-file";
import { getSupabase } from "../lib/persistence";
import { HUB_SITE, ctxFor, journeyAnswers, localToday, type JourneyInput, type Row } from "../lib/group-journey-facts";
import { mergeJourneyAnswers, renderHub, tickableRow, validateDetails, videoSourcesFor, withChecklistTick } from "../lib/group-journey";
import { strings, type Lang } from "../lib/group-journey-strings";
import { loadJourneyInput, supabaseJourneyStore } from "../lib/group-journey-store";
import { store as formsStore } from "./group-forms";

// The traveler's cruise page (migration 0053): everything after the paperwork, on their own private link.
//
// Public — the link's token is the credential, exactly like the paperwork page; there is no other login:
//   GET  /api/my-cruise/:token                          the page: countdown, sailing, cabin, paperwork, payments, checklist, what we still
//                                                       need, ship, forecast, boarding day, videos and change notices, in the traveler's
//                                                       language (?lang=en|es switches it)
//   POST /api/my-cruise/:token/checklist/:id/done       { done?: boolean } tick (or untick) one checklist row, kept per traveler
//   POST /api/my-cruise/:token/details                  { getting_there, flight_in_*, flight_out_*, hotel_*, transfer_*, port_arrival_time,
//                                                       emergency_name, emergency_phone, website } what the traveler tells us
//
// The rules live in lib/group-journey*.ts (unit-tested with their I/O injected); this file wires them to Supabase and holds the per-address
// limits. A wrong link of any kind gets the same neutral 404; the answers are never cached and never indexed.
//
// NOTE: the link may belong to a traveler of a cancelled group, a replaced link or no one at all — all three look the same from outside.

const router: IRouter = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (): any => getSupabase();

const missLimited = hourlyLimiter(40);    // wrong links per address per hour: a guess is never worth trying
const writeLimited = hourlyLimiter(90);   // ticks and saves per address per hour

const NOT_FOUND = {
  success: false,
  error: `${strings("en").err.notFound} / ${strings("es").err.notFound}`,
};

function privateHeaders(res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function fail(req: Request, res: Response, err: unknown, what: string) {
  req.log.error({ err }, what);
  return res.status(500).json({ success: false, error: "Something went wrong on our side. Please try again in a minute." });
}

const langParam = (req: Request): Lang | undefined => {
  const q = String(req.query["lang"] ?? "").toLowerCase();
  return q === "es" ? "es" : q === "en" ? "en" : undefined;
};

/** Resolve the link to a traveler of a live group, or null (every kind of failure is the same null). */
async function open(token: unknown) {
  const loaded = await loadByToken({ store: formsStore, now: () => new Date() }, token);
  if (!loaded || loaded.kind !== "traveler" || !loaded.traveler) return null;
  return loaded;
}

async function pageFor(token: string, groupId: string, travelerId: string, lang: Lang | undefined) {
  const input = await loadJourneyInput(groupId, { messages: false });
  if (!input) return null;
  const store = supabaseJourneyStore();
  const now = new Date();
  const tz = process.env["TIMEZONE"] || "America/New_York";
  const today = localToday(now, tz);
  const [extras, defaults] = await Promise.all([
    store.extras(input, { videos: true, rating: true, weather: true, storm: true, notices: true }, { realToday: today, simToday: today }),
    store.defaults(),
  ]);
  const ctx = ctxFor(input, travelerId, { now, tz, site: HUB_SITE(), token, extras, ...(lang ? { lang } : {}), videoSources: videoSourcesFor(input.group.journey, defaults) });
  return ctx ? { ctx, input } : null;
}

router.get("/my-cruise/:token", async (req: Request, res: Response) => {
  try {
    privateHeaders(res);
    const token = String(req.params["token"]);
    const loaded = await open(token);
    if (!loaded) {
      if (missLimited(clientIp(req))) return res.status(429).json({ success: false, error: `${strings("en").err.tooMany} / ${strings("es").err.tooMany}` });
      return res.status(404).json(NOT_FOUND);
    }
    const page = await pageFor(token, loaded.group.id, loaded.traveler!.id, langParam(req));
    if (!page) return res.status(404).json(NOT_FOUND);
    return res.json(renderHub(page.ctx));
  } catch (err) {
    return fail(req, res, err, "cruise page failed");
  }
});

router.post("/my-cruise/:token/checklist/:id/done", async (req: Request, res: Response) => {
  try {
    privateHeaders(res);
    const ip = clientIp(req);
    if (writeLimited(ip)) return res.status(429).json({ success: false, error: `${strings("en").err.tooMany} / ${strings("es").err.tooMany}` });
    const loaded = await open(String(req.params["token"]));
    if (!loaded) {
      if (missLimited(ip)) return res.status(429).json({ success: false, error: `${strings("en").err.tooMany} / ${strings("es").err.tooMany}` });
      return res.status(404).json(NOT_FOUND);
    }
    const rowId = String(req.params["id"]);
    if (!/^[0-9a-f-]{36}$/i.test(rowId)) return res.status(404).json({ success: false, error: "That item is not on your list." });
    const input: JourneyInput | null = await loadJourneyInput(loaded.group.id, { messages: false });
    const traveler = input?.travelers.find((t) => t.id === loaded.traveler!.id);
    const row = input && traveler ? tickableRow(input, traveler, rowId) : null;
    if (!input || !traveler || !row) return res.status(404).json({ success: false, error: "That item is not on your list." });
    const done = (req.body as Row | undefined)?.["done"] !== false;
    const wasOwn = !!(journeyAnswers(traveler)["checklist_done"] as Row | undefined)?.[rowId];
    const now = new Date();
    await formsStore.updateTraveler(traveler.id, { form_data: withChecklistTick(traveler.form_data, rowId, done, now), updated_at: now.toISOString() });
    // A row that belongs to the cabin is marked on the file too, so Mark and the cabin mate see it.
    if (row.cabin_id) {
      if (done && !row.done_at) await db().from("group_checklist").update({ done_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", rowId).eq("group_id", input.group.id);
      if (!done && wasOwn && row.done_at) await db().from("group_checklist").update({ done_at: null, updated_at: now.toISOString() }).eq("id", rowId).eq("group_id", input.group.id);
    }
    return res.json({ success: true, id: rowId, done });
  } catch (err) {
    return fail(req, res, err, "cruise page tick failed");
  }
});

router.post("/my-cruise/:token/details", async (req: Request, res: Response) => {
  try {
    privateHeaders(res);
    const ip = clientIp(req);
    if (writeLimited(ip)) return res.status(429).json({ success: false, error: `${strings("en").err.tooMany} / ${strings("es").err.tooMany}` });
    const body = (req.body ?? {}) as Row;
    if (typeof body["website"] === "string" && body["website"]) return res.json({ success: true }); // honeypot: a person never fills it
    if (JSON.stringify(body).length > 20_000) return res.status(413).json({ success: false, error: strings("en").err.tooLong });
    const loaded = await open(String(req.params["token"]));
    if (!loaded) {
      if (missLimited(ip)) return res.status(429).json({ success: false, error: `${strings("en").err.tooMany} / ${strings("es").err.tooMany}` });
      return res.status(404).json(NOT_FOUND);
    }
    const traveler = loaded.traveler!;
    const lang: Lang = langParam(req) ?? (traveler.lang === "es" ? "es" : "en");
    const v = validateDetails(body, lang, looksLikeCardNumber);
    if (!v.ok) return res.status(400).json({ success: false, error: strings(lang).hub.saveFailed, fields: v.errors });
    const now = new Date();
    const patch: Row = {
      form_data: mergeJourneyAnswers(traveler.form_data, v.journey, now, v.emergency ? { emergency_changed_at: now.toISOString() } : {}),
      updated_at: now.toISOString(),
    };
    if (v.emergency) { patch["emergency_name"] = v.emergency.name; patch["emergency_phone"] = v.emergency.phone; }
    await formsStore.updateTraveler(traveler.id, patch);
    logger.info({ group: loaded.group.id, traveler: traveler.id, fields: Object.keys(v.journey).length }, "cruise page: a traveler saved their details");
    return res.json({ success: true, message: strings(lang).hub.saved });
  } catch (err) {
    return fail(req, res, err, "cruise page details failed");
  }
});

export default router;
