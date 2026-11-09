import { Router, type IRouter, type Request, type Response } from "express";
import { pagePhotos } from "../lib/group-page-photos";
import { getSupabase } from "../lib/persistence";
import { logger } from "../lib/logger";
import { clientIp } from "../lib/client-ip";
import { createAction, resolveActionsForSource, retitleActionsForSource } from "../lib/actions";
import { BUSINESS, callKeyMatches, deriveCallKey, hashLinkToken, hubKey, looksLikeLinkToken } from "../lib/group-secure";
import { creditsForPictures, tidyCopy, type Lang } from "../lib/group-marketing";
import { formUrl, issueToken, linkEmail, mailAllowed, packetStatuses } from "../lib/group-forms";
import { DOC_SPECS } from "../lib/group-documents";
import { sendMail } from "../lib/mailer";
import { requireToken } from "../lib/http-auth";
import {
  WHEN_WORD, callBookedEmail, callEmail, callerPhone, detailsFacts, detailsTokenFresh, firstWord, flexpayEmail, pickCabin, reasonsInWords, splitLegalName, storedAddress, storedConcierge,
  storedPick, storedTravelers, validCallWhen, validateConcierge, validateDetails, type DetailsFacts,
} from "../lib/group-details";
import { CALL, callWhenText, freeSlots, isRuleSlot, ruleWindow } from "../lib/flexpay-call";
import { opsBook, opsBusy } from "../lib/ops-schedule";
import { buildQuote, freeCabinFor, insuranceSeedOf, tripOf, quoteOptions, quoteSummary, storedQuote, validateQuoteAnswers, type Quote } from "../lib/group-quote";

// The guest's two roads after "Save my spot!" on a group page (migrations 0056 and 0057; Mark 2026-10-23, reshaped 2026-10-24: "the client should not get 2").
// Public, and the guest's private link is the only credential, exactly like the paperwork link: a random 43-character token whose sha256 alone is stored
// (group_interests.details_token_hash), good for 90 days, one neutral 404 for every kind of wrong link.
//
//   GET  /api/group-details/:token             what we already know (name, contact, how many), what they entered so far
//   POST /api/group-details/:token/choice      Road A, { choice: "call", when } "Walk me through it, Mark!": Mark gets one item to ring, the guest ONE email
//   POST /api/group-details/:token/pick        Road B, { concierge } the four answers; answers with our cabin pick (stored on the reply)
//   POST /api/group-details/:token             Road B, { travelers, address, concierge } the names, birthdays, home address and four answers; answers with our pick
//   POST /api/group-details/:token/hold        Road B, "Build my quote!": the names are in; Mark's item says a quote is under way; the guest gets ONE email
//                                              ("Let's begin!" opens the quote step). Nothing is booked or charged.
//   POST /api/group-details/:token/quote       Road B, { answers } the quote step (Mark 2026-11-01): which cabin, FlexPay yes/no, a drink package when the
//                                              fare has none, insurance, hotel / air / transfers; answers with the quote computed from the group file
//   POST /api/group-details/:token/request     Road B, "Send my choices to Mark!" (Mark 2026-11-05): the figure on the page is the starting price and is not
//                                              agreed to. The travelers go on the file (a free cabin of the chosen category) and Mark's item becomes
//                                              "Re-quote and book": he re-quotes in the cruise line's system, uploads that quote (it fills the booking
//                                              confirmation), checks the paperwork and sends it. The guest commits by signing. First press wins.
//   GET  /api/flexpay-call/:iid/:key           the FlexPay video call (Mark 2026-11-05): the times a guest may pick, Monday to Saturday 10 AM to 8 PM
//                                              Eastern, with every time that touches a meeting on Mark's schedule taken out (lib/flexpay-call.ts,
//                                              lib/ops-schedule.ts); or the time already picked
//   POST /api/flexpay-call/:iid/:key           { start } books it on Mark's calendar with a Google Meet link and emails the guest the time and the link
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

