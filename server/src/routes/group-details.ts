import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { logger } from "../lib/logger";
import { clientIp } from "../lib/client-ip";
import { createAction, resolveActionsForSource, retitleActionsForSource } from "../lib/actions";
import { BUSINESS, hashLinkToken, looksLikeLinkToken } from "../lib/group-secure";
import { creditsForPictures, tidyCopy, type Lang } from "../lib/group-marketing";
import { mailAllowed } from "../lib/group-forms";
import { sendMail } from "../lib/mailer";
import {
  WHEN_WORD, callEmail, callerPhone, detailsFacts, detailsTokenFresh, detailsUrl as makeDetailsUrl, firstWord, holdEmail, pickCabin, reasonsInWords, storedAddress, storedConcierge,
  storedPick, storedTravelers, validCallWhen, validateConcierge, validateDetails, type DetailsFacts,
} from "../lib/group-details";

// The guest's two roads after "Save my spot!" on a group page (migrations 0056 and 0057; Mark 2026-10-23, reshaped 2026-10-24: "the client should not get 2").
// Public, and the guest's private link is the only credential, exactly like the paperwork link: a random 43-character token whose sha256 alone is stored
// (group_interests.details_token_hash), good for 90 days, one neutral 404 for every kind of wrong link.
//
//   GET  /api/group-details/:token             what we already know (name, contact, how many), what they entered so far
//   POST /api/group-details/:token/choice      Road A, { choice: "call", when } "Talk me into it, Mark!": Mark gets one item to ring, the guest ONE email
//   POST /api/group-details/:token/pick        Road B, { concierge } the four answers; answers with our cabin pick (stored on the reply)
//   POST /api/group-details/:token             Road B, { travelers, address, concierge } the names, birthdays, home address and four answers; answers with our pick
//   POST /api/group-details/:token/hold        Road B, "Hold my cabin!": a request Mark confirms with the cruise line himself; the guest gets ONE email.
//                                              Nothing is booked or charged.
// Every POST carries the bot trap `website` (a person never fills it) and is limited per address. NO email goes out when a reply is saved: the one email
// is sent when the guest has chosen a road (routes/group-marketing.ts saves the reply and hands back the link).
//
// Dashboard side (token): POST /api/groups/:id/interests/:iid/to-file and .../mark/:how in routes/group-marketing.ts.

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
const publicSite = () => (process.env["PUBLIC_URL"] || "https://stillafloatcruising.com").replace(/\/$/, "");

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
const writeLimited = limiter(30);   // saves, picks, holds and choices per address per hour
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
const reachOf = (r: Row) => String(r["email"] || r["phone"] || "no contact given");
const blurbOf = (group: Row, lang: Lang): string | undefined => (tidyCopy(group.marketing_copy?.[lang] ?? group.marketing_copy?.en ?? {}) as { cta_blurb?: string }).cta_blurb;

/** "today at 4:12 PM" / "Oct 23 at 4:12 PM", in Mark's time zone: when the guest saved their spot, for his list. */
function whenSaved(iso: unknown, now = new Date()): string {
  const t = new Date(String(iso));
  if (!Number.isFinite(t.getTime())) return "just now";
  const tz = "America/New_York";
  const day = (d: Date) => d.toLocaleDateString("en-US", { timeZone: tz });
  const clock = t.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return day(t) === day(now) ? `today at ${clock}` : `${t.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" })} at ${clock}`;
}

/**
 * The ONE email of a road, after the answer has gone: what happened to it is written on the reply (ack_email_status) and in the email log (group_messages,
 * never the link). Only with an email address on the reply and an address this box may email (the dev box emails only its test addresses).
 */
