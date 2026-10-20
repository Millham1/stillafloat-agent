// group-forms.ts — the client-paperwork flow, with its I/O injected so every rule is unit-tested
// (routes/group-forms.ts wires it to Supabase, the mailer and the notifier).
//
// A traveler (or the group's organizer) opens a private link, sees the documents their role calls for,
// and signs each one with a typed full name, an explicit "I agree" and a server timestamp.
//
// THE RULES THIS FILE ENFORCES (Mark 2026-10-02/03):
//   * the link is the only credential: a random 43-character token, only its sha256 is stored; an
//     unknown or malformed token gets one neutral 404 whatever the reason;
//   * a signature pins the TEXT the signer saw: the page sends the sha256 it was given, the server
//     re-renders from the file and refuses (409) when it no longer matches;
//   * one signature per traveler, document and role; a second attempt is a 409, never a second row;
//   * passport numbers: entered only here, encrypted (GROUP_PII_KEY, fails closed with a plain
//     message), never stored in the signature's answers and never returned by any API;
//   * ip and user agent are kept only as salted hashes;
//   * the traveler's file changes only after the signature row is saved, and a failed save removes
//     the signature again, so a signature without its data (or data without its signature) cannot stay;
//   * no email goes out from the sign path; the newsletter box only records the choice and a prospect.

import {
  BUSINESS, encryptPii, hashForAudit, hashLinkToken, looksLikeLinkToken, newLinkToken, piiConfigured, safeEqualHex,
} from "./group-secure";
import {
  DOC_SPECS, applyAnswers, buildCtx, fillBlocks, packetFor, publicField, renderDocument,
  type Answers, type DocCtx, type RenderedDoc, type Row,
} from "./group-documents";
import type { SignedCopyInput } from "./group-signature-pdf";
import { fmtLong } from "./group-document-kit";
import { displayName } from "./group-marketing";

export type Reply = { status: number; json: Record<string, unknown> };
const reply = (status: number, json: Record<string, unknown>): Reply => ({ status, json });
const NOT_FOUND = reply(404, { success: false, error: "This link is not valid. Please check that you opened the whole link from your email, or ask for a new one." });

// ── What the flow needs from the outside ──────────────────────────────────────

export interface FormsStore {
  travelerByTokenHash(hash: string): Promise<Row | null>;
  groupByOrganizerHash(hash: string): Promise<Row | null>;
  group(id: string): Promise<Row | null>;
  cabins(groupId: string): Promise<Row[]>;
  travelers(groupId: string): Promise<Row[]>;
  /** The signatures one signer has made: a traveler's own, or the organizer's for the group. */
  signaturesFor(who: { groupId: string; travelerId: string | null }): Promise<Row[]>;
  insertSignature(row: Row): Promise<{ id: string } | "duplicate">;
  deleteSignature(id: string): Promise<void>;
  updateTraveler(id: string, patch: Row): Promise<void>;
  uploadPdf(path: string, bytes: Buffer): Promise<void>;
  setSignaturePdf(id: string, path: string): Promise<void>;
  /** Find a prospect by email or add one; returns its id (null when the website's contact list refused it). */
  upsertProspect(row: Row): Promise<string | null>;
}