interface Loaded { reply: Row; group: Row; cabins: Row[]; travel: Row[]; lang: Lang }

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
  // the group's own air / hotel / transfer offer (rows with no traveler and no cabin): the quote step's "getting there and back"
  const { data: travel, error: te } = await db().from("group_travel").select("*").eq("group_id", group.id).is("traveler_id", null).is("cabin_id", null).order("created_at", { ascending: true });
  if (te) throw new Error(te.message);
  return { reply, group, cabins: cabins ?? [], travel: travel ?? [], lang: reply.lang === "es" ? "es" : "en" };
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
async function deliver(o: { group: Row; reply: Row; template: "call-confirmation"; make: () => { subject: string; html: string; text: string } }): Promise<void> {
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
    const { reply, group, cabins, travel, lang } = loaded;
    const f = detailsFacts({ group, cabins }, lang);
    // The credit line of the top picture, when the page shows one (a CC BY photo must be credited where it is shown): a failed read costs the line, never the page.
    let credits: string[] = [];
    if (f.heroUrl) {
      const { data: assetRows, error: ae } = await db().from("group_assets").select("public_url, attribution").in("public_url", [f.heroUrl]);
      if (ae) logger.warn({ err: ae.message }, "group details: photo credits lookup failed (the page is served without its credit line)");
      else credits = creditsForPictures([f.heroUrl], (assetRows ?? []) as Row[]);
    }
    const blurb = blurbOf(group, lang);
    // No cabin price is in this answer until the quote step (Mark 2026-10-24: nothing after the group page repeats a price; 2026-11-01: the quote step, which
    // opens once the names are in, shows the fares and the figures from the group file).
    const stored = storedQuote(reply.quote);
    // the guest gets their answers and figures back, never the cabin row it was filed on
    const quote = stored ? (({ cabin_id: _cabin, carrier_intake_id: _read, flexpay_link: _fp, flexpay_call: _call, ...rest }) => rest)(stored as Quote & { carrier_intake_id?: string; flexpay_link?: string; flexpay_call?: unknown }) : null;
    return res.json({
      success: true,
      label: f.label, ship: f.ship, sailDateText: f.sailDateText, returnDateText: f.returnDateText, heroUrl: f.heroUrl, credits,
      // Mark 2026-10-26: the details page opens on its own three photos when the group file names them (otherwise the top picture as before)
      photos: pagePhotos(group.journey, "details"),
      firstName: reply.first_name ?? "", lastName: reply.last_name ?? "", email: reply.email ?? null, phone: reply.phone ?? null, guests: reply.guests ?? null,
      travelers: storedTravelers(reply.travelers) ?? [], address: storedAddress(reply.address), concierge: storedConcierge(reply.concierge), pick: storedPick(reply.pick),
      choice: reply.choice ?? null, callWhen: reply.call_when ?? null, holdRequestedAt: reply.hold_requested_at ?? null,
      quoteOptions: reply.hold_requested_at ? quoteOptions({ group, cabins, travel }, lang) : null, quote, quoteRequestedAt: reply.quote_requested_at ?? null,
      paperwork: reply.quote_requested_at ? (stored?.paperwork ?? null) : null,
      depositPerPersonText: f.depositPerPersonText,
      phoneLine: typeof blurb === "string" && blurb.trim() ? blurb.trim() : null, businessPhone: callerPhone(blurb), lang,
      // Mark 2026-11-08: a FlexPay yes opens OUR scheduler in a pop-up on the quote page (Mark schedules nothing): the way in, and the time once it is set
      flexpayCallUrl: flexpayCallPath(reply, lang), flexpayCall: ((c) => (c ? { start: c.start, whenText: callWhenText(c.start, lang) } : null))(storedCall(reply.quote)),   // the time only, never the video link
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

/** Once the names are in and the quote step has opened, Mark has the list in front of him: a change to a name, a birthday or the address goes through him, not through a form. */
const alreadyHeld = (lang: Lang) => ({
  success: false,
  error: lang === "es" ? `Sus nombres ya están registrados y su cotización está en marcha. Para cambiar algo, llame o escriba a Mark al ${BUSINESS.phone}.` : `Your names are in and your quote is under way. To change anything, call or text Mark at ${BUSINESS.phone}.`,
});
/** Once the choices are with Mark the travelers are on the file and he is re-quoting them with the cruise line: nothing on this page changes any more. */
const alreadyAgreed = (lang: Lang) => ({
  success: false,
  error: lang === "es" ? `Sus decisiones ya están con Mark y sus documentos le llegan por correo. Para cambiar algo, llame o escriba a Mark al ${BUSINESS.phone}.` : `Your choices are with Mark and your paperwork follows by email. To change anything, call or text Mark at ${BUSINESS.phone}.`,
});

// ── Road A: "Walk me through it, Mark!" ──────────────────────────────────────────────────────────────────────────

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
    const { reply, group, cabins, travel, lang } = loaded;
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
    // The answer carries what Part 4 offers, so the page opens the quote step at once (a second press gets the same answer and changes nothing).
    const opened = { success: true, quoteOptions: quoteOptions({ group, cabins, travel }, lang) };
    if (!((won ?? []) as unknown[]).length) return res.json(opened);

    const f = detailsFacts({ group, cabins }, "en");
    const reasons = storedConcierge(reply.concierge);
    // Mark 2026-11-01: nothing is held yet ("i do not have the information needed to reserve the cabin"): the item says a quote is under way, and it becomes
    // "Quote agreed" when the guest agrees. Their earlier item on Mark's list ("Group reply", or "Ring …" if they had asked for a call first) is answered by
    // this one (one person, one item): close it only once the new one exists.
    const title = `Quote under way · ${nameOf(reply)} · our pick ${pick.category} · party of ${travelers.length}`;
    const body = `${f.label} · ${reachOf(reply)} · ${pick.where}${reasons ? ` (${reasonsInWords(reasons)})` : ""}. Names, birthdays and the address are on the reply; they are choosing cabin, FlexPay, insurance, drinks and travel now. Nothing to do yet.`;
    void createAction({
      type: "lead", source_ref: `group-hold-${reply.id}`, title, body, priority: "lead",
      buttons: [
        { label: "Open the group file", href: `/groups/${group.id}#replies` },
      ],
    }).then(async (made) => {
      if (!made.created) return;
      await resolveActionsForSource("lead", `group-interest-${reply.id}`, "done");
      await resolveActionsForSource("lead", `group-call-${reply.id}`, "done");
    }).catch((e: unknown) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "group details: the hold request could not be put on the list"));
    // Mark 2026-11-07: no email here. The page takes the guest straight on to the quote page (their own link opens it again any time): one or the other, never both.
    return res.json(opened);
  } catch (err) {
    return fail(req, res, err, "group details hold failed");
  }
});

// ── The quote step (Mark 2026-11-01) ───────────────────────────────────────────────────────────────────────

router.post("/group-details/:token/quote", async (req: Request, res: Response) => {
  try {
    if (guardPost(req, res)) return;
    const loaded = await load(req.params["token"]);
    if (!loaded) { if (missLimited(clientIp(req))) return res.status(429).json(TOO_MANY); return notFound(res); }
    const { reply, group, cabins, travel } = loaded;
    const lang = askedLang(req, loaded);
    const travelers = storedTravelers(reply.travelers);
    if (!reply.hold_requested_at || !travelers) {
      return res.status(400).json({ success: false, error: lang === "es" ? "Primero termine los nombres, la dirección y las preguntas." : "Please finish the names, the address and the four questions first." });
    }
    if (reply.quote_requested_at) return res.status(409).json(alreadyAgreed(lang));
    const options = quoteOptions({ group, cabins, travel }, lang);
    const v = validateQuoteAnswers(req.body, options, lang);
    if (!v.ok) return res.status(400).json({ success: false, error: v.error, field: v.field });
    const quote: Row = buildQuote({ group, cabins, travel }, travelers, v.answers, lang);
    // Mark 2026-11-08: the time they already picked in the scheduler pop-up stays with the re-priced answers
    const before = (reply.quote ?? null) as Row | null;
    if (before?.["flexpay_call"]) quote["flexpay_call"] = before["flexpay_call"];
    const { error } = await db().from("group_interests").update({ quote, updated_at: new Date().toISOString() }).eq("id", reply.id).is("quote_requested_at", null);
    if (error) throw new Error(error.message);
    const { flexpay_call: _call, ...shown } = quote;   // the call row (with the video link) stays on the reply, never in the answer
    return res.json({ success: true, quote: shown });
  } catch (err) {
    return fail(req, res, err, "group details quote failed");
  }
});