async function deliver(o: { group: Row; reply: Row; template: "call-confirmation" | "hold-confirmation"; make: () => { subject: string; html: string; text: string } }): Promise<void> {
  const { group, reply } = o;
  const set = (patch: Row) => db().from("group_interests").update(patch).eq("id", reply.id).then((r: { error?: { message: string } }) => {
    if (r.error) logger.warn({ err: r.error.message }, "group details: the email status could not be saved");
  });
  const email = typeof reply.email === "string" ? reply.email.trim() : "";
  if (!email) { await set({ ack_email_status: "no-email" }); return; }
  if (!mailAllowed(email, process.env["GROUP_FORMS_MAIL_ALLOW"])) { // the dev box emails only its test addresses
    await set({ ack_email_status: "held" });
    await db().from("group_messages").insert({ group_id: group.id, audience: "client", template: o.template, to_email: email, subject: null, status: "skipped", error: "held: this box only emails its test addresses" });
    return;
  }
  const mail = o.make();
  const ok = await sendMail({ to: email, subject: mail.subject, html: mail.html, text: mail.text, fromName: BUSINESS.agentName, replyTo: BUSINESS.email });
  const at = new Date().toISOString();
  await set({ ack_email_status: ok ? "sent" : "failed", ack_email_at: ok ? at : null });
  await db().from("group_messages").insert({
    group_id: group.id, audience: "client", template: o.template, to_email: email, subject: mail.subject,
    status: ok ? "sent" : "failed", sent_at: ok ? at : null, error: ok ? null : "mail sender refused or was unreachable",
  });
}

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
    const blurb = blurbOf(group, lang);
    // No cabin price is in this answer: the guest saw the prices on the group page, and nothing after it repeats them (Mark 2026-10-24).
    return res.json({
      success: true,
      label: f.label, ship: f.ship, sailDateText: f.sailDateText, returnDateText: f.returnDateText, heroUrl: f.heroUrl, credits,
      firstName: reply.first_name ?? "", lastName: reply.last_name ?? "", email: reply.email ?? null, phone: reply.phone ?? null, guests: reply.guests ?? null,
      travelers: storedTravelers(reply.travelers) ?? [], address: storedAddress(reply.address), concierge: storedConcierge(reply.concierge), pick: storedPick(reply.pick),
      choice: reply.choice ?? null, callWhen: reply.call_when ?? null, holdRequestedAt: reply.hold_requested_at ?? null,
      depositPerPersonText: f.depositPerPersonText,
      phoneLine: typeof blurb === "string" && blurb.trim() ? blurb.trim() : null, businessPhone: callerPhone(blurb), lang,
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

const askedLang = (req: Request, loaded: Loaded): Lang => {
  const asked = (req.body as Row | undefined)?.["lang"];
  return asked === "es" || asked === "en" ? asked : loaded.lang;
};

/** Once the cabin is on hold, Mark has the list in front of him: a change now goes through him, not through a form. */
const alreadyHeld = (lang: Lang) => ({
  success: false,
  error: lang === "es" ? `Su cabina ya está apartada. Para cambiar algo, llame o escriba a Mark al ${BUSINESS.phone}.` : `Your cabin is already on hold. To change anything, call or text Mark at ${BUSINESS.phone}.`,
});

// ── Road A: "Talk me into it, Mark!" ──────────────────────────────────────────────────────────────────────────

router.post("/group-details/:token/choice", async (req: Request, res: Response) => {
  try {
    if (guardPost(req, res)) return;
    const loaded = await load(req.params["token"]);
    if (!loaded) { if (missLimited(clientIp(req))) return res.status(429).json(TOO_MANY); return notFound(res); }
    const body = (req.body ?? {}) as Row;
    if (body["choice"] !== "call") return res.status(400).json({ success: false, error: "Unknown choice." });
    const { reply, group, cabins } = loaded;
    const lang = askedLang(req, loaded);
    const when = validCallWhen(body["when"]);
    if (!when) return res.status(400).json({ success: false, error: lang === "es" ? "Elija un horario que le convenga." : "Pick a time that suits you.", field: "when" });
    if (reply.hold_requested_at) return res.status(409).json(alreadyHeld(lang));

    const now = new Date().toISOString();
    // The first press wins (a double tap, a second tab): it makes the one item for Mark and sends the one email. A later press only changes the time.
    const { data: won, error } = await db().from("group_interests")
      .update({ choice: "call", choice_at: now, call_when: when, updated_at: now }).eq("id", reply.id).is("choice_at", null).select("id");
    if (error) throw new Error(error.message);
    const first = ((won ?? []) as unknown[]).length > 0;
    if (!first) {
      const { error: ue } = await db().from("group_interests").update({ call_when: when, updated_at: now }).eq("id", reply.id);
      if (ue) throw new Error(ue.message);
    }

    // Mark's list already holds this guest's "Group reply" item: it becomes the one to ring (one person, one item), in place, with no second ping. When he
    // has cleared it, this is new news and gets its own. ("Later tonight" is not offered: the actions list has no snooze to hang it on.)
    const f = detailsFacts({ group, cabins }, "en");
    const who = nameOf(reply);
    const title = `Ring ${who} · ${reply.guests ? `party of ${reply.guests} · ` : ""}${WHEN_WORD[when]}`;
    const note = `${f.label} · ${reachOf(reply)} · saved their spot ${whenSaved(reply.created_at)} and said "talk me into it".`;
    const buttons = [
      { label: "Open the group file", href: `/groups/${group.id}` },
      { label: "We talked", method: "POST", path: `/api/groups/${group.id}/interests/${reply.id}/mark/talked` },
    ];
    const changed = await retitleActionsForSource("lead", `group-interest-${reply.id}`, { title, body: note, buttons });
    if (!changed && first) {
      void createAction({ type: "lead", source_ref: `group-call-${reply.id}`, title, body: note, buttons, priority: "lead" })
        .catch((e: unknown) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "group details: the call request could not be put on the list"));
    }
    res.json({ success: true });

    if (!first) return;
    // The ONE email, after the answer has gone, so the guest never waits on the mailer.
    void deliver({
      group, reply, template: "call-confirmation",
      make: () => callEmail({
        firstName: firstWord(reply.first_name), groupLabel: detailsFacts({ group, cabins }, lang).label, hostNames: detailsFacts({ group, cabins }, lang).hostNames, lang, publicSite: publicSite(),
        when, phone: callerPhone(blurbOf(group, lang)),
      }),
    }).catch((e: unknown) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "group details: the call confirmation step failed"));
    return;
  } catch (err) {
    return fail(req, res, err, "group details choice failed");
  }
});