export interface FormsDeps {
  store: FormsStore;
  now: () => Date;
  /** GROUP_PII_KEY; undefined or malformed means no passport number is taken. */
  piiKey: string | undefined;
  renderPdf: (input: SignedCopyInput) => Promise<Buffer>;
  logo: Buffer | null;
  /** Tell Mark a packet is complete (one notification per traveler, on the last signature). */
  notify: (n: { title: string; body: string; groupId: string }) => Promise<void>;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

// ── Loading a link ────────────────────────────────────────────────────────────

/** The traveler columns any private page may read. Never passport_enc, form_token_hash, hub_token_hash or consent_ip_hash. */
export const TRAVELER_COLS =
  "id, group_id, cabin_id, is_lead, first_name, middle_name, last_name, dob, gender, citizenship, email, phone, lang, " +
  "passport_last4, passport_country, passport_expiry, emergency_name, emergency_phone, special_needs, form_data, " +
  "newsletter_opt_in, prospect_id, form_sent_at, form_submitted_at, consent_name, consent_signed_at";

export interface Loaded {
  kind: "traveler" | "organizer";
  group: Row;
  traveler: Row | null;
  cabin: Row | null;
  mates: Row[];
  ctx: DocCtx;
  packet: string[];
  /** doc_key → the signature row */
  signed: Map<string, Row>;
}

/** Look a link up. null for every kind of failure: malformed, unknown, replaced, or a group that was cancelled. */
export async function loadByToken(deps: Pick<FormsDeps, "store" | "now">, token: unknown): Promise<Loaded | null> {
  if (!looksLikeLinkToken(token)) return null;
  const hash = hashLinkToken(token);
  const { store } = deps;
  const traveler = await store.travelerByTokenHash(hash);
  const now = deps.now();
  if (traveler) {
    const group = await store.group(traveler.group_id);
    if (!group || group.status === "cancelled") return null;
    const [cabins, travelers] = await Promise.all([store.cabins(group.id), store.travelers(group.id)]);
    const ctx = buildCtx({ business: BUSINESS, group, cabins, travelers, traveler, now });
    const packet = packetFor({ group, cabin: ctx.cabin, traveler });
    const sigs = await store.signaturesFor({ groupId: group.id, travelerId: traveler.id });
    return { kind: "traveler", group, traveler, cabin: ctx.cabin, mates: ctx.mates, ctx, packet, signed: new Map(sigs.map((s) => [s.doc_key as string, s])) };
  }
  const group = await store.groupByOrganizerHash(hash);
  if (!group || group.status === "cancelled") return null;
  const [cabins, travelers] = await Promise.all([store.cabins(group.id), store.travelers(group.id)]);
  const ctx = buildCtx({ business: BUSINESS, group, cabins, travelers, traveler: null, now });
  const packet = packetFor({ group, organizer: true });
  const sigs = await store.signaturesFor({ groupId: group.id, travelerId: null });
  return { kind: "organizer", group, traveler: null, cabin: null, mates: [], ctx, packet, signed: new Map(sigs.map((s) => [s.doc_key as string, s])) };
}

const personName = (t: Row | null) => [t?.first_name, t?.middle_name, t?.last_name].filter(Boolean).join(" ");

/** What the page may see: the safe columns of the signer, the group's headline facts, the cabin's other
 * travelers by name, and each document (its page, the hash to send back, its inputs). Never a passport
 * number, a token, an audit hash or another traveler's details. */
export function publicPacket(loaded: Loaded, deps: Pick<FormsDeps, "piiKey">): Record<string, unknown> {
  const { group, traveler, ctx } = loaded;
  const docs = loaded.packet.map((key) => {
    const sig = loaded.signed.get(key);
    const d: RenderedDoc = renderDocument(key, ctx);
    return {
      key, title: d.title, status: sig ? "signed" : "pending",
      signed_at: sig?.signed_at ?? null,
      html: d.html,
      text_sha256: d.sha256,
      fields: sig ? [] : d.fields.map((f) => publicField(f, ctx)),
      agent_countersign_pending: !!DOC_SPECS[key]?.agentCountersign,
    };
  });
  return {
    success: true,
    kind: loaded.kind,
    business: { name: BUSINESS.legalName, trade_name: BUSINESS.tradeName, email: BUSINESS.email, phone: BUSINESS.phone, contact: BUSINESS.contactLine },
    traveler: traveler
      ? { first_name: traveler.first_name ?? null, last_name: traveler.last_name ?? null, is_lead: !!traveler.is_lead, passport_on_file: traveler.passport_last4 ? `ending ${traveler.passport_last4}` : null, newsletter_opt_in: !!traveler.newsletter_opt_in }
      : { first_name: group.organizer_name ?? null, last_name: null, is_lead: false, passport_on_file: null, newsletter_opt_in: false },
    group: {
      name: group.name ?? null, cruise_line: displayName(group.cruise_line) || null, ship_name: displayName(group.ship_name) || null,
      sail_date_text: fmtLong(group.sail_date) || null, return_date_text: fmtLong(group.return_date) || null,
      nights: group.nights ?? null, embark_port: group.embark_port ?? null,
    },
    cabin: loaded.cabin ? { cabin_num: loaded.cabin.cabin_num ?? null, category: loaded.cabin.category ?? null } : null,
    mates: loaded.mates.map(personName).filter(Boolean),
    docs,
    complete: loaded.packet.length > 0 && loaded.packet.every((k) => loaded.signed.has(k)),
    pii_ready: piiConfigured(deps.piiKey),
  };
}

export async function getPacket(deps: FormsDeps, token: unknown): Promise<Reply> {
  const loaded = await loadByToken(deps, token);
  if (!loaded) return NOT_FOUND;
  return reply(200, publicPacket(loaded, deps));
}

// ── Signing ───────────────────────────────────────────────────────────────────

export interface SignBody {
  doc_key?: unknown;
  signer_name?: unknown;
  agreed?: unknown;
  content_sha256?: unknown;
  answers?: unknown;
  newsletter_opt_in?: unknown;
}

const CHANGED = reply(409, { success: false, code: "document-changed", error: "This document changed while you had it open. Please reload the page and read it again before signing." });

function deepMerge(base: unknown, patch: Row): Row {
  const out: Row = base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Row) } : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v as Row) : v;
  }
  return out;
}