/** The paperwork link to the lead traveler, the moment the quote is agreed ("once … the quote is agreed to then the documentation is sent"). The link is stored first (its hash only); what happened is written on the quote and in the email log, never the link. */
async function sendPaperwork(group: Row, lead: Row): Promise<Quote["paperwork"]> {
  const to = typeof lead["email"] === "string" ? lead["email"].trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return "no-email";
  const { token, hash } = issueToken();
  const { error } = await db().from("group_travelers").update({ form_token_hash: hash, form_sent_at: new Date().toISOString() }).eq("id", lead["id"]);
  if (error) throw new Error(error.message);
  if (!mailAllowed(to, process.env["GROUP_FORMS_MAIL_ALLOW"])) { // the dev box emails only its test addresses
    await db().from("group_messages").insert({ group_id: group.id, cabin_id: lead["cabin_id"] ?? null, traveler_id: lead["id"], audience: "client", template: "paperwork-link", to_email: to, subject: null, status: "skipped", error: "held: this box only emails its test addresses" });
    return "held";
  }
  const label = (detailsFacts({ group, cabins: [] }, lead["lang"] === "es" ? "es" : "en")).label;
  const mail = linkEmail({ firstName: String(lead["first_name"] ?? ""), groupName: label, ship: group.ship_name ?? null, sailDate: group.sail_date ?? null, url: formUrl(publicSite(), token) });
  const ok = await sendMail({ to, subject: mail.subject, html: mail.html, text: mail.text, fromName: BUSINESS.agentName, replyTo: BUSINESS.email });
  const at = new Date().toISOString();
  await db().from("group_messages").insert({
    group_id: group.id, cabin_id: lead["cabin_id"] ?? null, traveler_id: lead["id"], audience: "client", template: "paperwork-link",
    to_email: to, subject: mail.subject, status: ok ? "sent" : "failed", sent_at: ok ? at : null, error: ok ? null : "mail sender refused or was unreachable",
  });
  return ok ? "sent" : "failed";
}

router.post("/group-details/:token/request", async (req: Request, res: Response) => {
  try {
    if (guardPost(req, res)) return;
    const loaded = await load(req.params["token"]);
    if (!loaded) { if (missLimited(clientIp(req))) return res.status(429).json(TOO_MANY); return notFound(res); }
    const { reply, group, cabins, travel } = loaded;
    const lang = askedLang(req, loaded);
    const travelers = storedTravelers(reply.travelers);
    const quote = storedQuote(reply.quote);
    const address = storedAddress(reply.address);
    if (!reply.hold_requested_at || !travelers || !quote || !address) {
      return res.status(400).json({ success: false, error: lang === "es" ? "Primero responda las preguntas de la cotización." : "Please answer the quote questions first." });
    }
    // The first press wins: a double tap or a reload files nobody twice, makes no second item and sends no second paperwork link.
    const now = new Date().toISOString();
    const { data: won, error } = await db().from("group_interests")
      .update({ quote_requested_at: now, updated_at: now }).eq("id", reply.id).is("quote_requested_at", null).select("id");
    if (error) throw new Error(error.message);
    if (!((won ?? []) as unknown[]).length) return res.json({ success: true, paperwork: quote.paperwork ?? null, already: true });

    // The travelers go on the file, on the first free cabin of the category they chose (Mark gives the cabin number with the cruise line); with none free, with no cabin, for Mark to place.
    const options = quoteOptions({ group, cabins, travel }, lang);
    const chosen = options.cabins.find((c) => c.key === quote.cabinKey) ?? null;
    const { data: onCabins, error: oe } = await db().from("group_travelers").select("cabin_id").eq("group_id", group.id);
    if (oe) throw new Error(oe.message);
    const used = new Set(((onCabins ?? []) as Row[]).map((t) => String(t["cabin_id"] ?? "")).filter(Boolean));
    const cabin = chosen ? freeCabinFor(cabins, chosen, used) : null;
    let leadRow: Row | null = null;
    if (!reply.traveler_id) {
      // Mark 2026-11-06: the insurance answer on the quote goes on every traveler's file, so the paperwork opens with it chosen
      const insurance = insuranceSeedOf(options, quote.answers, group.line_protection);
      const rows = travelers.map((p, i) => {
        const { first, last } = splitLegalName(p.legal_name);
        return {
          group_id: group.id, cabin_id: cabin ? cabin["id"] : null, is_lead: i === 0, first_name: first, last_name: last, dob: p.dob, lang,
          // form_data is NOT NULL and a bulk insert sends NULL (not the column default) for a key a row leaves out, so every traveler names it.
          form_data: {
            ...(i === 0 ? { address: address.street, city_state_zip: `${address.city}, ${address.state} ${address.zip}`, trip: tripOf(travel as Array<Record<string, unknown>>, quote.answers) } : {}),
            ...(insurance ? { insurance } : {}),
          },
          ...(i === 0 ? { email: reply.email ?? null, phone: reply.phone ?? null } : {}),
        };
      });
      const { data: made, error: me } = await db().from("group_travelers").insert(rows).select("id, cabin_id, email, first_name, lang");
      if (me) {
        // Nobody was filed, so the agreement must not stay stamped: a retry would read "already agreed" and file no one.
        await db().from("group_interests").update({ quote_requested_at: null, updated_at: new Date().toISOString() }).eq("id", reply.id);
        throw new Error(me.message);
      }
      leadRow = ((made ?? []) as Row[])[0] ?? null;
      if (leadRow) {
        const { error: ue } = await db().from("group_interests").update({ traveler_id: leadRow["id"], status: reply.status === "new" ? "contacted" : reply.status, updated_at: now }).eq("id", reply.id);
        if (ue) logger.warn({ err: ue.message }, "group details: the reply could not be marked as filed (the travelers are in the file)");
      }
    } else {
      const { data: lead, error: le } = await db().from("group_travelers").select("id, cabin_id, email, first_name, lang").eq("id", reply.traveler_id).maybeSingle();
      if (le) throw new Error(le.message);
      leadRow = lead ?? null;
    }

    // Mark 2026-11-03: "there is an intermediary step before signing documents and after filling in the info: I need to book and get the
    // room number, and validate the flights, hotels and any transfers." The paperwork link waits for "Booked" on Mark's list.
    const paperwork: Quote["paperwork"] = "booking";
    const agreed: Quote = { ...quote, paperwork, cabin_id: cabin ? String(cabin["id"]) : null };
    const { error: qe } = await db().from("group_interests").update({ quote: agreed, updated_at: new Date().toISOString() }).eq("id", reply.id);
    if (qe) logger.warn({ err: qe.message }, "group details: the agreed quote could not be saved with its paperwork status");
    res.json({ success: true, paperwork });

    // Mark's item: one person, one item. "Quote under way" (or the reply / the call) is closed once this one exists.
    const f = detailsFacts({ group, cabins }, "en");
    const where = cabin ? (cabin["cabin_num"] ? `cabin ${cabin["cabin_num"]}` : `a ${quote.category} cabin on the file`) : `NO free ${quote.category} cabin: place them`;
    const title = `Re-quote and book · ${nameOf(reply)} · ${quote.category} · party of ${travelers.length}`;
    const toCheck = agreed.lines.filter((l) => l.key.startsWith("travel-") || l.key.startsWith("need-")).map((l) => l.label);
    const body = `${f.label} · ${reachOf(reply)} · ${quoteSummary(agreed, quoteOptions({ group, cabins, travel }, "en"))}. Travelers are on the file (${where}). `
      + `The price the guest saw is the starting price: nothing is agreed and the paperwork link is NOT sent yet. Do this: (1) re-quote these choices in the cruise line's system; `
      + `(2) upload that quote in the group file: it fills the booking confirmation; (3) validate ${toCheck.length ? toCheck.join("; ") : "the flights, hotel and transfers, if they asked for any"} and enter the suppliers' confirmations; `
      + `(4) check what the paperwork will say and send it. The guest signs it and it comes back to you; then confirm the booking with the cruise line and the vendors${agreed.answers.flexpay ? ", and send the FlexPay appointment link" : ""}.`;
    void createAction({
      type: "lead", source_ref: `group-quote-${reply.id}`, title, body, priority: "lead",
      buttons: [
        { label: "Upload the cruise line's quote", href: `/groups/${group.id}?book=${reply.id}#booking` },
        { label: "Send the paperwork (needs the confirmation)", method: "POST", path: `/api/groups/${group.id}/interests/${reply.id}/booked` },
      ],
    }).then(async (made) => {
      if (!made.created) return;
      await resolveActionsForSource("lead", `group-hold-${reply.id}`, "done");
      await resolveActionsForSource("lead", `group-interest-${reply.id}`, "done");
      await resolveActionsForSource("lead", `group-call-${reply.id}`, "done");
    }).catch((e: unknown) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "group details: the agreed quote could not be put on the list"));
    return;
  } catch (err) {
    return fail(req, res, err, "group details agree failed");
  }
});

