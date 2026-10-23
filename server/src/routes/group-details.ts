import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { logger } from "../lib/logger";
import { clientIp } from "../lib/client-ip";
import { createAction, resolveActionsForSource, retitleActionsForSource } from "../lib/actions";
import { BUSINESS, hashLinkToken, looksLikeLinkToken } from "../lib/group-secure";
import { creditsForPictures, tidyCopy, type Lang } from "../lib/group-marketing";
import { detailsFacts, detailsTokenFresh, pickCabin, storedConcierge, storedPick, storedTravelers, validateDetails } from "../lib/group-details";

// The guest's "Your details" page (migration 0056; Mark 2026-10-23: "I want to give them the ability to just complete the forms rather than have me call
// them, so it becomes a choice giving them some control"). Public, and the guest's private link is the only credential, exactly like the paperwork link:
// a random 43-character token whose sha256 alone is stored (group_interests.details_token_hash), good for 90 days, one neutral 404 for every kind of
// wrong link.
//
//   GET  /api/group-details/:token             what we already know (name, contact, how many), what they entered so far, the group's cabin categories
//   POST /api/group-details/:token/choice      { choice: "call" } "Mark, call me": Mark is told (the reply's item on his list says so)
//   POST /api/group-details/:token             { travelers, concierge } the names, birthdays and four answers; answers with our cabin pick
//   POST /api/group-details/:token/hold        "Hold my cabin": a request Mark confirms with the cruise line himself. Nothing is booked or charged.
// Every POST carries the bot trap `website` (a person never fills it) and is limited per address.
//
// Dashboard side (token): POST /api/groups/:id/interests/:iid/to-file in routes/group-marketing.ts.

const router: IRouter = Router();
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (): any => getSupabase();

function fail(req: Request, res: Response, err: unknown, what: string) {
  req.log.error({ err }, what);
  return res.status(500).json({ success: false, error: (err as Error).message });
}

function privateHeaders(res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
}

const notFound = (res: Response) => res.status(404).json({ success: false, error: "Not found" });

// ── Limits (per address, in memory: the same pattern as the paperwork routes) ─────────────────────────────────

function limiter(max: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
    const e = hits.get(ip);
    if (!e || e.resetAt < now) { hits.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 }); return false; }
    e.count++;
    return e.count > max;
  };
}
const writeLimited = limiter(30);   // saves, holds and choices per address per hour
const missLimited = limiter(40);    // wrong links per address per hour: a guess is never worth trying
const TOO_MANY = { success: false, error: `Too many attempts. Please try again later, or email ${BUSINESS.email}.` };

// ── The reply behind a link ───────────────────────────────────────────────────────────────────────────────────

interface Loaded { reply: Row; group: Row; cabins: Row[]; lang: Lang }

/** The reply a link opens, with its group and cabins: null for every kind of failure (malformed, unknown, older than 90 days, a group that is no longer taking replies, a reply Mark marked as spam). */
async function load(token: unknown): Promise<Loaded | null> {
  if (!looksLikeLinkToken(token)) return null;
  const { data: reply, error } = await db().from("group_interests").select("*").eq("details_token_hash", hashLinkToken(token)).maybeSingle();
  if (error) throw new Error(error.message);
  if (!reply || reply.status === "spam" || !detailsTokenFresh(reply.details_token_issued_at, new Date())) return null;
  const { data: group, error: ge } = await db().from("groups").select("*").eq("id", reply.group_id).maybeSingle();
  if (ge) throw new Error(ge.message);
  if (!group || !["marketing", "booking"].includes(group.status)) return null;
  const { data: cabins, error: ce } = await db().from("group_cabins").select("*").eq("group_id", group.id).order("id", { ascending: true });
  if (ce) throw new Error(ce.message);
  return { reply, group, cabins: cabins ?? [], lang: reply.lang === "es" ? "es" : "en" };
}

