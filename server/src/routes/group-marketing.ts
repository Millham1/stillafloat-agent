import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { getSupabase } from "../lib/persistence";
import { requireToken, tokenOk } from "../lib/http-auth";
import { logger } from "../lib/logger";
import { llmJson } from "../lib/llm";
import { verifyTurnstile } from "../lib/turnstile";
import { notifyMark } from "../lib/notify";
import { hashForAudit } from "../lib/group-secure";
import { clientIp } from "../lib/client-ip";
import {
  COPY_FIELDS, COPY_SCHEMA, INTERVIEW, buildFacts, missingAnswers, newShareCode, normalizeAnswers, retryNote,
  shipSlugCandidate, systemPrompt, tidyCopy, userPrompt, validateCopy,
  type GroupCopy, type GroupFacts, type Lang,
} from "../lib/group-marketing";

// Group marketing (migration 0045).
//
// Dashboard (token):
//   GET  /api/groups/:id/marketing                 interview + answers + facts + copy + problems
//   PUT  /api/groups/:id/marketing/answers         save the interview
//   POST /api/groups/:id/marketing/write           write the copy for one language (job groups.marketing)
//   PUT  /api/groups/:id/marketing/copy            save Mark's edits to the copy
//   POST /api/groups/:id/marketing/approve         { approved: true|false } — the page goes live / comes down
//   GET  /api/groups/:id/interests                 replies from the page
//   PATCH /api/groups/:id/interests/:rowId         { status }
// Public (the group page):
//   GET  /api/group-page/:code?lang=en|es          facts + approved copy (or with the dashboard token: a preview)
//   POST /api/group-page/:code/interest            "I'm interested" — stored, Mark is told, no payment, no card
//
// Facts come from the group file on every request; copy never carries a figure
// the validator has not matched to the file.

const router: IRouter = Router();
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (): any => getSupabase();

function fail(req: Request, res: Response, err: unknown, what: string) {
  req.log.error({ err }, what);
  return res.status(500).json({ success: false, error: (err as Error).message });
}

function langsFor(group: Row): Lang[] {
  return group.lang === "es" ? ["es"] : group.lang === "both" ? ["en", "es"] : ["en"];
}

async function loadGroup(where: { id?: string; code?: string }): Promise<{ group: Row; cabins: Row[]; rating: Row | null } | null> {
  let q = db().from("groups").select("*");
  q = where.id ? q.eq("id", where.id) : q.eq("share_code", where.code);
  const { data: group, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  if (!group) return null;
  const { data: cabins, error: ce } = await db().from("group_cabins").select("*").eq("group_id", group.id).order("id", { ascending: true });
  if (ce) throw new Error(ce.message);

  // The ship's Conga Line row, when we know the hull. Resolve the slug once from
  // the name and remember it on the file.
  let slug: string | null = group.ship_slug ?? null;
  if (!slug && group.ship_name) {
    const candidate = shipSlugCandidate(group.ship_name);
    if (candidate) {
      const { data: hull } = await db().from("cabin_ships").select("slug").eq("slug", candidate).maybeSingle();
      if (hull?.slug) {
        slug = hull.slug;
        await db().from("groups").update({ ship_slug: slug }).eq("id", group.id);
        group.ship_slug = slug;
      }
    }
  }
  let rating: Row | null = null;
  if (slug) {
    const { data } = await db().from("conga_line_ratings").select("*").eq("ship_slug", slug).maybeSingle();
    rating = data ?? null;
  }
  return { group, cabins: cabins ?? [], rating };
}

function copyFor(group: Row, lang: Lang): GroupCopy | null {
  const c = group.marketing_copy?.[lang];
  return c && typeof c === "object" ? tidyCopy(c) : null;
}

/** What the public page may see. No ids, no organizer contact, no internal notes. */
function publicFacts(f: GroupFacts, answers: Record<string, string | boolean>): Row {
  const showPrices = answers["show_prices"] !== false;
  return {
    lang: f.lang, business: f.business, groupName: f.groupName, line: f.line, ship: f.ship,
    sailDateText: f.sailDateText, returnDateText: f.returnDateText, nights: f.nights, embarkPort: f.embarkPort,
    ports: f.ports, itinerary: f.itinerary, amenities: f.amenities,
    cabins: f.cabins.map((c) => ({
      category: c.category, available: c.available,
      perPersonText: showPrices ? c.perPersonText : null,
      depositPerPersonText: showPrices ? c.depositPerPersonText : null,
    })),
    cabinsAvailable: f.cabinsAvailable,
    fromPerPersonText: showPrices ? f.fromPerPersonText : null,
    bookByText: f.bookByText, finalPaymentText: f.finalPaymentText,
    rating: answers["show_rating"] !== false ? f.rating : null,
    markSailing: answers["mark_sailing"] === true,
  };
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

router.get("/groups/:id/marketing", requireToken, async (req: Request, res: Response) => {
  try {
    const loaded = await loadGroup({ id: String(req.params["id"]) });
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    const { group, cabins, rating } = loaded;
    const answers = normalizeAnswers(group.marketing);
    const langs = langsFor(group);
    const perLang: Row = {};
    for (const lang of langs) {
      const facts = buildFacts({ group, cabins }, rating, lang);
      const copy = copyFor(group, lang);
      perLang[lang] = { facts, copy, problems: copy ? validateCopy(copy, facts, answers) : [] };
    }
    return res.json({
      success: true,
      interview: INTERVIEW, answers, missing: missingAnswers(answers), copyFields: COPY_FIELDS, langs, perLang,
      shareCode: group.share_code ?? null, approvedAt: group.marketing_approved_at ?? null,
      writtenAt: group.marketing_copy?.written_at ?? null,
    });
  } catch (err) {
    return fail(req, res, err, "group marketing read failed");
  }
});

router.put("/groups/:id/marketing/answers", requireToken, async (req: Request, res: Response) => {
  try {
    const answers = normalizeAnswers(req.body);
    const { data, error } = await db().from("groups")
      .update({ marketing: answers, updated_at: new Date().toISOString() })
      .eq("id", String(req.params["id"])).select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ success: false, error: "Group not found" });
    return res.json({ success: true, answers, missing: missingAnswers(answers) });
  } catch (err) {
    return fail(req, res, err, "group marketing answers failed");
  }
});

