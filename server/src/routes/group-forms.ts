import { Router, type IRouter, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getSupabase } from "../lib/persistence";
import { requireToken } from "../lib/http-auth";
import { logger } from "../lib/logger";
import { clientIp } from "../lib/client-ip";
import { sendMail } from "../lib/mailer";
import { notifyMark } from "../lib/notify";
import { resolvePublicDir } from "../lib/public-dir";
import { BUSINESS } from "../lib/group-secure";
import { renderSignedPdf } from "../lib/group-signature-pdf";
import { DOC_SPECS } from "../lib/group-documents";
import {
  formUrl, getPacket, issueToken, linkEmail, mailAllowed, organizerBlanks, packetStatuses, signDocument,
  type FormsDeps, type FormsStore,
} from "../lib/group-forms";

// Client paperwork (migrations 0044 and 0052).
//
// Dashboard (token):
//   POST   /api/groups/:id/travelers/:tid/form-link        a new private link for one traveler (the URL is returned ONCE)
//   POST   /api/groups/:id/travelers/:tid/form-link/send   a new link, emailed to the traveler's own address on the file
//   POST   /api/groups/:id/organizer-link                  the organizer's link (the group contract)
//   GET    /api/groups/:id/signatures                      who signed what, and each traveler's progress
//   GET    /api/groups/:id/signatures/:sid/file            the signed copy: a 10-minute link to the private bucket
//   DELETE /api/groups/:id/signatures/:sid                 take a signature back (a mistake): the signer can sign again
// Public (the link's token is the credential; there is no other login):
//   GET    /api/forms/:token                               the packet: documents, their inputs, what is signed
//   POST   /api/forms/:token/sign                          { doc_key, answers, signer_name, agreed, content_sha256, newsletter_opt_in, website }
//
// The rules live in lib/group-forms.ts (unit-tested with its I/O injected); this file only wires them to
// Supabase, the mailer and the notifier, and holds the per-address limits.
//
// TODO(group-signing): the agent's countersignature on the group contract (09) is a later dashboard step:
// a group_signatures row with signer_role = 'agent' for the same doc_key and content hash.

const router: IRouter = Router();
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (): any => getSupabase();
const BUCKET = "group-docs";

function fail(req: Request, res: Response, err: unknown, what: string) {
  req.log.error({ err }, what);
  return res.status(500).json({ success: false, error: (err as Error).message });
}

function publicSite(): string {
  return (process.env["PUBLIC_URL"] || "https://stillafloatcruising.com").replace(/\/$/, "");
}