const nameOf = (r: Row) => [r["first_name"], r["last_name"]].filter(Boolean).join(" ");
const contactOf = (r: Row) => String(r["email"] || r["phone"] || "no contact given");

// ── Public ────────────────────────────────────────────────────────────────────────────────────────────────────

router.get("/group-details/:token", async (req: Request, res: Response) => {
  try {
    privateHeaders(res);
    const loaded = await load(req.params["token"]);
    if (!loaded) {
      if (missLimited(clientIp(req))) return res.status(429).json(TOO_MANY);
      return notFound(res);
    }
    const { reply, group, cabins, lang } = loaded;
    const f = detailsFacts({ group, cabins }, lang);
    // The credit line of the top picture, when the page shows one (a CC BY photo must be credited where it is shown): a failed read costs the line, never the page.
    let credits: string[] = [];
    if (f.heroUrl) {
      const { data: assetRows, error: ae } = await db().from("group_assets").select("public_url, attribution").in("public_url", [f.heroUrl]);
      if (ae) logger.warn({ err: ae.message }, "group details: photo credits lookup failed (the page is served without its credit line)");
      else credits = creditsForPictures([f.heroUrl], (assetRows ?? []) as Row[]);
    }
    const blurb = (tidyCopy(group.marketing_copy?.[lang] ?? group.marketing_copy?.en ?? {}) as { cta_blurb?: string }).cta_blurb;
    return res.json({
      success: true,
      label: f.label, ship: f.ship, sailDateText: f.sailDateText, returnDateText: f.returnDateText, heroUrl: f.heroUrl, credits,
      firstName: reply.first_name ?? "", lastName: reply.last_name ?? "", email: reply.email ?? null, phone: reply.phone ?? null, guests: reply.guests ?? null,
      travelers: storedTravelers(reply.travelers) ?? [], concierge: storedConcierge(reply.concierge), pick: storedPick(reply.pick),
      choice: reply.choice ?? null, holdRequestedAt: reply.hold_requested_at ?? null,
      held: f.held, taxesIncluded: f.taxesIncluded, depositPerPersonText: f.depositPerPersonText,
      phoneLine: typeof blurb === "string" && blurb.trim() ? blurb.trim() : null, businessPhone: BUSINESS.phone, lang,
    });
  } catch (err) {
    return fail(req, res, err, "group details read failed");
  }
});

/** Common start of every POST: headers, the per-address limit, the bot trap. Returns true when the request was answered. */
function guardPost(req: Request, res: Response): boolean {
  privateHeaders(res);
  if (writeLimited(clientIp(req))) { res.status(429).json(TOO_MANY); return true; }
  const body = (req.body ?? {}) as Row;
  if (typeof body["website"] === "string" && body["website"]) { res.json({ success: true }); return true; } // honeypot: a person never fills it
  return false;
}

router.post("/group-details/:token/choice", async (req: Request, res: Response) => {
  try {
    if (guardPost(req, res)) return;
    const loaded = await load(req.params["token"]);
    if (!loaded) { if (missLimited(clientIp(req))) return res.status(429).json(TOO_MANY); return notFound(res); }
    if ((req.body as Row | undefined)?.["choice"] !== "call") return res.status(400).json({ success: false, error: "Unknown choice." });
    const { reply, group } = loaded;
    const now = new Date().toISOString();
    const { error } = await db().from("group_interests").update({ choice: "call", choice_at: now, updated_at: now }).eq("id", reply.id);
    if (error) throw new Error(error.message);

    // Mark's list already holds this guest's "Group reply" item: say on it that they want a call (one person, one item). When he has cleared it,
    // this is new news and gets its own.
    const title = `Group reply: ${nameOf(reply)} wants a call`;
    const note = `${group.name}. ${contactOf(reply)}. They chose "Mark, call me": call or text within a day.`;
    const changed = await retitleActionsForSource("lead", `group-interest-${reply.id}`, { title, body: note });
    if (!changed) {
      void createAction({
        type: "lead", source_ref: `group-call-${reply.id}`, title, body: note,
        buttons: [{ label: "Open the group file", href: `/groups/${group.id}` }], priority: "lead",
      }).catch((e: unknown) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "group details: the call request could not be put on the list"));
    }
    return res.json({ success: true });
  } catch (err) {
    return fail(req, res, err, "group details choice failed");
  }
});