// ── The booking confirmation (Mark 2026-11-04) ─────────────────────────────────────────────────────────────────────────────
// The guest's choices are in. Mark re-quotes them in the cruise line's system and uploads that quote: it fills this form (Mark 2026-11-05). He checks
// it, adds the suppliers' confirmations and any change, sees what the paperwork will now say, and sends it. Signed and back, he closes the booking. The cabin lives on group_cabins (booking number, cabin number, deck, prices);
// the flights, hotels and transfers on the lead's file (form_data.trip.chosen), which the Cruise Booking Agreement already prints.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRIP_KINDS = ["flight", "hotel", "transfer"] as const;
const text = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const money = (v: unknown): number | null | undefined => {
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n < 1e7 ? Math.round(n * 100) / 100 : undefined;
};
const isoOrNull = (v: unknown): string | null => { const t = text(v, 40); return t && !Number.isNaN(Date.parse(t)) ? t : null; };

interface TripEntry { kind: string; direction: string | null; provider: string | null; from_place: string | null; to_place: string | null; starts_at: string | null; ends_at: string | null; label: string; confirmation: string | null }
const tripEntries = (formData: unknown): TripEntry[] => {
  const t = formData && typeof formData === "object" ? (formData as Record<string, unknown>)["trip"] : null;
  const list = t && typeof t === "object" ? (t as Record<string, unknown>)["chosen"] : null;
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is Record<string, unknown> => !!r && typeof r === "object").map((r) => ({
    kind: String(r["kind"] ?? ""), direction: text(r["direction"], 10), provider: text(r["provider"]), from_place: text(r["from_place"]), to_place: text(r["to_place"]),
    starts_at: text(r["starts_at"], 40), ends_at: text(r["ends_at"], 40), label: text(r["label"]) ?? String(r["kind"] ?? ""), confirmation: text(r["confirmation"]),
  }));
};

async function loadBooking(groupId: string, iid: string) {
  const { data: reply, error } = await db().from("group_interests").select("id, status, traveler_id, quote, quote_requested_at, booking_completed_at, first_name, last_name, email").eq("id", iid).eq("group_id", groupId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!reply || !reply.quote_requested_at || !reply.traveler_id) return null;
  const { data: lead, error: le } = await db().from("group_travelers").select("id, cabin_id, email, first_name, last_name, lang, form_data").eq("id", reply.traveler_id).maybeSingle();
  if (le) throw new Error(le.message);
  if (!lead) return null;
  const { data: cabin, error: ce } = lead.cabin_id ? await db().from("group_cabins").select("id, cabin_num, deck, category, status, booking_number, price_total, deposit_amount").eq("id", lead.cabin_id).maybeSingle() : { data: null, error: null };
  if (ce) throw new Error(ce.message);
  const quote = storedQuote(reply.quote);
  // the cruise line's quote Mark uploaded for this guest, as the reader left it
  const readId = text((reply.quote as Record<string, unknown> | null)?.["carrier_intake_id"], 60);
  const { data: carrier, error: ie } = readId ? await db().from("group_intakes").select("id, filename, status, error, extracted").eq("id", readId).maybeSingle() : { data: null, error: null };
  if (ie) throw new Error(ie.message);
  // once the paperwork is out: what this party has signed
  let signed: SignedView | null = null;
  if (quote?.paperwork && quote.paperwork !== "booking") signed = await signedFor(groupId, lead);
  return { reply, lead, cabin, quote, carrier: (carrier ?? null) as Row | null, signed };
}

interface SignedView { required: number; signed: number; complete: boolean; docs: Array<{ id: string; title: string; signer: string | null; has_pdf: boolean }> }
/** The documents the guest's party must sign and the ones that are back: the lead and everyone on the lead's cabin. */
async function signedFor(groupId: string, lead: Row): Promise<SignedView> {
  const [g, c, t, sg] = await Promise.all([
    db().from("groups").select("*").eq("id", groupId).maybeSingle(),
    db().from("group_cabins").select("*").eq("group_id", groupId),
    db().from("group_travelers").select("*").eq("group_id", groupId),
    db().from("group_signatures").select("id, traveler_id, doc_key, signer_role, signer_name, signed_at, pdf_path").eq("group_id", groupId),
  ]);
  for (const r of [g, c, t, sg]) if (r.error) throw new Error(r.error.message);
  const party = ((t.data ?? []) as Row[]).filter((x) => x["id"] === lead["id"] || (lead["cabin_id"] && x["cabin_id"] === lead["cabin_id"]));
  const ids = new Set(party.map((x) => String(x["id"])));
  const signatures = ((sg.data ?? []) as Row[]).filter((x) => ids.has(String(x["traveler_id"] ?? "")));
  const status = packetStatuses({ group: (g.data ?? {}) as Row, cabins: (c.data ?? []) as Row[], travelers: party, signatures }).travelers;
  const each = Object.values(status);
  return {
    required: each.reduce((n, x) => n + x.required.length, 0), signed: each.reduce((n, x) => n + x.signed.length, 0),
    complete: each.length > 0 && each.every((x) => x.complete),
    docs: signatures.map((x) => ({ id: String(x["id"]), title: DOC_SPECS[String(x["doc_key"])]?.title ?? String(x["doc_key"]), signer: text(x["signer_name"]), has_pdf: !!x["pdf_path"] })),
  };
}