/** Write (or rewrite) the copy for one language. One retry with the validator's findings. */
router.post("/groups/:id/marketing/write", requireToken, async (req: Request, res: Response) => {
  try {
    const loaded = await loadGroup({ id: String(req.params["id"]) });
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    const { group, cabins, rating } = loaded;
    const lang: Lang = (req.body as Row)?.["lang"] === "es" ? "es" : "en";
    if (!langsFor(group).includes(lang)) return res.status(400).json({ success: false, error: "This group is not set to that language" });
    const answers = normalizeAnswers(group.marketing);
    const missing = missingAnswers(answers);
    if (missing.length) return res.status(400).json({ success: false, error: "Answer the first three interview questions before writing the copy" });
    if (!group.ship_name || !group.sail_date) return res.status(400).json({ success: false, error: "The group file needs a ship and a sail date first" });

    const facts = buildFacts({ group, cabins }, rating, lang);
    const base = { job: "groups.marketing" as const, system: systemPrompt(lang), schema: COPY_SCHEMA, maxTokens: 2500, timeoutMs: 180_000 };
    let copy = tidyCopy(await llmJson<Row>({ ...base, user: userPrompt(facts, answers) }));
    let problems = validateCopy(copy, facts, answers);
    if (problems.length) {
      copy = tidyCopy(await llmJson<Row>({
        ...base,
        user: `${userPrompt(facts, answers)}\n\n<previous_draft>\n${JSON.stringify(copy)}\n</previous_draft>\n\n${retryNote(problems)}`,
      }));
      problems = validateCopy(copy, facts, answers);
    }

    // New words are unapproved words: writing takes the page down until Mark approves again.
    const next = { ...(group.marketing_copy ?? {}), [lang]: copy, written_at: new Date().toISOString() };
    const { error } = await db().from("groups")
      .update({ marketing_copy: next, marketing_approved_at: null, updated_at: new Date().toISOString() })
      .eq("id", group.id);
    if (error) throw new Error(error.message);
    logger.info({ group: group.id, lang, problems: problems.length }, "group marketing copy written");
    return res.json({ success: true, lang, copy, problems });
  } catch (err) {
    return fail(req, res, err, "group marketing write failed");
  }
});

router.put("/groups/:id/marketing/copy", requireToken, async (req: Request, res: Response) => {
  try {
    const loaded = await loadGroup({ id: String(req.params["id"]) });
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    const { group, cabins, rating } = loaded;
    const body = (req.body ?? {}) as Row;
    const lang: Lang = body["lang"] === "es" ? "es" : "en";
    const copy = tidyCopy(body["copy"]);
    const facts = buildFacts({ group, cabins }, rating, lang);
    const problems = validateCopy(copy, facts, normalizeAnswers(group.marketing));
    const next = { ...(group.marketing_copy ?? {}), [lang]: copy };
    // An edit to approved copy that introduces a problem takes the page down;
    // a clean edit keeps the approval (Mark is the one editing).
    const patch: Row = { marketing_copy: next, updated_at: new Date().toISOString() };
    if (problems.length) patch["marketing_approved_at"] = null;
    const { error } = await db().from("groups").update(patch).eq("id", group.id);
    if (error) throw new Error(error.message);
    return res.json({ success: true, lang, copy, problems, approvedAt: problems.length ? null : group.marketing_approved_at ?? null });
  } catch (err) {
    return fail(req, res, err, "group marketing copy save failed");
  }
});