// ── Road B: "I've got this… let me fill it in!" ───────────────────────────────────────────────────────────────

router.post("/group-details/:token/pick", async (req: Request, res: Response) => {
  try {
    if (guardPost(req, res)) return;
    const loaded = await load(req.params["token"]);
    if (!loaded) { if (missLimited(clientIp(req))) return res.status(429).json(TOO_MANY); return notFound(res); }
    const { reply, group, cabins } = loaded;
    const lang = askedLang(req, loaded);
    if (reply.hold_requested_at) return res.status(409).json(alreadyHeld(lang));
    const v = validateConcierge(req.body, lang);
    if (!v.ok) return res.status(400).json({ success: false, error: v.error, field: v.field });
    const f = detailsFacts({ group, cabins }, lang);
    const pick = pickCabin(v.concierge, f.held, lang, f.upgradePerks);
    const { error } = await db().from("group_interests").update({ concierge: v.concierge, pick, updated_at: new Date().toISOString() }).eq("id", reply.id);
    if (error) throw new Error(error.message);
    return res.json({ success: true, pick });
  } catch (err) {
    return fail(req, res, err, "group details pick failed");
  }
});

router.post("/group-details/:token", async (req: Request, res: Response) => {
  try {
    if (guardPost(req, res)) return;
    const loaded = await load(req.params["token"]);
    if (!loaded) { if (missLimited(clientIp(req))) return res.status(429).json(TOO_MANY); return notFound(res); }
    const { reply, group, cabins } = loaded;
    const lang = askedLang(req, loaded);
    if (reply.hold_requested_at) return res.status(409).json(alreadyHeld(lang));
    const v = validateDetails(req.body, reply.guests, lang);
    if (!v.ok) return res.status(400).json({ success: false, error: v.error, field: v.field });
    const f = detailsFacts({ group, cabins }, lang);
    const pick = pickCabin(v.concierge, f.held, lang, f.upgradePerks);
    const { error } = await db().from("group_interests")
      .update({ travelers: v.travelers, address: v.address, concierge: v.concierge, pick, guests: v.count, updated_at: new Date().toISOString() }).eq("id", reply.id);
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
    const { reply, group, cabins, lang } = loaded;
    const travelers = storedTravelers(reply.travelers);
    const pick = storedPick(reply.pick);
    const address = storedAddress(reply.address);
    if (!travelers || !pick || !address) {
      return res.status(400).json({ success: false, error: lang === "es" ? "Primero termine los nombres, la dirección y las preguntas." : "Please finish the names, the address and the four questions first." });
    }
    // Only the first press counts: a second one (a double tap, a reload) changes nothing, makes no second item for Mark and sends no second email.
    const now = new Date().toISOString();
    const { data: won, error } = await db().from("group_interests")
      .update({ hold_requested_at: now, choice: "finish", choice_at: now, updated_at: now })
      .eq("id", reply.id).is("hold_requested_at", null).select("id");
    if (error) throw new Error(error.message);
    if (!((won ?? []) as unknown[]).length) return res.json({ success: true });

    const f = detailsFacts({ group, cabins }, "en");
    const reasons = storedConcierge(reply.concierge);
    const title = `Hold requested · ${nameOf(reply)} · ${pick.category} · party of ${travelers.length}`;
    const body = `${f.label} · ${reachOf(reply)} · ${pick.where}${reasons ? ` (${reasonsInWords(reasons)})` : ""}. Names, birthdays and the address are on the reply.`;
    // Their earlier item on Mark's list ("Group reply", or "Ring …" if they had asked for a call first) is answered by this one (one person, one item): close it only once the new one exists.
    void createAction({
      type: "lead", source_ref: `group-hold-${reply.id}`, title, body, priority: "lead",
      buttons: [
        { label: "Add the travelers to a cabin", href: `/groups/${group.id}#replies` },
        { label: "Open the group file", href: `/groups/${group.id}` },
        { label: "Confirmed with MSC", method: "POST", path: `/api/groups/${group.id}/interests/${reply.id}/mark/confirmed` },
      ],
    }).then(async (made) => {
      if (!made.created) return;
      await resolveActionsForSource("lead", `group-interest-${reply.id}`, "done");
      await resolveActionsForSource("lead", `group-call-${reply.id}`, "done");
    }).catch((e: unknown) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "group details: the hold request could not be put on the list"));
    res.json({ success: true });

    // The ONE email, after the answer has gone. The guest's own link is the one they just used.
    const facts = detailsFacts({ group, cabins }, lang);
    void deliver({
      group, reply, template: "hold-confirmation",
      make: () => holdEmail({
        firstName: firstWord(reply.first_name), groupLabel: facts.label, hostNames: facts.hostNames, lang, publicSite: publicSite(),
        category: pick.category, where: pick.where, travelerFirstNames: travelers.map((t) => firstWord(t.legal_name)),
        detailsUrl: makeDetailsUrl(publicSite(), String(req.params["token"]), lang),
      }),
    }).catch((e: unknown) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "group details: the hold confirmation step failed"));
    return;
  } catch (err) {
    return fail(req, res, err, "group details hold failed");
  }
});

export type { DetailsFacts };
export default router;