/** What the reader found on the cruise line's quote, in the booking confirmation's own fields. Mark checks every line before he saves it. */
function carrierView(intake: Row | null) {
  if (!intake) return null;
  // the read is stored already normalized (routes/group-intake.ts); it is taken as stored, so this file stays clear of the reader and its model clients
  const x = intake["extracted"] && typeof intake["extracted"] === "object" ? (intake["extracted"] as Record<string, any>) : null;
  const first = x && Array.isArray(x["cabin_categories"]) && x["cabin_categories"][0] && typeof x["cabin_categories"][0] === "object" ? (x["cabin_categories"][0] as Record<string, unknown>) : {};
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const twice = (v: unknown): number | null => (num(v) === null ? null : Math.round(num(v)! * 2 * 100) / 100);   // a quote prints per person; a cabin is sold for two
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s.trim()) : []);
  return {
    id: String(intake["id"]), filename: text(intake["filename"]) ?? "quote.pdf", status: String(intake["status"] ?? "queued"), error: text(intake["error"], 400),
    read: x ? {
      booking_number: text(x["booking_number"], 60), cabin_num: text(x["cabin_number"], 60), category: text(first["category"]),
      price_total: num(x["total_price"]) ?? twice(first["price_per_person"]),
      deposit_amount: twice(first["deposit_per_person"] ?? x["deposit_per_person"]),
      addons: (Array.isArray(x["addons"]) ? x["addons"] : []).filter((a: unknown): a is Record<string, unknown> => !!a && typeof a === "object")
        .map((a: Record<string, unknown>) => ({ name: text(a["name"]) ?? "Add-on", total: num(a["total"]) ?? 0, includes: list(a["includes"]) })),
      inclusions: list(x["guest_inclusions"]), warnings: list(x["warnings"]),
    } : null,
  };
}

type BookingFile = NonNullable<Awaited<ReturnType<typeof loadBooking>>>;
function bookingView(b: BookingFile) {
  const chosen = tripEntries(b.lead.form_data);
  const needs = ((b.lead.form_data as Record<string, any> | null)?.["trip"]?.["needs"] ?? {}) as Record<string, boolean>;
  const missing: string[] = [];
  // Mark 2026-11-07: the booking number and the cabin number are not needed before the paperwork goes out (he enters them when the
  // line gives them); the cabin itself and the travel the guest asked for are.
  if (!b.cabin) missing.push("The cabin this guest is on is not on the group file");
  for (const r of chosen) if (!r.confirmation) missing.push(`Confirmation for ${r.label}`);
  for (const k of TRIP_KINDS) if (needs[k] === true && !chosen.some((r) => r.kind === k)) missing.push(`The ${k} the guest asked you to quote: add it below`);
  const fills = [
    { label: "Cruise line booking number", value: text(b.cabin?.["booking_number"]) ?? "" },
    { label: "Cabin number", value: text(b.cabin?.["cabin_num"]) ?? "" },
    { label: "Deck", value: text(b.cabin?.["deck"]) ?? "" },
    ...chosen.map((r) => ({ label: r.label, value: [r.provider, [r.from_place, r.to_place].filter(Boolean).join(" to "), r.confirmation ? `conf. ${r.confirmation}` : ""].filter(Boolean).join(" · ") })),
  ];
  return {
    success: true,
    guest: { name: [b.lead.first_name, b.lead.last_name].filter(Boolean).join(" ") || nameOf(b.reply) || "Guest", email: b.lead.email ?? b.reply.email ?? null },
    quote: b.quote ? { category: b.quote.category, party: b.quote.party, total: b.quote.totalText, deposit: b.quote.depositText } : null,
    paperwork: b.quote?.paperwork ?? "booking",
    cabin: b.cabin, trip: chosen, needs, missing, ready: missing.length === 0, fills,
    carrier: carrierView(b.carrier), signed: b.signed, completedAt: b.reply.booking_completed_at ?? null,
    // after the signatures: who Mark confirms the booking with, and FlexPay's appointment link when the guest asked for FlexPay
    confirmWith: ["The cruise line", ...chosen.map((r) => [r.label, r.provider].filter(Boolean).join(" · "))],
    flexpay: b.quote?.answers?.flexpay === true ? { link: text((b.reply.quote as Record<string, unknown> | null)?.["flexpay_link"], 20), call: callView(storedCall(b.reply.quote), "en") } : null,
  };
}

/** The guests whose choices are in, for the group manager's "Booking confirmations" card: the ones still waiting on Mark first. */
router.get("/groups/:id/bookings", requireToken, async (req: Request, res: Response) => {
  try {
    const groupId = String(req.params["id"]);
    if (!UUID_RE.test(groupId)) return res.status(404).json({ success: false, error: "Group not found" });
    const { data, error } = await db().from("group_interests").select("id, first_name, last_name, quote, quote_requested_at, booking_completed_at").eq("group_id", groupId).not("quote_requested_at", "is", null).order("quote_requested_at", { ascending: true });
    if (error) throw new Error(error.message);
    const rows = (data ?? []).map((r: Row) => {
      const q = storedQuote(r["quote"]);
      return { id: String(r["id"]), name: nameOf(r) || "Guest", category: q?.category ?? null, party: q?.party ?? null, paperwork: q?.paperwork ?? "booking", requested_at: r["quote_requested_at"], completed_at: r["booking_completed_at"] ?? null };
    });
    rows.sort((a: { paperwork: string }, b: { paperwork: string }) => Number(b.paperwork === "booking") - Number(a.paperwork === "booking"));
    return res.json({ success: true, bookings: rows });
  } catch (err) {
    return fail(req, res, err, "group bookings list failed");
  }
});

router.get("/groups/:id/interests/:iid/booking", requireToken, async (req: Request, res: Response) => {
  try {
    const groupId = String(req.params["id"]), iid = String(req.params["iid"]);
    if (!UUID_RE.test(groupId) || !UUID_RE.test(iid)) return res.status(404).json({ success: false, error: "Reply not found" });
    const b = await loadBooking(groupId, iid);
    if (!b) return res.status(404).json({ success: false, error: "That guest has not sent their choices yet." });
    return res.json(bookingView(b));
  } catch (err) {
    return fail(req, res, err, "group booking read failed");
  }
});