// Never read passport_enc, form_token_hash or consent_ip_hash into this flow: the answers a traveler needs
// from the file are the columns below, and a passport number is never read back at all.
const TRAVELER_COLS =
  "id, group_id, cabin_id, is_lead, first_name, middle_name, last_name, dob, gender, citizenship, email, phone, lang, " +
  "passport_last4, passport_country, passport_expiry, emergency_name, emergency_phone, special_needs, form_data, " +
  "newsletter_opt_in, prospect_id, form_sent_at, form_submitted_at, consent_name, consent_signed_at";

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const store: FormsStore = {
  async travelerByTokenHash(hash) {
    const { data, error } = await db().from("group_travelers").select(TRAVELER_COLS).eq("form_token_hash", hash).maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? null;
  },
  async groupByOrganizerHash(hash) {
    const { data, error } = await db().from("groups").select("*").eq("organizer_token_hash", hash).maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? null;
  },
  async group(id) {
    const { data, error } = await db().from("groups").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? null;
  },
  async cabins(groupId) {
    const { data, error } = await db().from("group_cabins").select("*").eq("group_id", groupId).order("id", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  },
  async travelers(groupId) {
    const { data, error } = await db().from("group_travelers").select(TRAVELER_COLS).eq("group_id", groupId).order("id", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  },
  async signaturesFor({ groupId, travelerId }) {
    let q = db().from("group_signatures").select("id, doc_key, signer_role, signer_name, signed_at, traveler_id, pdf_path");
    q = travelerId ? q.eq("traveler_id", travelerId) : q.eq("group_id", groupId).eq("signer_role", "organizer").is("traveler_id", null);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  },
  async insertSignature(row) {
    const { data, error } = await db().from("group_signatures").insert(row).select("id").single();
    if (error) {
      if (error.code === "23505") return "duplicate";
      throw new Error(error.message);
    }
    return { id: data.id as string };
  },
  async deleteSignature(id) {
    const { error } = await db().from("group_signatures").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },
  async updateTraveler(id, patch) {
    const { error } = await db().from("group_travelers").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
  },
  async uploadPdf(p, bytes) {
    const { error } = await db().storage.from(BUCKET).upload(p, bytes, { contentType: "application/pdf", upsert: false });
    if (error) throw new Error(error.message);
  },
  async setSignaturePdf(id, p) {
    const { error } = await db().from("group_signatures").update({ pdf_path: p }).eq("id", id);
    if (error) throw new Error(error.message);
  },
  async upsertProspect(row) {
    const found = await db().from("prospects").select("id").ilike("email", likeEscape(String(row["email"]))).limit(1).maybeSingle();
    if (found.data?.id) return found.data.id as string;
    const { data, error } = await db().from("prospects").insert(row).select("id").maybeSingle();
    if (error) {
      logger.warn({ err: error.message }, "paperwork: prospects insert failed (the newsletter choice is still recorded)");
      return null;
    }
    return (data?.id as string) ?? null;
  },
};

let logo: Buffer | null | undefined;
function logoBytes(): Buffer | null {
  if (logo === undefined) {
    try { logo = readFileSync(path.join(resolvePublicDir(), BUSINESS.logoPath)); } catch { logo = null; }
  }
  return logo;
}

function deps(): FormsDeps {
  return {
    store,
    now: () => new Date(),
    piiKey: process.env["GROUP_PII_KEY"],
    renderPdf: renderSignedPdf,
    logo: logoBytes(),
    notify: (n) => notifyMark({
      title: n.title, body: n.body, tag: `group-paperwork-${n.groupId}`,
      buttons: [{ label: "Open the group file", href: `/groups/${n.groupId}` }],
    }).then(() => undefined),
    warn: (obj, msg) => logger.warn(obj, msg),
  };
}

// ── Limits (per address, in memory — the same pattern as the group page's interest form) ────

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
const signLimited = limiter(20);   // signing attempts per address per hour
const missLimited = limiter(40);   // wrong links per address per hour: a guess is never worth trying

function privateHeaders(res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
}

// ── Public ────────────────────────────────────────────────────────────────────

router.get("/forms/:token", async (req: Request, res: Response) => {
  try {
    privateHeaders(res);
    const out = await getPacket(deps(), req.params["token"]);
    if (out.status === 404 && missLimited(clientIp(req))) {
      return res.status(429).json({ success: false, error: "Too many attempts. Please use the link from your email, or ask us for a new one." });
    }
    return res.status(out.status).json(out.json);
  } catch (err) {
    return fail(req, res, err, "paperwork packet failed");
  }
});

router.post("/forms/:token/sign", async (req: Request, res: Response) => {
  try {
    privateHeaders(res);
    const ip = clientIp(req);
    if (signLimited(ip)) {
      return res.status(429).json({ success: false, error: `Too many attempts. Please try again later, or email ${BUSINESS.email}.` });
    }
    const body = (req.body ?? {}) as Row;
    if (typeof body["website"] === "string" && body["website"]) return res.json({ success: true }); // honeypot: a person never fills it
    if (JSON.stringify(body).length > 120_000) return res.status(413).json({ success: false, error: "That is too much text for one form." });
    const out = await signDocument(deps(), req.params["token"], body, { ip, ua: String(req.headers["user-agent"] ?? "") });
    if (out.status === 404 && missLimited(ip)) {
      return res.status(429).json({ success: false, error: "Too many attempts. Please use the link from your email, or ask us for a new one." });
    }
    return res.status(out.status).json(out.json);
  } catch (err) {
    return fail(req, res, err, "paperwork signing failed");
  }
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

async function travelerInGroup(groupId: string, tid: string): Promise<Row | null> {
  const { data, error } = await db().from("group_travelers").select("id, group_id, cabin_id, first_name, last_name, email, lang, form_token_hash, form_sent_at").eq("id", tid).eq("group_id", groupId).maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

router.post("/groups/:id/travelers/:tid/form-link", requireToken, async (req: Request, res: Response) => {
  try {
    const t = await travelerInGroup(String(req.params["id"]), String(req.params["tid"]));
    if (!t) return res.status(404).json({ success: false, error: "Traveler not found" });
    const { token, hash } = issueToken();
    await store.updateTraveler(t.id, { form_token_hash: hash, form_sent_at: new Date().toISOString() });
    // The link is shown once: only its hash is kept. Asking again makes a new link and the old one stops working.
    return res.status(201).json({ success: true, url: formUrl(publicSite(), token) });
  } catch (err) {
    return fail(req, res, err, "paperwork link failed");
  }
});

router.post("/groups/:id/travelers/:tid/form-link/send", requireToken, async (req: Request, res: Response) => {
  try {
    const groupId = String(req.params["id"]);
    const t = await travelerInGroup(groupId, String(req.params["tid"]));
    if (!t) return res.status(404).json({ success: false, error: "Traveler not found" });
    const to = String(t.email ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
      return res.status(400).json({ success: false, error: "This traveler has no email address on the file. Add one, or make a link and send it yourself." });
    }
    if (!mailAllowed(to, process.env["GROUP_FORMS_MAIL_ALLOW"])) {
      return res.status(400).json({ success: false, error: "This box only emails its test addresses, so that address was not emailed." });
    }
    const group = await store.group(groupId);
    if (!group) return res.status(404).json({ success: false, error: "Group not found" });
    const { token, hash } = issueToken();
    // The new link is stored first so it works the moment the email arrives; a failed send puts the old one back.
    await store.updateTraveler(t.id, { form_token_hash: hash, form_sent_at: new Date().toISOString() });
    const mail = linkEmail({ firstName: String(t.first_name ?? ""), groupName: String(group.name ?? ""), ship: group.ship_name ?? null, sailDate: group.sail_date ?? null, url: formUrl(publicSite(), token) });
    const ok = await sendMail({ to, subject: mail.subject, html: mail.html, text: mail.text, fromName: BUSINESS.agentName, replyTo: BUSINESS.email });
    // The email log keeps who and when, never the link.
    await db().from("group_messages").insert({
      group_id: groupId, cabin_id: t.cabin_id ?? null, traveler_id: t.id, audience: "client", template: "paperwork-link",
      to_email: to, subject: mail.subject, status: ok ? "sent" : "failed", sent_at: ok ? new Date().toISOString() : null, error: ok ? null : "mail sender refused or was unreachable",
    });
    logger.info({ group: groupId, traveler: t.id, sent: ok }, "paperwork link email to the traveler's own address on the file (sent=false means the mail sender refused it)");
    if (!ok) {
      await store.updateTraveler(t.id, { form_token_hash: t.form_token_hash ?? null, form_sent_at: t.form_sent_at ?? null });
      return res.status(502).json({ success: false, error: "The email did not go out, and the traveler's earlier link still works. Try again, or make a link and send it yourself." });
    }
    return res.json({ success: true, sentTo: to });
  } catch (err) {
    return fail(req, res, err, "paperwork link email failed");
  }
});

router.post("/groups/:id/organizer-link", requireToken, async (req: Request, res: Response) => {
  try {
    const groupId = String(req.params["id"]);
    const group = await store.group(groupId);
    if (!group) return res.status(404).json({ success: false, error: "Group not found" });
    if (!String(group.organizer_name ?? "").trim()) {
      return res.status(400).json({ success: false, error: "Add the organizer's name to the group first: it is printed on the contract." });
    }
    const { token, hash } = issueToken();
    const { error } = await db().from("groups").update({ organizer_token_hash: hash, organizer_link_sent_at: new Date().toISOString() }).eq("id", groupId);
    if (error) throw new Error(error.message);
    const [cabins, travelers] = await Promise.all([store.cabins(groupId), store.travelers(groupId)]);
    return res.status(201).json({
      success: true, url: formUrl(publicSite(), token),
      // lines of the contract the file cannot fill: they print blank, so Mark knows before the organizer signs
      blanks: organizerBlanks(group, cabins, travelers, new Date()),
    });
  } catch (err) {
    return fail(req, res, err, "organizer link failed");
  }
});

router.get("/groups/:id/signatures", requireToken, async (req: Request, res: Response) => {
  try {
    const groupId = String(req.params["id"]);
    const group = await store.group(groupId);
    if (!group) return res.status(404).json({ success: false, error: "Group not found" });
    const { data, error } = await db().from("group_signatures")
      .select("id, group_id, cabin_id, traveler_id, doc_key, doc_version, signer_role, signer_name, signed_at, content_sha256, pdf_path, answers")
      .eq("group_id", groupId).order("signed_at", { ascending: false }).order("id", { ascending: true });
    if (error) throw new Error(error.message);
    const rows: Row[] = data ?? [];
    const [cabins, travelers] = await Promise.all([store.cabins(groupId), store.travelers(groupId)]);
    const names = new Map(travelers.map((t) => [t.id, [t.first_name, t.last_name].filter(Boolean).join(" ")]));
    const status = packetStatuses({ group, cabins, travelers, signatures: rows });
    return res.json({
      success: true,
      // no PDF bytes and no answers: the signed copy holds those. The insurance choice is the one answer Mark acts on.
      signatures: rows.map((s) => ({
        id: s.id, doc_key: s.doc_key, doc_title: DOC_SPECS[s.doc_key]?.title ?? s.doc_key, doc_version: s.doc_version,
        signer_role: s.signer_role, signer_name: s.signer_name, traveler_id: s.traveler_id ?? null, traveler_name: names.get(s.traveler_id) ?? null,
        cabin_id: s.cabin_id ?? null, signed_at: s.signed_at, content_sha256: s.content_sha256, has_pdf: !!s.pdf_path,
        choice: s.doc_key === "07-travel-insurance-declination" ? (s.answers?.insurance_choice ?? null) : null,
      })),
      packets: status.travelers,
      organizer: { ...status.organizer, link_sent_at: group.organizer_link_sent_at ?? null },
    });
  } catch (err) {
    return fail(req, res, err, "signatures list failed");
  }
});

router.get("/groups/:id/signatures/:sid/file", requireToken, async (req: Request, res: Response) => {
  try {
    const { data, error } = await db().from("group_signatures").select("pdf_path").eq("id", String(req.params["sid"])).eq("group_id", String(req.params["id"])).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ success: false, error: "Signature not found" });
    if (!data.pdf_path) return res.status(404).json({ success: false, error: "The signature is recorded, but its PDF copy could not be saved. The record (name, time and document hash) is intact." });
    const { data: signed, error: se } = await db().storage.from(BUCKET).createSignedUrl(data.pdf_path, 600);
    if (se || !signed) throw new Error(se?.message ?? "could not sign");
    return res.json({ success: true, url: signed.signedUrl, expiresIn: 600 });
  } catch (err) {
    return fail(req, res, err, "signed copy link failed");
  }
});

router.delete("/groups/:id/signatures/:sid", requireToken, async (req: Request, res: Response) => {
  try {
    const groupId = String(req.params["id"]);
    const { data: sig, error } = await db().from("group_signatures").select("id, traveler_id, doc_key, pdf_path").eq("id", String(req.params["sid"])).eq("group_id", groupId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!sig) return res.status(404).json({ success: false, error: "Signature not found" });
    if (sig.pdf_path) await db().storage.from(BUCKET).remove([sig.pdf_path]).catch(() => undefined);
    await store.deleteSignature(sig.id);
    // The packet is no longer complete, so the traveler is asked for this document again.
    if (sig.traveler_id) {
      const patch: Row = { form_submitted_at: null };
      if (sig.doc_key === "01-terms-and-conditions") Object.assign(patch, { consent_name: null, consent_signed_at: null, consent_ip_hash: null });
      await store.updateTraveler(sig.traveler_id, patch);
    }
    return res.json({ success: true });
  } catch (err) {
    return fail(req, res, err, "signature removal failed");
  }
});

export default router;