const SIGNER_NAME = /^[\p{L}\p{M}][\p{L}\p{M}'’.\- ]{1,118}[\p{L}\p{M}.]$/u;

export async function signDocument(deps: FormsDeps, token: unknown, body: SignBody, meta: { ip?: string; ua?: string }): Promise<Reply> {
  const loaded = await loadByToken(deps, token);
  if (!loaded) return NOT_FOUND;
  const docKey = typeof body.doc_key === "string" ? body.doc_key : "";
  if (!loaded.packet.includes(docKey)) return reply(404, { success: false, error: "That document is not part of this paperwork." });
  if (loaded.signed.has(docKey)) return reply(409, { success: false, code: "already-signed", error: "This document is already signed. Thank you." });
  if (body.agreed !== true) return reply(400, { success: false, error: "Please tick the box to say you agree, then sign." });
  const signerName = typeof body.signer_name === "string" ? body.signer_name.replace(/\s+/g, " ").trim() : "";
  if (!SIGNER_NAME.test(signerName) || signerName.split(" ").length < 2) {
    return reply(400, { success: false, error: "Please type your full name (first and last) as your signature." });
  }
  const sha = typeof body.content_sha256 === "string" ? body.content_sha256 : "";
  if (!/^[0-9a-f]{64}$/.test(sha)) return reply(400, { success: false, error: "Please reload the page and try again." });

  const doc = renderDocument(docKey, loaded.ctx);
  if (!safeEqualHex(doc.sha256, sha)) return CHANGED;

  const applied = applyAnswers(doc, body.answers, loaded.ctx);
  if (!applied.ok) return reply(400, { success: false, error: "Please check the answers marked below.", fields: applied.errors });
  // FAIL CLOSED: no key, no passport number — never a plaintext fallback.
  if (applied.passport && !piiConfigured(deps.piiKey)) {
    return reply(503, {
      success: false, code: "passport-unavailable",
      error: "We cannot take a passport number on this page right now. Please leave that line empty and sign; we will collect it another way.",
      fields: { passport_number: "Not available right now. Leave this empty." },
    });
  }

  const now = deps.now();
  const spec = DOC_SPECS[docKey]!;
  const traveler = loaded.traveler;
  const ipHash = hashForAudit(meta.ip);
  const stored: Answers = { ...applied.answers, _agreed: true };
  const saved = await deps.store.insertSignature({
    group_id: loaded.group.id,
    cabin_id: traveler?.cabin_id ?? null,
    traveler_id: traveler?.id ?? null,
    doc_key: docKey,
    doc_version: doc.version,
    lang: loaded.ctx.lang,
    signer_role: spec.signerRole,
    signer_name: signerName,
    signed_at: now.toISOString(),
    ip_hash: ipHash,
    ua_hash: hashForAudit(meta.ua),
    answers: stored,
    content_sha256: doc.sha256,
  });
  if (saved === "duplicate") return reply(409, { success: false, code: "already-signed", error: "This document is already signed. Thank you." });

  // The traveler's file: only now that the signature is safely saved.
  const signedKeys = new Set([...loaded.signed.keys(), docKey]);
  const complete = loaded.packet.every((k) => signedKeys.has(k));
  let newsletterProspect: string | null = null;
  if (traveler) {
    try {
      const patch: Row = { ...applied.travelerPatch, updated_at: now.toISOString() };
      if (Object.keys(applied.formData).length) patch["form_data"] = deepMerge(traveler.form_data, applied.formData);
      if (applied.passport) patch["passport_enc"] = encryptPii(applied.passport.number, deps.piiKey);
      if (docKey === "01-terms-and-conditions") Object.assign(patch, { consent_name: signerName, consent_signed_at: now.toISOString(), consent_ip_hash: ipHash });
      if (complete) patch["form_submitted_at"] = now.toISOString();
      const email = String(patch["email"] ?? traveler.email ?? "").trim().toLowerCase();
      if (body.newsletter_opt_in === true && !traveler.newsletter_opt_in && email) {
        newsletterProspect = await deps.store.upsertProspect({
          first_name: String(patch["first_name"] ?? traveler.first_name ?? "").trim() || signerName.split(" ")[0],
          last_name: String(patch["last_name"] ?? traveler.last_name ?? "").trim(),
          email, phone: String(patch["phone"] ?? traveler.phone ?? "").trim() || null,
          destination: `${loaded.group.ship_name ?? "Group cruise"} — ${loaded.group.name}`,
          preferred_lang: traveler.lang === "es" ? "es" : "en",
          cruise_line_pref: loaded.group.cruise_line ?? null,
          referral_source: "group-paperwork",
          notes: `Group: ${loaded.group.name}. Ticked the newsletter box on the paperwork form.`,
          status: "new",
        });
        patch["newsletter_opt_in"] = true;
        if (newsletterProspect) patch["prospect_id"] = newsletterProspect;
      }
      await deps.store.updateTraveler(traveler.id, patch);
    } catch (err) {
      await deps.store.deleteSignature(saved.id).catch(() => undefined);
      deps.warn({ err: err instanceof Error ? err.message : String(err), group: loaded.group.id }, "paperwork: saving the traveler's answers failed; the signature was removed");
      return reply(500, { success: false, error: "Something went wrong on our side and nothing was saved. Please try again in a minute." });
    }
  }

  // The signed copy. A failure here never undoes a valid signature: the hash and answers are stored.
  let pdfSaved = true;
  try {
    const pdf = await deps.renderPdf({
      businessName: BUSINESS.legalName, title: doc.title, blocks: fillBlocks(doc, stored, now),
      signerName, signerRole: spec.signerRole, signedAt: now, docVersion: doc.version, contentSha256: doc.sha256,
      signatureId: saved.id, agentCountersignPending: !!spec.agentCountersign, logo: deps.logo,
    });
    const path = `signatures/${loaded.group.id}/${saved.id}.pdf`;
    await deps.store.uploadPdf(path, pdf);
    await deps.store.setSignaturePdf(saved.id, path);
  } catch (err) {
    pdfSaved = false;
    deps.warn({ err: err instanceof Error ? err.message : String(err), signature: saved.id }, "paperwork: the signed copy could not be saved (the signature itself is recorded)");
  }

  if (complete) {
    // One notice per signer, on the last signature. The organizer's contract also waits for Mark's countersignature.
    void deps.notify(traveler
      ? { title: `Paperwork returned: ${personName(traveler) || signerName}`, body: `${loaded.group.name} — all ${loaded.packet.length} documents signed.`, groupId: loaded.group.id }
      : { title: `Group contract signed: ${signerName}`, body: `${loaded.group.name} — the organizer signed. Your countersignature is still to do.`, groupId: loaded.group.id },
    ).catch((err: unknown) => deps.warn({ err: err instanceof Error ? err.message : String(err) }, "paperwork: the completion notice failed"));
  }

  // The refreshed packet: the documents after this one may now show what was just entered (and so carry a new hash).
  const again = await loadByToken(deps, token);
  return reply(200, {
    success: true, signed: docKey, complete, pdf_saved: pdfSaved,
    ...(again ? { packet: publicPacket(again, deps) } : {}),
  });
}

// ── Dashboard side: links ─────────────────────────────────────────────────────

export function formUrl(publicSite: string, token: string): string {
  return `${publicSite.replace(/\/$/, "")}/forms.html?t=${token}`;
}

/** A new token for a traveler. The old link stops working the moment this is stored. */
export function issueToken(): { token: string; hash: string } {
  const token = newLinkToken();
  return { token, hash: hashLinkToken(token) };
}

/** The plain, short email that carries a traveler's link. The business signature is the legal name. */
export function linkEmail(input: { firstName: string; groupName: string; ship: string | null; sailDate: string | null; url: string }): { subject: string; text: string; html: string } {
  const when = fmtLong(input.sailDate);
  const trip = [input.groupName, [displayName(input.ship), when ? `sailing ${when}` : ""].filter(Boolean).join(", ")].filter(Boolean).join(" — ");
  const hello = input.firstName ? `Hello ${input.firstName},` : "Hello,";
  const lines = [
    hello,
    `Please complete your travel paperwork for ${trip} using your private link:`,
    input.url,
    "It takes about ten minutes, and it helps to have your passport handy. The link is only for you, so please do not forward it.",
    `Questions? Reply to this email or call ${BUSINESS.phone}.`,
  ];
  const sign = [BUSINESS.agentName, BUSINESS.legalName, BUSINESS.contactLine.split(" · ").slice(1).join(" · ")];
  const text = `${lines.join("\n\n")}\n\n${sign.join("\n")}\n`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#07183f">${lines
    .map((l) => (l === input.url ? `<p><a href="${esc(l)}">${esc(l)}</a></p>` : `<p>${esc(l)}</p>`)).join("")}<p>${sign.map(esc).join("<br>")}</p></div>`;
  return { subject: `Your travel paperwork for ${input.groupName}`, text, html };
}

/** The dev box emails only the addresses it is told are test addresses (Mark 2026-10-08). */
export function mailAllowed(to: string, allow: string | undefined): boolean {
  if (!allow || !allow.trim()) return true; // prod: any traveler's own address on the file
  const list = allow.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const addr = to.trim().toLowerCase();
  return list.some((x) => (x.startsWith("@") ? addr.endsWith(x) : addr === x));
}

// ── Dashboard side: who has signed what ───────────────────────────────────────

export interface PacketStatus { required: string[]; signed: string[]; complete: boolean }

/** For each traveler (and the organizer), the documents asked for and the ones signed. */
export function packetStatuses(input: { group: Row; cabins: Row[]; travelers: Row[]; signatures: Row[] }): { travelers: Record<string, PacketStatus>; organizer: PacketStatus } {
  const out: Record<string, PacketStatus> = {};
  for (const t of input.travelers) {
    const cabin = input.cabins.find((c) => c.id === t.cabin_id) ?? null;
    const required = packetFor({ group: input.group, cabin, traveler: t });
    const signed = required.filter((k) => input.signatures.some((s) => s.traveler_id === t.id && s.doc_key === k));
    out[t.id] = { required, signed, complete: required.length > 0 && signed.length === required.length };
  }
  const required = packetFor({ group: input.group, organizer: true });
  const signed = required.filter((k) => input.signatures.some((s) => !s.traveler_id && s.signer_role === "organizer" && s.doc_key === k));
  return { travelers: out, organizer: { required, signed, complete: signed.length === required.length } };
}

/** The blanks in the organizer's contract the file cannot fill (what Mark should know before he sends the link). */
export function organizerBlanks(group: Row, cabins: Row[], travelers: Row[], now: Date): string[] {
  const ctx = buildCtx({ business: BUSINESS, group, cabins, travelers, traveler: null, now });
  return renderDocument("09-group-travel-contract", ctx).unfilled;
}