router.put("/groups/:id/interests/:iid/booking", requireToken, async (req: Request, res: Response) => {
  try {
    const groupId = String(req.params["id"]), iid = String(req.params["iid"]);
    if (!UUID_RE.test(groupId) || !UUID_RE.test(iid)) return res.status(404).json({ success: false, error: "Reply not found" });
    const b = await loadBooking(groupId, iid);
    if (!b) return res.status(404).json({ success: false, error: "That guest has not sent their choices yet." });
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, any>;
    const bad = (error: string) => res.status(400).json({ success: false, error });
    if (body["cabin"] !== undefined) {
      if (!b.cabin) return bad("This guest is not on a cabin in the group file yet.");
      const c = (body["cabin"] && typeof body["cabin"] === "object" ? body["cabin"] : {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const k of ["cabin_num", "deck", "category", "booking_number"] as const) if (c[k] !== undefined) patch[k] = text(c[k], 60);
      for (const k of ["price_total", "deposit_amount"] as const) if (c[k] !== undefined) { const m = money(c[k]); if (m === undefined) return bad(`${k === "price_total" ? "The cabin total" : "The deposit"} is not an amount.`); patch[k] = m; }
      const num = "cabin_num" in patch ? patch["cabin_num"] : b.cabin["cabin_num"], bk = "booking_number" in patch ? patch["booking_number"] : b.cabin["booking_number"];
      if (text(num) && text(bk)) patch["status"] = "booked";
      if (Object.keys(patch).length) {
        const { error } = await db().from("group_cabins").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", b.cabin["id"]);
        if (error) throw new Error(error.message);
      }
    }
    if (body["trip"] !== undefined) {
      if (!Array.isArray(body["trip"]) || body["trip"].length > 20) return bad("The travel list is not valid.");
      const chosen: TripEntry[] = [];
      for (const r of body["trip"] as Array<Record<string, unknown>>) {
        const kind = String(r?.["kind"] ?? "");
        if (!(TRIP_KINDS as readonly string[]).includes(kind)) return bad("Each travel line must be a flight, hotel or transfer.");
        const dir = r["direction"] === "post" ? "post" : "pre";
        chosen.push({
          kind, direction: dir, provider: text(r["provider"]), from_place: text(r["from_place"]), to_place: text(r["to_place"]),
          starts_at: isoOrNull(r["starts_at"]), ends_at: isoOrNull(r["ends_at"]), confirmation: text(r["confirmation"]),
          label: text(r["label"]) ?? `${dir === "post" ? "After" : "Before"} the cruise: ${kind}`,
        });
      }
      const fd = (b.lead.form_data && typeof b.lead.form_data === "object" ? b.lead.form_data : {}) as Record<string, any>;
      const { error } = await db().from("group_travelers").update({ form_data: { ...fd, trip: { ...(fd["trip"] ?? {}), chosen } } }).eq("id", b.lead.id);
      if (error) throw new Error(error.message);
    }
    const again = await loadBooking(groupId, iid);
    return res.json(bookingView(again ?? b));
  } catch (err) {
    return fail(req, res, err, "group booking save failed");
  }
});

/** Mark's "Booked" (2026-11-03): the cabin is booked with the cruise line and its number is on the file; the travel is validated. Only then does the
 *  guest's paperwork link go out. Refused until the cabin number is in the group file. Pressed twice, it sends nothing twice. */
router.post("/groups/:id/interests/:iid/booked", requireToken, async (req: Request, res: Response) => {
  try {
    const groupId = String(req.params["id"]), iid = String(req.params["iid"]);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID.test(groupId) || !UUID.test(iid)) return res.status(404).json({ success: false, error: "Reply not found" });
    const { data: reply, error } = await db().from("group_interests").select("id, status, traveler_id, quote, quote_requested_at").eq("id", iid).eq("group_id", groupId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!reply || !reply.quote_requested_at || !reply.traveler_id) return res.status(404).json({ success: false, error: "That guest has not sent their choices yet." });
    const quote = storedQuote(reply.quote);
    if (quote && quote.paperwork && quote.paperwork !== "booking") return res.json({ success: true, paperwork: quote.paperwork, already: true });
    const { data: lead, error: le } = await db().from("group_travelers").select("id, cabin_id, email, first_name, lang").eq("id", reply.traveler_id).maybeSingle();
    if (le) throw new Error(le.message);
    if (!lead) return res.status(404).json({ success: false, error: "The lead traveler is not on the file." });
    const booking = await loadBooking(groupId, iid);
    const view = booking ? bookingView(booking) : null;
    if (!view || !view.ready) return res.status(409).json({ success: false, error: `Finish the booking confirmation first: ${(view?.missing ?? ["the cabin"]).join("; ")}.`, missing: view?.missing ?? [] });
    const { data: group, error: ge } = await db().from("groups").select("*").eq("id", groupId).maybeSingle();
    if (ge) throw new Error(ge.message);
    if (!group) return res.status(404).json({ success: false, error: "Group not found" });
    let paperwork: Quote["paperwork"];
    try { paperwork = await sendPaperwork(group, lead); }
    catch (e) { logger.warn({ err: e instanceof Error ? e.message : String(e) }, "group details: the paperwork link could not be sent after Booked"); paperwork = "failed"; }
    await db().from("group_interests").update({ quote: { ...(quote ?? {}), paperwork }, status: "booked", updated_at: new Date().toISOString() }).eq("id", iid);
    await resolveActionsForSource("lead", `group-quote-${iid}`, "done");
    return res.json({ success: true, paperwork });
  } catch (err) {
    return fail(req, res, err, "group booked failed");
  }
});

/** Mark 2026-11-05: "the client confirms and it comes back to me. I upload to my system in a secured DB to hold the personal information. I then confirm
 *  the booking with the cruise line and any other vendors agreed to." The signed copies are stored by the signing itself (private bucket; passport data
 *  encrypted). This is his "confirmed with the cruise line and the vendors": refused until the paperwork is out and every document this party owes is
 *  signed. Pressed twice, the first moment stays. */