router.post("/groups/:id/marketing/approve", requireToken, async (req: Request, res: Response) => {
  try {
    const loaded = await loadGroup({ id: String(req.params["id"]) });
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    const { group, cabins, rating } = loaded;
    const approve = (req.body as Row)?.["approved"] !== false;
    if (!approve) {
      const { error } = await db().from("groups").update({ marketing_approved_at: null }).eq("id", group.id);
      if (error) throw new Error(error.message);
      return res.json({ success: true, approvedAt: null, shareCode: group.share_code ?? null });
    }
    // Every language the group uses must have clean copy before the page goes live.
    const answers = normalizeAnswers(group.marketing);
    for (const lang of langsFor(group)) {
      const copy = copyFor(group, lang);
      if (!copy) return res.status(400).json({ success: false, error: `There is no ${lang === "es" ? "Spanish" : "English"} copy yet` });
      const problems = validateCopy(copy, buildFacts({ group, cabins }, rating, lang), answers);
      if (problems.length) {
        return res.status(400).json({ success: false, error: `The ${lang === "es" ? "Spanish" : "English"} copy still has ${problems.length} problem(s) to fix`, problems });
      }
    }
    const shareCode = group.share_code ?? newShareCode((n) => randomBytes(n));
    const approvedAt = new Date().toISOString();
    const { error } = await db().from("groups")
      .update({ share_code: shareCode, marketing_approved_at: approvedAt, status: group.status === "draft" ? "marketing" : group.status })
      .eq("id", group.id);
    if (error) throw new Error(error.message);
    return res.json({ success: true, approvedAt, shareCode });
  } catch (err) {
    return fail(req, res, err, "group marketing approve failed");
  }
});

/** Preview needs a code even before approval. */
router.post("/groups/:id/marketing/share-code", requireToken, async (req: Request, res: Response) => {
  try {
    const { data: group, error } = await db().from("groups").select("id, share_code").eq("id", String(req.params["id"])).maybeSingle();
    if (error) throw new Error(error.message);
    if (!group) return res.status(404).json({ success: false, error: "Group not found" });
    if (group.share_code) return res.json({ success: true, shareCode: group.share_code });
    const shareCode = newShareCode((n) => randomBytes(n));
    const { error: ue } = await db().from("groups").update({ share_code: shareCode }).eq("id", group.id);
    if (ue) throw new Error(ue.message);
    return res.json({ success: true, shareCode });
  } catch (err) {
    return fail(req, res, err, "group share code failed");
  }
});

router.get("/groups/:id/interests", requireToken, async (req: Request, res: Response) => {
  try {
    const { data, error } = await db().from("group_interests")
      .select("id, first_name, last_name, email, phone, lang, cabin_type, guests, note, newsletter_opt_in, status, created_at")
      .eq("group_id", String(req.params["id"])).order("created_at", { ascending: false }).order("id", { ascending: true });
    if (error) throw new Error(error.message);
    return res.json({ success: true, interests: data ?? [] });
  } catch (err) {
    return fail(req, res, err, "group interests read failed");
  }
});

router.patch("/groups/:id/interests/:rowId", requireToken, async (req: Request, res: Response) => {
  try {
    const status = String((req.body as Row)?.["status"] ?? "");
    if (!["new", "contacted", "booked", "declined", "spam"].includes(status)) return res.status(400).json({ success: false, error: "Unknown status" });
    const { data, error } = await db().from("group_interests")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", String(req.params["rowId"])).eq("group_id", String(req.params["id"])).select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ success: false, error: "Reply not found" });
    return res.json({ success: true });
  } catch (err) {
    return fail(req, res, err, "group interest update failed");
  }
});

// ── Public page ───────────────────────────────────────────────────────────────

const CODE = /^[a-hjkmnp-z2-9]{10}$/;

