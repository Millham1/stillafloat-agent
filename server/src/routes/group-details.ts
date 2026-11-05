import { Router, type IRouter, type Request, type Response } from "express";
import { pagePhotos } from "../lib/group-page-photos";
import { getSupabase } from "../lib/persistence";
import { logger } from "../lib/logger";
import { clientIp } from "../lib/client-ip";
import { createAction, resolveActionsForSource, retitleActionsForSource } from "../lib/actions";
import { BUSINESS, deriveQuoteToken, hashLinkToken, hubKey, looksLikeLinkToken } from "../lib/group-secure";
import { creditsForPictures, tidyCopy, type Lang } from "../lib/group-marketing";
import { formUrl, issueToken, linkEmail, mailAllowed } from "../lib/group-forms";
import { sendMail } from "../lib/mailer";
import { requireToken } from "../lib/http-auth";
import {
  WHEN_WORD, callEmail, callerPhone, detailsFacts, detailsTokenFresh, detailsUrl as makeDetailsUrl, finalQuoteEmail, firstWord, holdEmail, pickCabin, reasonsInWords, splitLegalName, storedAddress, storedConcierge,
  storedPick, storedTravelers, validCallWhen, validateConcierge, validateDetails, type DetailsFacts,
} from "../lib/group-details";
import { buildQuote, draftFrom, finalQuote, freeCabinFor, tripOf, quoteOptions, quoteSummary, storedQuote, unpriced, validateFinal, validateQuoteAnswers, type Quote } from "../lib/group-quote";
import { looksLikeCardNumber } from "../lib/group-file";

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
//                                              (the unqualified price: no extras or upgrades yet)
//   POST /api/group-details/:token/request     Road B, "Send my choices to Mark" (Mark 2026-11-05: "it should come to me first"): the answers are frozen and
//                                              Mark's item says "Finalize the quote". He prices the extras and upgrades in the group manager and sends the
//                                              final quote (GET/PUT /api/groups/:id/interests/:iid/quote, POST …/quote/send); the guest gets ONE email.
//   POST /api/group-details/:token/agree       Road B, "I agree", open only on Mark's final quote: the travelers go on the file (a free cabin of the chosen
//                                              category) and Mark's item becomes "Book it". First press wins.
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
  // The link in the first email, or the one in the "your quote is ready" email (issued when Mark sends the final quote: only hashes are kept, so the
  // first link cannot be written into a later email; both open the same page). The hash is 64 hex characters, so it is safe inside the filter.
  const hash = hashLinkToken(token);
  const { data: reply, error } = await db().from("group_interests").select("*").or(`details_token_hash.eq.${hash},quote_token_hash.eq.${hash}`).limit(1).maybeSingle();
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
async function deliver(o: { group: Row; reply: Row; template: "call-confirmation" | "hold-confirmation" | "quote-final"; make: () => { subject: string; html: string; text: string } }): Promise<void> {
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
    // (nor what Mark has typed so far while he finalizes it)
    const quote = stored ? (({ cabin_id: _cabin, draft: _draft, ...rest }) => rest)(stored) : null;
    return res.json({
      success: true,
      label: f.label, ship: f.ship, sailDateText: f.sailDateText, returnDateText: f.returnDateText, heroUrl: f.heroUrl, credits,
      // Mark 2026-10-26: the details page opens on its own three photos when the group file names them (otherwise the top picture as before)
      photos: pagePhotos(group.journey, "details"),
      firstName: reply.first_name ?? "", lastName: reply.last_name ?? "", email: reply.email ?? null, phone: reply.phone ?? null, guests: reply.guests ?? null,
      travelers: storedTravelers(reply.travelers) ?? [], address: storedAddress(reply.address), concierge: storedConcierge(reply.concierge), pick: storedPick(reply.pick),
      choice: reply.choice ?? null, callWhen: reply.call_when ?? null, holdRequestedAt: reply.hold_requested_at ?? null,
      quoteOptions: reply.hold_requested_at ? quoteOptions({ group, cabins, travel }, lang) : null, quote, quoteAgreedAt: reply.quote_agreed_at ?? null,
      quoteRequestedAt: reply.quote_requested_at ?? null, quoteFinalAt: reply.quote_final_at ?? null,
      paperwork: reply.quote_agreed_at ? (stored?.paperwork ?? null) : null,
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

/** Once the names are in and the quote step has opened, Mark has the list in front of him: a change to a name, a birthday or the address goes through him, not through a form. */
const alreadyHeld = (lang: Lang) => ({
  success: false,
  error: lang === "es" ? `Sus nombres ya están registrados y su cotización está en marcha. Para cambiar algo, llame o escriba a Mark al ${BUSINESS.phone}.` : `Your names are in and your quote is under way. To change anything, call or text Mark at ${BUSINESS.phone}.`,
});
/** Once the choices are with Mark he is pricing them: a change of mind goes through him, so the quote he sends is the one they asked for. */
const alreadyRequested = (lang: Lang) => ({
  success: false,
  error: lang === "es" ? `Sus decisiones ya están con Mark, que prepara su cotización final. Para cambiar algo, llame o escriba a Mark al ${BUSINESS.phone}.` : `Your choices are with Mark, who is putting your final quote together. To change anything, call or text Mark at ${BUSINESS.phone}.`,
});
/** Once the quote is agreed, the travelers are on the file and the paperwork is out: nothing on this page changes any more. */
const alreadyAgreed = (lang: Lang) => ({
  success: false,
  error: lang === "es" ? `Su cotización ya está aceptada y sus documentos van en camino. Para cambiar algo, llame o escriba a Mark al ${BUSINESS.phone}.` : `Your quote is already agreed and your paperwork is on its way. To change anything, call or text Mark at ${BUSINESS.phone}.`,
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
    res.json(opened);

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
    if (reply.quote_agreed_at) return res.status(409).json(alreadyAgreed(lang));
    if (reply.quote_requested_at) return res.status(409).json(alreadyRequested(lang));
    const options = quoteOptions({ group, cabins, travel }, lang);
    const v = validateQuoteAnswers(req.body, options, lang);
    if (!v.ok) return res.status(400).json({ success: false, error: v.error, field: v.field });
    const quote = buildQuote({ group, cabins, travel }, travelers, v.answers, lang);
    const { error } = await db().from("group_interests").update({ quote, updated_at: new Date().toISOString() }).eq("id", reply.id).is("quote_agreed_at", null).is("quote_requested_at", null);
    if (error) throw new Error(error.message);
    return res.json({ success: true, quote });
  } catch (err) {
    return fail(req, res, err, "group details quote failed");
  }
});

/** "Send my choices to Mark" (Mark 2026-11-05): the figures the page showed are the unqualified price, with no extras or upgrades, so the guest does not
 *  agree to them. The answers are frozen, Mark's item says what to price, and the guest agrees only to the quote he sends back. First press wins. */
router.post("/group-details/:token/request", async (req: Request, res: Response) => {
  try {
    if (guardPost(req, res)) return;
    const loaded = await load(req.params["token"]);
    if (!loaded) { if (missLimited(clientIp(req))) return res.status(429).json(TOO_MANY); return notFound(res); }
    const { reply, group, cabins, travel } = loaded;
    const lang = askedLang(req, loaded);
    const travelers = storedTravelers(reply.travelers);
    const quote = storedQuote(reply.quote);
    if (!reply.hold_requested_at || !travelers || !quote) {
      return res.status(400).json({ success: false, error: lang === "es" ? "Primero responda las preguntas de la cotización." : "Please answer the quote questions first." });
    }
    if (reply.quote_agreed_at) return res.status(409).json(alreadyAgreed(lang));
    const now = new Date().toISOString();
    const { data: won, error } = await db().from("group_interests")
      .update({ quote_requested_at: now, updated_at: now }).eq("id", reply.id).is("quote_requested_at", null).select("id");
    if (error) throw new Error(error.message);
    res.json({ success: true, requestedAt: reply.quote_requested_at ?? now });
    if (!((won ?? []) as unknown[]).length) return;

    // Mark's item: one person, one item. "Quote under way" is answered by this one.
    const f = detailsFacts({ group, cabins }, "en");
    const title = `Finalize the quote · ${nameOf(reply)} · ${quote.category} · party of ${travelers.length}`;
    const body = `${f.label} · ${reachOf(reply)} · ${quoteSummary(quote, quoteOptions({ group, cabins, travel }, "en"))}. `
      + `These are the guest's choices and the unqualified price from the group file. ${quote.toQuote.length ? `Price ${quote.toQuote.join("; ")}, add` : "Add"} any extras or upgrades, and send the final quote: the guest can only agree to that one.`;
    void createAction({
      type: "lead", source_ref: `group-finalize-${reply.id}`, title, body, priority: "lead",
      buttons: [{ label: "Finalize the quote", href: `/groups/${group.id}?quote=${reply.id}#quotes` }],
    }).then(async (made) => {
      if (!made.created) return;
      await resolveActionsForSource("lead", `group-hold-${reply.id}`, "done");
      await resolveActionsForSource("lead", `group-interest-${reply.id}`, "done");
      await resolveActionsForSource("lead", `group-call-${reply.id}`, "done");
    }).catch((e: unknown) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "group details: the quote request could not be put on the list"));
    return;
  } catch (err) {
    return fail(req, res, err, "group details quote request failed");
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

router.post("/group-details/:token/agree", async (req: Request, res: Response) => {
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
    // Mark 2026-11-05: the guest commits to the quote Mark finalized (extras and upgrades priced), never to the first figure the page showed.
    if (!reply.quote_final_at && !reply.quote_agreed_at) {
      return res.status(409).json({ success: false, error: lang === "es" ? "Mark aún prepara su cotización final. Le escribimos en cuanto esté lista." : "Mark is still putting your final quote together. We email you the moment it is ready." });
    }
    // The first press wins: a double tap or a reload files nobody twice, makes no second item and sends no second paperwork link.
    const now = new Date().toISOString();
    const { data: won, error } = await db().from("group_interests")
      .update({ quote_agreed_at: now, updated_at: now }).eq("id", reply.id).is("quote_agreed_at", null).select("id");
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
      const rows = travelers.map((p, i) => {
        const { first, last } = splitLegalName(p.legal_name);
        return {
          group_id: group.id, cabin_id: cabin ? cabin["id"] : null, is_lead: i === 0, first_name: first, last_name: last, dob: p.dob, lang,
          // form_data is NOT NULL and a bulk insert sends NULL (not the column default) for a key a row leaves out, so every traveler names it.
          form_data: i === 0 ? { address: address.street, city_state_zip: `${address.city}, ${address.state} ${address.zip}`, trip: tripOf(travel as Array<Record<string, unknown>>, quote.answers) } : {},
          ...(i === 0 ? { email: reply.email ?? null, phone: reply.phone ?? null } : {}),
        };
      });
      const { data: made, error: me } = await db().from("group_travelers").insert(rows).select("id, cabin_id, email, first_name, lang");
      if (me) {
        // Nobody was filed, so the agreement must not stay stamped: a retry would read "already agreed" and file no one.
        await db().from("group_interests").update({ quote_agreed_at: null, updated_at: new Date().toISOString() }).eq("id", reply.id);
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
    const title = `Book it · ${nameOf(reply)} · ${quote.category} · party of ${travelers.length}`;
    const toCheck = agreed.lines.filter((l) => l.key.startsWith("travel-") || l.key.startsWith("need-")).map((l) => l.label);
    const body = `${f.label} · ${reachOf(reply)} · ${quoteSummary(agreed, quoteOptions({ group, cabins, travel }, "en"))}. Travelers are on the file (${where}). `
      + `The paperwork link is NOT sent yet. Do this first: (1) book the cabin with the cruise line; `
      + `(2) validate ${toCheck.length ? toCheck.join("; ") : "the flights, hotel and transfers, if they asked for any"}; (3) enter the suppliers' confirmations and any change to the booking in the group file: the paperwork fills from them; (4) review it and send it to the guest.`;
    void createAction({
      type: "lead", source_ref: `group-quote-${reply.id}`, title, body, priority: "lead",
      buttons: [
        { label: "Enter the booking confirmation", href: `/groups/${group.id}?book=${reply.id}#booking` },
        { label: "Send the paperwork (needs the confirmation)", method: "POST", path: `/api/groups/${group.id}/interests/${reply.id}/booked` },
      ],
    }).then(async (made) => {
      if (!made.created) return;
      await resolveActionsForSource("lead", `group-finalize-${reply.id}`, "done");
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
// After the guest agrees the quote Mark books it with the supplier, types the confirmation and any change to the booking into the group
// manager, sees what the paperwork will now say, and sends it. The cabin lives on group_cabins (booking number, cabin number, deck, prices);
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
  const { data: reply, error } = await db().from("group_interests").select("id, status, traveler_id, quote, quote_agreed_at, first_name, last_name, email").eq("id", iid).eq("group_id", groupId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!reply || !reply.quote_agreed_at || !reply.traveler_id) return null;
  const { data: lead, error: le } = await db().from("group_travelers").select("id, cabin_id, email, first_name, last_name, lang, form_data").eq("id", reply.traveler_id).maybeSingle();
  if (le) throw new Error(le.message);
  if (!lead) return null;
  const { data: cabin, error: ce } = lead.cabin_id ? await db().from("group_cabins").select("id, cabin_num, deck, category, status, booking_number, price_total, deposit_amount").eq("id", lead.cabin_id).maybeSingle() : { data: null, error: null };
  if (ce) throw new Error(ce.message);
  return { reply, lead, cabin, quote: storedQuote(reply.quote) };
}

type BookingFile = NonNullable<Awaited<ReturnType<typeof loadBooking>>>;
function bookingView(b: BookingFile) {
  const chosen = tripEntries(b.lead.form_data);
  const needs = ((b.lead.form_data as Record<string, any> | null)?.["trip"]?.["needs"] ?? {}) as Record<string, boolean>;
  const missing: string[] = [];
  if (!b.cabin) missing.push("The cabin this guest is on is not on the group file");
  else {
    if (!text(b.cabin["booking_number"])) missing.push("The cruise line's booking number");
    if (!text(b.cabin["cabin_num"])) missing.push("The cabin number");
  }
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
  };
}

/** The guests who have agreed a quote, for the group manager's "Bookings to confirm" card: the ones still waiting on Mark first. */
router.get("/groups/:id/bookings", requireToken, async (req: Request, res: Response) => {
  try {
    const groupId = String(req.params["id"]);
    if (!UUID_RE.test(groupId)) return res.status(404).json({ success: false, error: "Group not found" });
    const { data, error } = await db().from("group_interests").select("id, first_name, last_name, quote, quote_agreed_at").eq("group_id", groupId).not("quote_agreed_at", "is", null).order("quote_agreed_at", { ascending: true });
    if (error) throw new Error(error.message);
    const rows = (data ?? []).map((r: Row) => {
      const q = storedQuote(r["quote"]);
      return { id: String(r["id"]), name: nameOf(r) || "Guest", category: q?.category ?? null, party: q?.party ?? null, paperwork: q?.paperwork ?? "booking", agreed_at: r["quote_agreed_at"] };
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
    if (!b) return res.status(404).json({ success: false, error: "That guest has not agreed a quote yet." });
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
    if (!b) return res.status(404).json({ success: false, error: "That guest has not agreed a quote yet." });
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
    const { data: reply, error } = await db().from("group_interests").select("id, status, traveler_id, quote, quote_agreed_at").eq("id", iid).eq("group_id", groupId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!reply || !reply.quote_agreed_at || !reply.traveler_id) return res.status(404).json({ success: false, error: "That guest has not agreed a quote yet." });
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

// ── Mark finalizes the quote (Mark 2026-11-05) ─────────────────────────────────────────────────────────────────────────────────────────────
// The guest sent their choices; the figure they saw is the unqualified price. In the group manager Mark prices what the file could not, adds the
// extras and upgrades, and sends the final quote. Only that one can be agreed. He can send a corrected one until the guest agrees.
const UUID_Q = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadQuoteFile(groupId: string, iid: string) {
  if (!UUID_Q.test(groupId) || !UUID_Q.test(iid)) return null;
  const { data: reply, error } = await db().from("group_interests").select("*").eq("id", iid).eq("group_id", groupId).maybeSingle();
  if (error) throw new Error(error.message);
  const quote = reply ? storedQuote(reply.quote) : null;
  if (!reply || !quote || !reply.quote_requested_at) return null;
  const { data: group, error: ge } = await db().from("groups").select("*").eq("id", groupId).maybeSingle();
  if (ge) throw new Error(ge.message);
  if (!group) return null;
  const { data: cabins, error: ce } = await db().from("group_cabins").select("*").eq("group_id", groupId).order("id", { ascending: true });
  if (ce) throw new Error(ce.message);
  const { data: travel, error: te } = await db().from("group_travel").select("*").eq("group_id", groupId).is("traveler_id", null).is("cabin_id", null).order("created_at", { ascending: true });
  if (te) throw new Error(te.message);
  return { reply: reply as Row, quote, group: group as Row, cabins: (cabins ?? []) as Row[], travel: (travel ?? []) as Row[] };
}
type QuoteFileLoaded = NonNullable<Awaited<ReturnType<typeof loadQuoteFile>>>;

function quoteView(f: QuoteFileLoaded) {
  const options = quoteOptions({ group: f.group, cabins: f.cabins, travel: f.travel }, "en");
  const draft = draftFrom(f.quote);
  const est = f.quote.estimate ?? { lines: f.quote.lines, total: f.quote.total, totalText: f.quote.totalText, category: f.quote.category };
  const travelers = storedTravelers(f.reply.travelers) ?? [];
  return {
    success: true,
    guest: { name: nameOf(f.reply) || "Guest", email: f.reply.email ?? null, phone: f.reply.phone ?? null, party: travelers.length || f.quote.party, travelers: travelers.map((t) => t.legal_name) },
    choices: quoteSummary({ ...f.quote, category: est.category, totalText: est.totalText, toQuote: est.lines.filter((l) => l.toQuote).map((l) => l.label) }, options),
    estimate: est, draft, toPrice: unpriced(f.quote, draft),
    cabins: options.cabins.map((c) => ({ key: c.key, label: c.label })),
    finalPaymentText: f.quote.finalPaymentText,
    requestedAt: f.reply.quote_requested_at, finalAt: f.reply.quote_final_at ?? null, agreedAt: f.reply.quote_agreed_at ?? null,
    sent: f.reply.quote_final_at ? { total: f.quote.totalText, email: f.reply.ack_email_status ?? null } : null,
  };
}

/** The guests whose choices are in, for the group manager's "Quotes to finalize" card: the ones still waiting on Mark first. */
router.get("/groups/:id/quotes", requireToken, async (req: Request, res: Response) => {
  try {
    const groupId = String(req.params["id"]);
    if (!UUID_Q.test(groupId)) return res.status(404).json({ success: false, error: "Group not found" });
    const { data, error } = await db().from("group_interests").select("id, first_name, last_name, quote, quote_requested_at, quote_final_at, quote_agreed_at")
      .eq("group_id", groupId).not("quote_requested_at", "is", null).order("quote_requested_at", { ascending: true });
    if (error) throw new Error(error.message);
    const rows = (data ?? []).map((r: Row) => {
      const q = storedQuote(r["quote"]);
      const state = r["quote_agreed_at"] ? "agreed" : r["quote_final_at"] ? "sent" : "finalize";
      return { id: String(r["id"]), name: nameOf(r) || "Guest", category: q?.category ?? null, party: q?.party ?? null, state, requested_at: r["quote_requested_at"] };
    });
    const rank: Record<string, number> = { finalize: 0, sent: 1, agreed: 2 };
    rows.sort((a: { state: string }, b: { state: string }) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9));
    return res.json({ success: true, quotes: rows });
  } catch (err) {
    return fail(req, res, err, "group quotes list failed");
  }
});

router.get("/groups/:id/interests/:iid/quote", requireToken, async (req: Request, res: Response) => {
  try {
    const f = await loadQuoteFile(String(req.params["id"]), String(req.params["iid"]));
    if (!f) return res.status(404).json({ success: false, error: "That guest has not sent their choices yet." });
    return res.json(quoteView(f));
  } catch (err) {
    return fail(req, res, err, "group quote read failed");
  }
});

/** Mark's work in progress on the final quote: kept on the reply, never shown to the guest until he sends it. */
router.put("/groups/:id/interests/:iid/quote", requireToken, async (req: Request, res: Response) => {
  try {
    const f = await loadQuoteFile(String(req.params["id"]), String(req.params["iid"]));
    if (!f) return res.status(404).json({ success: false, error: "That guest has not sent their choices yet." });
    if (f.reply.quote_agreed_at) return res.status(409).json({ success: false, error: "The guest has agreed this quote: it no longer changes here." });
    const v = validateFinal(req.body, quoteOptions({ group: f.group, cabins: f.cabins, travel: f.travel }, "en"), looksLikeCardNumber);
    if (!v.ok) return res.status(400).json({ success: false, error: v.error });
    const quote: Quote = { ...f.quote, draft: v.draft };
    const { error } = await db().from("group_interests").update({ quote, updated_at: new Date().toISOString() }).eq("id", f.reply.id).is("quote_agreed_at", null);
    if (error) throw new Error(error.message);
    return res.json(quoteView({ ...f, quote }));
  } catch (err) {
    return fail(req, res, err, "group quote save failed");
  }
});

/** "Send the final quote": the saved lines become the quote the guest sees and can agree to, and the guest gets the ONE email that says so.
 *  Refused while a line the guest asked Mark to price has no amount. Sent again after a correction, it emails again. */
router.post("/groups/:id/interests/:iid/quote/send", requireToken, async (req: Request, res: Response) => {
  try {
    const f = await loadQuoteFile(String(req.params["id"]), String(req.params["iid"]));
    if (!f) return res.status(404).json({ success: false, error: "That guest has not sent their choices yet." });
    if (f.reply.quote_agreed_at) return res.status(409).json({ success: false, error: "The guest has agreed this quote: it no longer changes here." });
    const lang: Lang = f.reply.lang === "es" ? "es" : "en";
    const options = quoteOptions({ group: f.group, cabins: f.cabins, travel: f.travel }, lang);
    const draft = draftFrom(f.quote);
    const open = unpriced(f.quote, draft);
    if (open.length) return res.status(409).json({ success: false, error: `Price these first, or take them off the quote: ${open.join("; ")}.`, toPrice: open });
    if (!options.cabins.some((c) => c.key === draft.cabin)) return res.status(409).json({ success: false, error: "The cabin type on this quote is no longer one the group holds: pick another." });
    const now = new Date();
    const quote = finalQuote(f.quote, draft, options, now);
    const { data: won, error } = await db().from("group_interests")
      .update({ quote, quote_final_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", f.reply.id).is("quote_agreed_at", null).select("id");
    if (error) throw new Error(error.message);
    if (!((won ?? []) as unknown[]).length) return res.status(409).json({ success: false, error: "The guest has agreed this quote: it no longer changes here." });
    await resolveActionsForSource("lead", `group-finalize-${f.reply.id}`, "done");
    res.json(quoteView({ ...f, quote, reply: { ...f.reply, quote_final_at: now.toISOString() } }));

    // The ONE email, after the answer has gone: the guest's own link is stored only as a hash, so a second one is made for the button (the first keeps
    // working). It is derived from the reply, so a corrected quote carries the same link; without the link key it is a fresh one each time.
    const facts = detailsFacts({ group: f.group, cabins: f.cabins }, lang);
    const key = hubKey();
    const token = key ? deriveQuoteToken(String(f.reply.id), key) : issueToken().token;
    const hash = hashLinkToken(token);
    const { error: te } = await db().from("group_interests").update({ quote_token_hash: hash }).eq("id", f.reply.id);
    if (te) { logger.warn({ err: te.message }, "group details: the final quote's link could not be issued (no email sent)"); return; }
    void deliver({
      group: f.group, reply: f.reply, template: "quote-final",
      make: () => finalQuoteEmail({
        firstName: firstWord(f.reply.first_name), groupLabel: facts.label, hostNames: facts.hostNames, lang, publicSite: publicSite(),
        category: quote.category, totalText: quote.totalText, note: quote.markNote ?? null, detailsUrl: makeDetailsUrl(publicSite(), token, lang),
      }),
    }).catch((e: unknown) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "group details: the final quote email step failed"));
    return;
  } catch (err) {
    return fail(req, res, err, "group quote send failed");
  }
});

export type { DetailsFacts };
export default router;