router.post("/groups/:id/interests/:iid/complete", requireToken, async (req: Request, res: Response) => {
  try {
    const groupId = String(req.params["id"]), iid = String(req.params["iid"]);
    if (!UUID_RE.test(groupId) || !UUID_RE.test(iid)) return res.status(404).json({ success: false, error: "Reply not found" });
    const b = await loadBooking(groupId, iid);
    if (!b) return res.status(404).json({ success: false, error: "That guest has not sent their choices yet." });
    if (b.reply.booking_completed_at) return res.json({ success: true, completedAt: b.reply.booking_completed_at, already: true });
    if (!b.signed) return res.status(409).json({ success: false, error: "The paperwork has not gone to this guest yet." });
    if (!b.signed.complete) return res.status(409).json({ success: false, error: `Not every document is signed yet: ${b.signed.signed} of ${b.signed.required} are back.` });
    const now = new Date().toISOString();
    const { error } = await db().from("group_interests").update({ booking_completed_at: now, updated_at: now }).eq("id", iid).is("booking_completed_at", null);
    if (error) throw new Error(error.message);
    return res.json({ success: true, completedAt: now });
  } catch (err) {
    return fail(req, res, err, "group booking complete failed");
  }
});

/** Mark 2026-11-05: "If they choose flexpay we send the link to schedule an appointment to complete flexpay's application." Only for a guest who asked
 *  for FlexPay, and only once the booking is confirmed. The link is our own scheduler page (public/flexpay-call.html), never an outside scheduling
 *  service (Mark 2026-11-05: "I'm not paying for another service"). Sent again, it emails again (the same link: it is derived, not stored). */
router.post("/groups/:id/interests/:iid/flexpay-link", requireToken, async (req: Request, res: Response) => {
  try {
    const groupId = String(req.params["id"]), iid = String(req.params["iid"]);
    if (!UUID_RE.test(groupId) || !UUID_RE.test(iid)) return res.status(404).json({ success: false, error: "Reply not found" });
    const b = await loadBooking(groupId, iid);
    if (!b) return res.status(404).json({ success: false, error: "That guest has not sent their choices yet." });
    if (b.quote?.answers?.flexpay !== true) return res.status(409).json({ success: false, error: "This guest did not ask for FlexPay." });
    if (!b.reply.booking_completed_at) return res.status(409).json({ success: false, error: "Confirm the booking with the cruise line and the vendors first." });
    const linkKey = hubKey();
    if (!linkKey) return res.status(409).json({ success: false, error: "The link key is not set on this box (GROUP_PII_KEY), so there is no link to send." });
    const to = (b.lead.email ?? b.reply.email ?? "").trim();
    const { data: group, error: ge } = await db().from("groups").select("*").eq("id", groupId).maybeSingle();
    if (ge) throw new Error(ge.message);
    if (!group) return res.status(404).json({ success: false, error: "Group not found" });
    const lang: Lang = b.lead.lang === "es" ? "es" : "en";
    const facts = detailsFacts({ group, cabins: [] }, lang);
    const appointmentUrl = `${publicSite()}${lang === "es" ? "/es" : ""}/flexpay-call.html?r=${iid}&k=${deriveCallKey(iid, linkKey)}`;
    let link: "sent" | "held" | "no-email" | "failed";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) link = "no-email";
    else if (!mailAllowed(to, process.env["GROUP_FORMS_MAIL_ALLOW"])) { // the dev box emails only its test addresses
      await db().from("group_messages").insert({ group_id: groupId, traveler_id: b.lead.id, audience: "client", template: "flexpay-appointment", to_email: to, subject: null, status: "skipped", error: "held: this box only emails its test addresses" });
      link = "held";
    } else {
      const mail = flexpayEmail({ firstName: firstWord(b.lead.first_name), groupLabel: facts.label, hostNames: facts.hostNames, lang, publicSite: publicSite(), appointmentUrl });
      const ok = await sendMail({ to, subject: mail.subject, html: mail.html, text: mail.text, fromName: BUSINESS.agentName, replyTo: BUSINESS.email });
      const at = new Date().toISOString();
      await db().from("group_messages").insert({ group_id: groupId, traveler_id: b.lead.id, audience: "client", template: "flexpay-appointment", to_email: to, subject: mail.subject, status: ok ? "sent" : "failed", sent_at: ok ? at : null, error: ok ? null : "mail sender refused or was unreachable" });
      link = ok ? "sent" : "failed";
    }
    const { error } = await db().from("group_interests").update({ quote: { ...((b.reply.quote ?? {}) as Row), flexpay_link: link }, updated_at: new Date().toISOString() }).eq("id", iid);
    if (error) throw new Error(error.message);
    return res.json({ success: true, link });
  } catch (err) {
    return fail(req, res, err, "group flexpay link failed");
  }
});

// ── FlexPay: the guest picks the time of the video call (Mark 2026-11-05) ─────────────────────────────────────────
// "it should bring up a scheduler for a video conference. M-S 10-8 and doesn't conflict with any meetings on my schedule already". The page is ours
// (public/flexpay-call.html); its address carries the reply's id and a key derived from it. Mark 2026-11-08: the quote page opens it in a pop-up the
// moment the guest says yes to FlexPay (Mark schedules nothing); Mark's "send the FlexPay link" email carries the same address for a guest who closed it.
// One appointment per guest: once a time is picked, a change goes through Mark (he moves it on his calendar).

interface StoredCall { start: string; minutes: number; meet_link: string | null; event_id: string | null; booked_at: string | null }
function storedCall(quote: unknown): StoredCall | null {
  const c = (quote as Row | null)?.["flexpay_call"] as Row | undefined;
  if (!c || typeof c["start"] !== "string" || !Number.isFinite(Date.parse(c["start"]))) return null;
  return {
    start: new Date(c["start"]).toISOString(), minutes: Number(c["minutes"]) || CALL.minutes,
    meet_link: typeof c["meet_link"] === "string" ? c["meet_link"] : null, event_id: typeof c["event_id"] === "string" ? c["event_id"] : null,
    booked_at: typeof c["booked_at"] === "string" ? c["booked_at"] : null,
  };
}
const callView = (c: StoredCall | null, lang: Lang) => (c ? { start: c.start, minutes: c.minutes, whenText: callWhenText(c.start, lang), meetLink: c.meet_link } : null);

/** The way into the scheduler for a reply whose names are in (Mark 2026-11-08: the quote page opens it in a pop-up on a FlexPay yes); null before that, and on a box with no link key. */
function flexpayCallPath(reply: Row, lang: Lang): string | null {
  const linkKey = hubKey();
  if (!reply.hold_requested_at || !linkKey) return null;
  return `${lang === "es" ? "/es" : ""}/flexpay-call.html?r=${reply.id}&k=${deriveCallKey(reply.id, linkKey)}`;
}