router.post("/group-details/:token", async (req: Request, res: Response) => {
  try {
    if (guardPost(req, res)) return;
    const loaded = await load(req.params["token"]);
    if (!loaded) { if (missLimited(clientIp(req))) return res.status(429).json(TOO_MANY); return notFound(res); }
    const { reply, group, cabins } = loaded;
    const asked = (req.body as Row | undefined)?.["lang"];
    const lang: Lang = asked === "es" || asked === "en" ? asked : loaded.lang;
    // Once the cabin is on hold, Mark has the list in front of him: a change now goes through him, not through a form.
    if (reply.hold_requested_at) {
      return res.status(409).json({ success: false, error: lang === "es" ? `Su cabina ya está apartada. Para cambiar algo, llame o escriba a Mark al ${BUSINESS.phone}.` : `Your cabin is already on hold. To change anything, call or text Mark at ${BUSINESS.phone}.` });
    }
    const v = validateDetails(req.body, reply.guests, lang);
    if (!v.ok) return res.status(400).json({ success: false, error: v.error, field: v.field });
    const f = detailsFacts({ group, cabins }, lang);
    const pick = pickCabin(v.concierge, f.held, lang, f.taxesIncluded);
    const { error } = await db().from("group_interests")
      .update({ travelers: v.travelers, concierge: v.concierge, pick, guests: v.count, updated_at: new Date().toISOString() }).eq("id", reply.id);
    if (error) throw new Error(error.message);
    return res.json({ success: true, pick });
  } catch (err) {
    return fail(req, res, err, "group details save failed");
  }
});

router.post("/group-details/:token/hold", async (req: Request, res: Response) => {
  try {
    if (guardPost(req, res)) return;
    const loaded = await load(req.params["token"]);
    if (!loaded) { if (missLimited(clientIp(req))) return res.status(429).json(TOO_MANY); return notFound(res); }
    const { reply, group, lang } = loaded;
    const travelers = storedTravelers(reply.travelers);
    const pick = storedPick(reply.pick);
    if (!travelers || !pick) {
      return res.status(400).json({ success: false, error: lang === "es" ? "Primero termine los nombres y las preguntas." : "Please finish the names and the four questions first." });
    }
    // Only the first press counts: a second one (a double tap, a reload) changes nothing and makes no second item for Mark.
    const now = new Date().toISOString();
    const { data: won, error } = await db().from("group_interests")
      .update({ hold_requested_at: now, choice: "finish", choice_at: now, updated_at: now })
      .eq("id", reply.id).is("hold_requested_at", null).select("id");
    if (error) throw new Error(error.message);
    if (!((won ?? []) as unknown[]).length) return res.json({ success: true });

    const title = `Hold requested: ${nameOf(reply)}, ${pick.category}, party of ${travelers.length}`;
    const body = `${group.name}. ${pick.category}, ${pick.where}. ${contactOf(reply)}. Confirm it with the cruise line, then add them to a cabin from the replies table.`;
    // Their earlier "Group reply" item on Mark's list is answered by this one (one person, one item): close it only once the new one exists.
    void createAction({
      type: "lead", source_ref: `group-hold-${reply.id}`, title, body,
      buttons: [{ label: "Open the group file", href: `/groups/${group.id}` }], priority: "lead",
    }).then((made) => { if (made.created) return resolveActionsForSource("lead", `group-interest-${reply.id}`, "done"); return undefined; })
      .catch((e: unknown) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "group details: the hold request could not be put on the list"));
    return res.json({ success: true });
  } catch (err) {
    return fail(req, res, err, "group details hold failed");
  }
});

export default router;