router.get("/group-page/:code", async (req: Request, res: Response) => {
  try {
    const code = String(req.params["code"]);
    if (!CODE.test(code)) return res.status(404).json({ success: false, error: "Not found" });
    const loaded = await loadGroup({ code });
    if (!loaded) return res.status(404).json({ success: false, error: "Not found" });
    const { group, cabins, rating } = loaded;
    const preview = tokenOk(req);
    const live = !!group.marketing_approved_at && ["marketing", "booking"].includes(group.status);
    if (!live && !preview) return res.status(404).json({ success: false, error: "Not found" });

    const langs = langsFor(group);
    const asked = req.query["lang"] === "es" ? "es" : req.query["lang"] === "en" ? "en" : langs[0]!;
    const lang: Lang = langs.includes(asked) ? asked : langs[0]!;
    const copy = copyFor(group, lang);
    if (!copy) return res.status(404).json({ success: false, error: "Not found" });
    const answers = normalizeAnswers(group.marketing);
    const facts = buildFacts({ group, cabins }, rating, lang);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return res.json({
      success: true, live, preview: preview && !live, langs,
      facts: publicFacts(facts, answers),
      copy: { headline: copy.headline, subhead: copy.subhead, intro: copy.intro, why_ship: copy.why_ship, who_for: copy.who_for, organizer_note: copy.organizer_note, cta_label: copy.cta_label, cta_blurb: copy.cta_blurb },
      turnstileSiteKey: process.env["TURNSTILE_SITE_KEY"] || "",
    });
  } catch (err) {
    return fail(req, res, err, "group page read failed");
  }
});

const hits = new Map<string, { count: number; resetAt: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || e.resetAt < now) { hits.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 }); return false; }
  e.count++;
  return e.count > 5;
}

router.post("/group-page/:code/interest", async (req: Request, res: Response) => {
  try {
    const code = String(req.params["code"]);
    if (!CODE.test(code)) return res.status(404).json({ success: false, error: "Not found" });
    const ip = clientIp(req);
    if (limited(ip)) return res.status(429).json({ success: false, error: "Too many requests. Please email mark@stillafloatcruising.com." });

    const body = (req.body ?? {}) as Row;
    if (typeof body["website"] === "string" && body["website"]) return res.json({ success: true }); // honeypot
    if (!(await verifyTurnstile((body["cf-turnstile-response"] as string) || null))) {
      return res.status(400).json({ success: false, error: "Please complete the check and try again." });
    }
    const loaded = await loadGroup({ code });
    if (!loaded) return res.status(404).json({ success: false, error: "Not found" });
    const { group } = loaded;
    if (!group.marketing_approved_at || !["marketing", "booking"].includes(group.status)) {
      return res.status(404).json({ success: false, error: "Not found" });
    }

    const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const first = text(body["first_name"], 80);
    const last = text(body["last_name"], 80);
    const email = text(body["email"], 200).toLowerCase();
    const phone = text(body["phone"], 40);
    const lang: Lang = body["lang"] === "es" ? "es" : "en";
    if (!first) return res.status(400).json({ success: false, error: lang === "es" ? "Falta su nombre." : "Please add your first name." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ success: false, error: lang === "es" ? "Revise su correo electrónico." : "Please check your email address." });
    const guests = Number.isInteger(Number(body["guests"])) && Number(body["guests"]) > 0 && Number(body["guests"]) <= 12 ? Number(body["guests"]) : null;
    const optIn = body["newsletter_opt_in"] === true;

    // Clients also land in the website's contact list (Mark 2026-10-02). The
    // newsletter is NOT implied: opt-in is stored and handled by the normal
    // confirmation flow, never auto-subscribed here.
    let prospectId: string | null = null;
    const { data: prospect, error: pe } = await db().from("prospects").insert({
      first_name: first, last_name: last || null, email, phone: phone || null,
      destination: `${group.ship_name ?? "Group cruise"} — ${group.name}`,
      preferred_lang: lang, num_travelers: guests, cruise_line_pref: group.cruise_line ?? null,
      referral_source: "group-page",
      notes: `Group: ${group.name}. ${text(body["note"], 800)}`.trim(),
      status: "new",
    }).select("id").maybeSingle();
    if (pe) logger.warn({ err: pe.message }, "group interest: prospects insert failed (interest still saved)");
    else prospectId = prospect?.id ?? null;

    const { error } = await db().from("group_interests").insert({
      group_id: group.id, first_name: first, last_name: last || null, email, phone: phone || null, lang,
      cabin_type: text(body["cabin_type"], 80) || null, guests, note: text(body["note"], 800) || null,
      newsletter_opt_in: optIn, ip_hash: hashForAudit(ip), prospect_id: prospectId,
    });
    if (error) throw new Error(error.message);

    void notifyMark({
      title: `Group reply: ${first}${last ? " " + last : ""}`,
      body: `${group.name} — ${guests ? guests + " guest(s), " : ""}${text(body["cabin_type"], 80) || "no cabin type picked"}. Reply within a few hours.`,
      tag: `group-interest-${group.id}`,
      buttons: [{ label: "Open the group file", href: `/groups/${group.id}` }],
      priority: "lead",
    }).catch((e: unknown) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "group interest notify failed"));

    return res.json({ success: true });
  } catch (err) {
    return fail(req, res, err, "group interest failed");
  }
});

export default router;