/** The reply an appointment link opens: null for a wrong key, an unknown reply, and a reply whose names are not in yet (the quote step, where the pop-up lives, is not open).
 *  Mark 2026-11-08: the pop-up opens the moment the guest says yes to FlexPay, so neither a stored yes nor Mark's email is waited for. */
async function loadCall(iid: unknown, key: unknown): Promise<{ reply: Row; group: Row; lang: Lang; call: StoredCall | null } | null> {
  if (typeof iid !== "string" || !UUID_RE.test(iid) || !callKeyMatches(iid, key, hubKey())) return null;
  const { data: reply, error } = await db().from("group_interests").select("*").eq("id", iid).maybeSingle();
  if (error) throw new Error(error.message);
  const quote = (reply?.quote ?? null) as Row | null;
  if (!reply || reply.status === "spam" || !reply.hold_requested_at) return null;
  const { data: group, error: ge } = await db().from("groups").select("*").eq("id", reply.group_id).maybeSingle();
  if (ge) throw new Error(ge.message);
  if (!group) return null;
  return { reply, group, lang: reply.lang === "es" ? "es" : "en", call: storedCall(quote) };
}

const calendarQuiet = (lang: Lang) => ({
  success: false,
  error: lang === "es" ? `El calendario no responde en este momento. Intente de nuevo en unos minutos, o llame o escriba a Mark al ${BUSINESS.phone}.` : `The calendar is not answering right now. Please try again in a few minutes, or call or text Mark at ${BUSINESS.phone}.`,
});

router.get("/flexpay-call/:iid/:key", async (req: Request, res: Response) => {
  try {
    privateHeaders(res);
    const loaded = await loadCall(req.params["iid"], req.params["key"]);
    if (!loaded) {
      if (missLimited(clientIp(req))) return res.status(429).json(TOO_MANY);
      return notFound(res);
    }
    const { reply, group, lang, call } = loaded;
    const facts = detailsFacts({ group, cabins: [] }, lang);
    const base = { success: true, firstName: reply.first_name ?? "", label: facts.label, lang, tz: CALL.tz, minutes: CALL.minutes, businessPhone: BUSINESS.phone };
    if (call) return res.json({ ...base, booked: callView(call, lang), days: [] });
    const now = new Date(), window = ruleWindow(now);
    const busy = await opsBusy(window.start, window.end);
    if (!busy) return res.status(503).json(calendarQuiet(lang));
    return res.json({ ...base, booked: null, days: freeSlots(now, busy) });
  } catch (err) {
    return fail(req, res, err, "flexpay call read failed");
  }
});

router.post("/flexpay-call/:iid/:key", async (req: Request, res: Response) => {
  try {
    if (guardPost(req, res)) return;
    const loaded = await loadCall(req.params["iid"], req.params["key"]);
    if (!loaded) {
      if (missLimited(clientIp(req))) return res.status(429).json(TOO_MANY);
      return notFound(res);
    }
    const { reply, group, lang, call } = loaded;
    if (call) {
      return res.status(409).json({
        success: false, booked: callView(call, lang),
        error: lang === "es" ? `Su hora ya está apartada. Para cambiarla, llame o escriba a Mark al ${BUSINESS.phone}.` : `Your time is already set. To change it, call or text Mark at ${BUSINESS.phone}.`,
      });
    }
    const now = new Date(), start = (req.body as Row | undefined)?.["start"];
    if (!isRuleSlot(start, now)) return res.status(400).json({ success: false, field: "start", error: lang === "es" ? "Elija una de las horas que se muestran." : "Pick one of the times shown." });
    const iso = new Date(start).toISOString();
    const facts = detailsFacts({ group, cabins: [] }, lang);
    const booked = await opsBook({
      start: iso, minutes: CALL.minutes, title: `FlexPay application: ${nameOf(reply) || "guest"} (${facts.label})`,
      description: [`Video call to complete the FlexPay application. Picked by the guest on the site.`, `Guest: ${nameOf(reply)}`, `Reach: ${[reply.phone, reply.email].filter(Boolean).join(" · ") || "no contact given"}`, `Group: ${group.name ?? facts.label}`, lang === "es" ? "Language: Spanish" : "Language: English"].join("\n"),
      requestId: `fp-${reply.id}-${Math.floor(Date.parse(iso) / 60_000)}`,
    });
    if (!booked.ok && booked.reason === "taken") {
      const window = ruleWindow(now), busy = await opsBusy(window.start, window.end);
      return res.status(409).json({ success: false, field: "start", days: busy ? freeSlots(now, busy) : [], error: lang === "es" ? "Esa hora se acaba de ocupar. Estas son las que siguen libres." : "That time was just taken. These are the ones still open." });
    }
    if (!booked.ok) return res.status(503).json(calendarQuiet(lang));
    const saved: StoredCall = { start: iso, minutes: CALL.minutes, meet_link: booked.meetLink, event_id: booked.eventId, booked_at: now.toISOString() };
    const { error } = await db().from("group_interests").update({ quote: { ...((reply.quote ?? {}) as Row), flexpay_call: saved }, updated_at: now.toISOString() }).eq("id", reply.id);
    if (error) throw new Error(error.message);

    // the one email that confirms the time, with the video link (the dev box emails only its test addresses)
    const to = typeof reply.email === "string" ? reply.email.trim() : "";
    let email: "sent" | "held" | "no-email" | "failed";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) email = "no-email";
    else if (!mailAllowed(to, process.env["GROUP_FORMS_MAIL_ALLOW"])) {
      await db().from("group_messages").insert({ group_id: group.id, audience: "client", template: "flexpay-call-booked", to_email: to, subject: null, status: "skipped", error: "held: this box only emails its test addresses" });
      email = "held";
    } else {
      const mail = callBookedEmail({ firstName: firstWord(reply.first_name), groupLabel: facts.label, hostNames: facts.hostNames, lang, publicSite: publicSite(), whenText: callWhenText(iso, lang), meetLink: booked.meetLink });
      const ok = await sendMail({ to, subject: mail.subject, html: mail.html, text: mail.text, fromName: BUSINESS.agentName, replyTo: BUSINESS.email });
      await db().from("group_messages").insert({ group_id: group.id, audience: "client", template: "flexpay-call-booked", to_email: to, subject: mail.subject, status: ok ? "sent" : "failed", sent_at: ok ? now.toISOString() : null, error: ok ? null : "mail sender refused or was unreachable" });
      email = ok ? "sent" : "failed";
    }
    return res.json({ success: true, booked: callView(saved, lang), email });
  } catch (err) {
    return fail(req, res, err, "flexpay call booking failed");
  }
});


export type { DetailsFacts };
export default router;
